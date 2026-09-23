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
  const env = { APP_DB: db } as Env;

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
  const env = { APP_DB: db } as Env;

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
