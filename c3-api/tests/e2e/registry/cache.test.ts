import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';

import type { CacheDeps } from '../../../src/registry/cache.js';
import { POINTER_KEY, activeSnapshot, snapshotKey, warmSnapshot } from '../../../src/registry/cache.js';
import { markValidated, recordValidationResults, snapshotChecksum } from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * The snapshot cache against real local D1 and KV.
 *
 * What is tested here is the division of work: a request verifies the pointer
 * in D1 and reads everything else from KV, a version's bytes are written once
 * and never rewritten, and when D1 does not answer at all the last version it
 * named is served — but only within the configured window, and never in place
 * of a D1 that answered "nothing is active".
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();

const TTL   = 300;
const STALE = 3600;

async function freshEnvironment(): Promise<{ db: D1Database, kv: KVNamespace }> {
  await server.reset();
  const { APP_DB, kv_registry } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return { db: APP_DB, kv: kv_registry };
}

async function validate(db: D1Database, versionId: string): Promise<void> {
  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, await snapshotChecksum(snapshot.networks));
}

async function activate(db: D1Database, versionId: string): Promise<void> {
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

/*
 * A binding that records the statements it was asked to prepare, so a test
 * can say what a request read rather than how long it took.
 */
function counting(db: D1Database): { db: D1Database, statements: string[] } {
  const statements: string[] = [];
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'prepare' && typeof(value) === 'function') {
        return (query: string) => {
          statements.push(query);
          return (value as (query: string) => D1PreparedStatement).call(target, query);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
  return { db: proxy as D1Database, statements };
}

// D1 that cannot be reached at all, which is what the fallback exists for
function unreachable(): D1Database {
  return {
    prepare() { throw new Error(`D1_ERROR: network connection lost`); },
    batch()   { throw new Error(`D1_ERROR: network connection lost`); },
  } as unknown as D1Database;
}

function depsOf(db: D1Database, kv: KVNamespace, now?: () => Date): CacheDeps {
  return { db, kv, ttlSeconds: TTL, staleSeconds: STALE, ...(now === undefined ? {} : { now }) };
}

t.test('a version is hydrated once, then read from the cache', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);

  const cold = counting(db);
  const first = await activeSnapshot(depsOf(cold.db, kv));
  t.equal(first?.source, 'origin', 'the first read hydrates the version out of D1');
  t.equal(first?.snapshot.registryVersion.id, versionId);
  t.ok(cold.statements.length > 1, 'which is more than one statement');

  const checksum = first!.snapshot.registryVersion.checksum;
  t.ok(await kv.get(snapshotKey({ id: versionId, checksum })) !== null, 'the bytes are cached under version and checksum');
  t.ok(await kv.get(POINTER_KEY) !== null, 'and the pointer that named them is remembered');

  const warm   = counting(db);
  const second = await activeSnapshot(depsOf(warm.db, kv));
  t.equal(second?.source, 'cache', 'the next read is served from the cache');
  t.same(second?.snapshot, first?.snapshot, 'with the same snapshot');
  t.equal(warm.statements.length, 1, 'having read D1 once, for the pointer alone');
  t.match(warm.statements[0], /registry_state/, 'which is the pointer statement');
});

t.test('the bytes of a version are written once', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);

  let puts = 0;
  const counted = new Proxy(kv, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'put' && typeof(value) === 'function') {
        return (...parameters: unknown[]) => {
          puts += 1;
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;

  await activeSnapshot(depsOf(db, counted));
  const afterFirst = puts;
  t.equal(afterFirst, 2, 'the first read writes the snapshot and the pointer');

  for (let read = 0; read < 3; read++) {
    await activeSnapshot(depsOf(db, counted));
  }
  t.equal(puts, afterFirst, 'and later reads write nothing: the version is immutable and the pointer has not moved');
});

t.test('a version that is not active yet can be warmed', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validate(db, versionId);

  const warmed = await warmSnapshot(depsOf(db, kv), versionId);
  t.equal(warmed?.id, versionId, 'the validated candidate is serialized');
  t.ok(await kv.get(snapshotKey(warmed!)) !== null, 'and cached');
  t.equal(await kv.get(POINTER_KEY), null, 'without becoming what an outage would fall back to');

  await activate(db, versionId);
  const first = counting(db);
  const served = await activeSnapshot(depsOf(first.db, kv));
  t.equal(served?.source, 'cache', 'so the first request after the activation pays the pointer read only');
  t.equal(first.statements.length, 1);
});

t.test('when D1 does not answer, the last version it named is served, and says how old it is', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);

  const activatedAt = Date.parse('2026-09-23T12:00:00.000Z');
  await activeSnapshot(depsOf(db, kv, () => new Date(activatedAt)));

  const within = await activeSnapshot(depsOf(unreachable(), kv, () => new Date(activatedAt + 600_000)));
  t.equal(within?.source, 'stale', 'the cached version answers while D1 is unreachable');
  t.equal(within?.snapshot.registryVersion.id, versionId, 'it is the version D1 last named');
  t.equal(within?.staleFor, 600, 'and the answer says how many seconds old it is');

  await t.rejects(
    activeSnapshot(depsOf(unreachable(), kv, () => new Date(activatedAt + (STALE + 60) * 1000))),
    /D1_ERROR/,
    'past the window there is no answer to give, and the failure is the D1 one',
  );

  await t.rejects(
    activeSnapshot({ ...depsOf(unreachable(), kv, () => new Date(activatedAt + 600_000)), staleSeconds: 0 }),
    /D1_ERROR/,
    'an environment that configures no window would rather fail than serve an older version',
  );
});

t.test('a registry with nothing active is an answer, not an outage', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);
  const cached = await activeSnapshot(depsOf(db, kv));
  const pointer = cached!.snapshot.registryVersion;
  const bytes   = JSON.stringify(cached!.snapshot);

  /*
   * A database with no activation, and a cache that could answer for one:
   * the reset clears both stores, so the cache is written again by hand —
   * otherwise this would assert nothing.
   */
  const empty = await freshEnvironment();
  await empty.kv.put(snapshotKey(pointer), bytes, { expirationTtl: 3600, metadata: { at: Date.now() } });
  await empty.kv.put(POINTER_KEY, JSON.stringify({ ...pointer, at: new Date().toISOString() }), { expirationTtl: 3600 });
  t.ok((await empty.kv.list()).keys.length >= 2, 'the cache holds a version and the pointer that named it');

  t.equal(await activeSnapshot(depsOf(empty.db, empty.kv)), null,
    'a D1 that says no version is active is believed, even with a cache that could answer');
});

t.test('the public read is served through the cache', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);

  const response = await server.fetch('/registry/v1/active');
  t.equal(response.status, 200);
  t.equal(response.headers.get('x-registry-version'), versionId);
  t.equal(response.headers.get('x-registry-stale'), null, 'a verified answer is not stale');
  t.match(response.headers.get('cache-control') ?? '', /max-age=\d+/);

  const keys = (await kv.list()).keys.map(key => key.name);
  t.ok(keys.some(name => name.startsWith('snapshot:v1:')), 'the worker cached the snapshot it served');
  t.ok(keys.includes(POINTER_KEY), 'and the pointer it verified');
});

/*
 * A cache entry is trusted for what it is, not only for what it claims to
 * be: an entry that names the right version but is not a snapshot would be
 * read by every isolate and fail in the catalog, on every request, until it
 * expired.
 */
t.test('an entry that is not a snapshot is a miss, and is discarded', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);

  const first = await activeSnapshot(depsOf(db, kv));
  const pointer = first!.snapshot.registryVersion;

  await kv.put(snapshotKey(pointer), JSON.stringify({ registryVersion: pointer }), { expirationTtl: 300 });

  const answered = await activeSnapshot(depsOf(db, kv));
  t.equal(answered?.source, 'origin', 'the registry is read from D1 instead');
  t.same(answered?.snapshot, first?.snapshot, 'and the answer is the version itself');

  const rewritten = await kv.get(snapshotKey(pointer), 'json') as { networks?: unknown[] } | null;
  t.ok(Array.isArray(rewritten?.networks), 'the entry that could not be used is replaced by one that can');
});

t.test('the version headers are readable by a browser', async t => {
  const { db } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);

  const response = await server.fetch('/registry/v1/active');
  const exposed  = response.headers.get('access-control-expose-headers') ?? '';
  for (const header of [ 'X-Registry-Version', 'X-Registry-Checksum', 'X-Registry-Stale' ]) {
    t.match(exposed, header, `${header} is exposed to a cross-origin client`);
  }
});

/*
 * The fallback is for a database that could not be reached. A database that
 * answered — with a table that does not exist, because a release went out
 * ahead of its migration — must not be papered over with an hour of older
 * data: that is the one failure an operator has to see.
 */
t.test('a database that answers with a fault is not masked by the cache', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);
  await activeSnapshot(depsOf(db, kv));

  const faulty = {
    prepare() { throw new Error(`D1_ERROR: no such column: version.snapshot_digest`); },
    batch()   { throw new Error(`D1_ERROR: no such column: version.snapshot_digest`); },
  } as unknown as D1Database;

  await t.rejects(
    activeSnapshot(depsOf(faulty, kv)),
    /no such column/,
    'the fault is raised, with what the database actually said',
  );

  const unreachable = {
    prepare() { throw new Error(`D1_ERROR: network connection lost`); },
    batch()   { throw new Error(`D1_ERROR: network connection lost`); },
  } as unknown as D1Database;
  t.equal((await activeSnapshot(depsOf(unreachable, kv)))?.source, 'stale',
    'while a database that could not be reached is what the fallback is for');
});

/*
 * A version that stays active outlives one expiry of its own bytes, so the
 * request that reads an ageing entry writes it again — otherwise the
 * fallback's pointer would name bytes that had expired underneath it.
 */
t.test('the bytes of a version that is being served do not expire under it', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);

  const start = Date.parse('2026-09-23T12:00:00.000Z');
  await activeSnapshot(depsOf(db, kv, () => new Date(start)));
  const pointer = (await activeSnapshot(depsOf(db, kv, () => new Date(start))))!.snapshot.registryVersion;
  const written = async () => ((await kv.getWithMetadata(snapshotKey(pointer), 'json')).metadata as { at: number } | null)?.at ?? 0;
  t.equal(await written(), start, 'the entry remembers when it was written');

  // half the lifetime later, a read leaves it alone
  await activeSnapshot(depsOf(db, kv, () => new Date(start + TTL * 1000 / 4)));
  t.equal(await written(), start, 'a young entry is not rewritten');

  const late = start + STALE * 1000 * 0.75;
  t.equal((await activeSnapshot(depsOf(db, kv, () => new Date(late))))?.source, 'cache',
    'an ageing entry still answers');
  t.equal(await written(), late, 'and is written again, so it outlives the window that names it');
});
