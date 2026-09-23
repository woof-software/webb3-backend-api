import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';

import { markValidated, recordValidationResults, snapshotChecksum } from '../../../src/registry/repository.js';
import { requestCatalog } from '../../../src/registry/request-catalog.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * What a request pays for the registry, against real local D1.
 *
 * An activated version is frozen, so every request of an isolate can be
 * served from the catalog the first one built: only the pointer to the active
 * version can move, and that is the one read a request cannot skip.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

/*
 * The environment a request reads the registry through: the same D1 and KV
 * bindings the worker holds, and the cache settings it is configured with.
 */
async function environmentOf(db: D1Database): Promise<Env> {
  const { kv_registry } = await server.getWorker<Env>().getEnv();
  return {
    APP_DB:                        db,
    kv_registry,
    REGISTRY_SNAPSHOT_CACHE_TTL_S: '300',
    REGISTRY_STALE_FALLBACK_MAX_S: '3600',
  } as Env;
}

async function activate(db: D1Database, versionId: string): Promise<void> {
  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, await snapshotChecksum(snapshot.networks));
  await db.batch([
    db.prepare(
      `INSERT INTO registry_activations (id, registry_version_id, previous_version_id, action, actor, reason, created_at)
       SELECT ?1, ?2, active_version_id, 'activate', 'test-admin', 'test', ?3 FROM registry_state
       WHERE singleton_id = 1 AND active_version_id IS NOT ?2`
    ).bind(randomUUID(), versionId, new Date().toISOString()),
    db.prepare(`UPDATE registry_state SET active_version_id = ?1, updated_at = ?2 WHERE singleton_id = 1`)
      .bind(versionId, new Date().toISOString()),
  ]);
}

t.test('the active version is built once and reused, until another one is activated', async t => {
  const db  = await freshDatabase();
  const env = await environmentOf(db);

  await t.rejects(requestCatalog(env).load(), { name: 'RegistryUnavailable' }, 'with nothing active there is nothing to serve');

  const { versionId } = await seedCandidate(db, snapshot);
  await activate(db, versionId);

  const first  = await requestCatalog(env).load();
  const second = await requestCatalog(env).load();
  t.equal(second, first, 'a later request of the same isolate is served the catalog the first one built');
  t.equal(second.versionId, versionId);

  const next = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await activate(db, next.versionId);

  const activated = await requestCatalog(env).load();
  t.not(activated, first, 'activating another version builds the catalog again');
  t.equal(activated.versionId, next.versionId, 'and the request is served the version that is on');
});

t.test('one request resolves everything from the version it loaded', async t => {
  const db  = await freshDatabase();
  const env = await environmentOf(db);

  const { versionId } = await seedCandidate(db, snapshot);
  await activate(db, versionId);

  const request = requestCatalog(env);
  t.equal(request.loaded(), null, 'a route that needs no registry loads none');

  const [ loaded, again ] = await Promise.all([ request.load(), request.load() ]);
  t.equal(again, loaded, 'two computations of one response read one catalog');
  t.equal(request.loaded(), loaded, 'which the response headers then name');

  const next = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await activate(db, next.versionId);
  t.equal(await request.load(), loaded, 'a version activated mid-request does not change what it answers with');
});

/*
 * The consumer path has the same fallback the registry's own reads have: a
 * market route keeps answering from the version D1 last named, and the
 * response says how old that version is.
 */
t.test('a request that cannot reach D1 is served the last version it named', async t => {
  const db  = await freshDatabase();
  const env = await environmentOf(db);

  const { versionId } = await seedCandidate(db, snapshot);
  await activate(db, versionId);

  /*
   * One binding that stops answering, rather than a second one: an isolate
   * holds what it built per database binding, so replacing the binding would
   * measure a different isolate than the one the outage happens to.
   */
  let reachable = true;
  const flaky = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === 'prepare' || property === 'batch') && typeof(value) === 'function') {
        return (...parameters: unknown[]) => {
          if (!reachable) {
            throw new Error(`D1_ERROR: network connection lost`);
          }
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as D1Database;

  const flakyEnv = { ...env, APP_DB: flaky } as Env;
  const loaded   = await requestCatalog(flakyEnv).load();
  t.equal(loaded.versionId, versionId);

  reachable = false;
  const request = requestCatalog(flakyEnv);
  const catalog = await request.load();
  t.equal(catalog.versionId, versionId, 'the version the cache holds answers the request');
  t.type(request.staleFor(), 'number', 'and the request knows the answer is an older one');
  t.equal(catalog, loaded,
    'the catalog this isolate already holds is reused: an outage is when rebuilding it is least affordable');

  const closed = requestCatalog({ ...flakyEnv, REGISTRY_STALE_FALLBACK_MAX_S: '0' } as Env);
  await t.rejects(closed.load(), { name: 'RegistryUnavailable' },
    'with no window configured the route fails rather than answering from the cache');
});
