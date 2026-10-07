import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';

import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import type { CacheDeps, CachedSnapshot } from '../../../src/registry/cache.js';
import {
  POINTER_KEY,
  activeSnapshot,
  pruneSnapshots,
  snapshotKey,
  versionSnapshot,
  warmSnapshot,
} from '../../../src/registry/cache.js';
import { CHECK_KEY } from '../../../src/registry/drift.js';
import { activateVersion, markValidated, recordValidationResults, snapshotChecksum } from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * The snapshot cache against real local D1 and KV.
 *
 * What is tested here is the division of work: a request verifies the pointer
 * in D1 and reads everything else from the isolate's memory or from KV, a
 * version's bytes are written once and only ever trusted when they are that
 * version, and when D1 does not answer at all the last version it named is
 * served — but only within the configured window, and never in place of a D1
 * that answered "nothing is active".
 *
 * An isolate keeps what it read per database binding, so a test that wants a
 * fresh isolate reads through a binding it has not used before.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();

/*
 * The settings these tests give the cache, passed to it directly rather than
 * read from wrangler.toml: an environment may switch the fallback off, and
 * what is tested here is what the cache does with one.
 */
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
  await activateVersion(db, { versionId, action: 'activate', actor: 'test-admin', reason: 'test' });
}

/*
 * A binding that records the statements it was asked to prepare, so a test
 * can say what a request read rather than how long it took. Each one is a
 * binding the cache has not seen, which is what a fresh isolate is.
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

// a namespace that records the keys written to it
function recordingWrites(kv: KVNamespace): { kv: KVNamespace, written: string[] } {
  const written: string[] = [];
  const proxy = new Proxy(kv, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'put' && typeof(value) === 'function') {
        return (...parameters: unknown[]) => {
          written.push(parameters[0] as string);
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  return { kv: proxy, written };
}

// a namespace that counts the values read from it
function countingReads(kv: KVNamespace): { kv: KVNamespace, reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(kv, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === 'get' || property === 'getWithMetadata') && typeof(value) === 'function') {
        return (...parameters: unknown[]) => {
          reads += 1;
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  return { kv: proxy, reads: () => reads };
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

/*
 * What a read of the active version was answered from, told by what it read.
 * Every read asks D1 for the pointer; one that asked D1 for more hydrated the
 * version out of it, one that read KV instead was answered by the cache, and
 * one that read neither by the isolate's own memory.
 */
async function answeredFrom(
  isolate: { db: D1Database, statements: string[] },
  kv: KVNamespace,
  now?: () => Date,
): Promise<{ answer: CachedSnapshot | null, from: 'memory' | 'cache' | 'origin' }> {
  const asked   = isolate.statements.length;
  const watched = countingReads(kv);
  const answer  = await activeSnapshot(depsOf(isolate.db, watched.kv, now));
  const from    = isolate.statements.length - asked > 1 ? 'origin' : watched.reads() > 0 ? 'cache' : 'memory';
  return { answer, from };
}

async function activeFixture(): Promise<{ db: D1Database, kv: KVNamespace, versionId: string }> {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await validate(db, versionId);
  await activate(db, versionId);
  return { db, kv, versionId };
}

t.test('a version is hydrated once, then read from the cache', async t => {
  const { db, kv, versionId } = await activeFixture();

  const cold = counting(db);
  const { answer: first, from: hydrated } = await answeredFrom(cold, kv);
  t.equal(hydrated, 'origin', 'the first read hydrates the version out of D1');
  t.equal(first?.snapshot.registryVersion.id, versionId);
  t.ok(cold.statements.length > 1, 'which is more than one statement');

  const checksum = first!.snapshot.registryVersion.checksum;
  t.ok(await kv.get(snapshotKey({ id: versionId, checksum })) !== null, 'the bytes are cached under version and checksum');
  t.ok(await kv.get(POINTER_KEY) !== null, 'and the pointer that named them is remembered');

  const warm = counting(db);
  const { answer: second, from: cached } = await answeredFrom(warm, kv);
  t.equal(cached, 'cache', 'another isolate reads it from KV');
  t.same(second?.snapshot, first?.snapshot, 'with the same snapshot');
  t.equal(warm.statements.length, 1, 'having read D1 once, for the pointer alone');
  t.match(warm.statements[0], /registry_state/, 'which is the pointer statement');
});

/*
 * A hot isolate answers what it has read before from memory: it pays the
 * pointer read and nothing else, where reading KV would fetch and parse the
 * whole snapshot on every request.
 */
t.test('an isolate answers a version it has read before from memory', async t => {
  const { db, kv } = await activeFixture();
  const isolate = counting(db);
  const first   = await activeSnapshot(depsOf(isolate.db, kv));

  const watched = countingReads(kv);
  isolate.statements.length = 0;
  const again = await activeSnapshot(depsOf(isolate.db, watched.kv));
  t.equal(again?.snapshot, first?.snapshot, 'the same isolate answers with the very snapshot it read');
  t.equal(isolate.statements.length, 1, 'after the pointer read');
  t.equal(watched.reads(), 0, 'and without reading KV at all');
});

/*
 * The version the pointer names has a place in memory of its own. Pinned
 * versions are read by id on an anonymous route, and however many of them a
 * client reads, the active one stays where every public read and market
 * route finds it — with the catalog built from it, which is kept for as long
 * as the snapshot is.
 */
t.test('the versions sessions pin do not push the active one out of memory', async t => {
  const { db, kv, versionId: activeId } = await activeFixture();
  const pinned: string[] = [];
  for (let attempt = 2; attempt <= 6; attempt += 1) {
    const { versionId } = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt });
    await validate(db, versionId);
    pinned.push(versionId);
  }

  const isolate = counting(db);
  const first   = await activeSnapshot(depsOf(isolate.db, kv));
  for (const versionId of pinned) {
    const version = await versionSnapshot(depsOf(isolate.db, kv), versionId);
    t.equal((await version!.snapshot())?.registryVersion.id, versionId, 'a pinned version is read');
  }

  const watched = countingReads(kv);
  const again   = await activeSnapshot(depsOf(isolate.db, watched.kv));
  t.equal(again?.snapshot, first?.snapshot, 'after more pinned versions than an isolate keeps, the active one is in memory');
  t.equal(watched.reads(), 0, 'and KV is not read');

  await activate(db, pinned[pinned.length - 1]!);
  t.equal((await answeredFrom(isolate, kv)).from, 'memory', 'a pinned version switched on is answered from memory');
  isolate.statements.length = 0;
  t.equal((await versionSnapshot(depsOf(isolate.db, kv), activeId))?.ref.id, activeId);
  t.equal(isolate.statements.length, 0, 'and the version it replaced is kept for the sessions that pinned it');
});

t.test('the bytes of a version are written once, and never again while they are served', async t => {
  const { db, kv } = await activeFixture();
  const recorded = recordingWrites(kv);
  const snapshots = () => recorded.written.filter(key => key.startsWith('snapshot:'));

  const start = Date.parse('2026-09-23T12:00:00.000Z');
  await activeSnapshot(depsOf(counting(db).db, recorded.kv, () => new Date(start)));
  t.same(recorded.written.map(key => key.split(':')[0]).sort(), [ 'active', 'snapshot' ],
    'the first read writes the snapshot and the pointer');

  /*
   * An entry is never rewritten to keep it alive: it has no expiry to renew,
   * and the scheduled job, not a request, removes what nothing serves. A read
   * from a fresh isolate long after the write finds it there and writes none
   * of it again, where an expiring entry would have had its readers rewrite
   * it every half of its life.
   */
  for (const hours of [ 1, 2, 24 ]) {
    const later = await answeredFrom(counting(db), recorded.kv, () => new Date(start + hours * 3_600_000));
    t.equal(later.from, 'cache', `${hours} hours later another isolate still reads it from KV`);
  }
  t.equal(snapshots().length, 1, 'and no read wrote the snapshot again');

  const [ entry ] = (await kv.list({ prefix: 'snapshot:' })).keys;
  t.equal(entry?.expiration, undefined, 'the bytes have no expiry');
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
  const served = await answeredFrom(first, kv);
  t.equal(served.from, 'cache', 'so the first request after the activation pays the pointer read only');
  t.equal(first.statements.length, 1);
});

t.test('when D1 does not answer, the last version it named is served, and says how old it is', async t => {
  const { db, kv, versionId } = await activeFixture();

  const activatedAt = Date.parse('2026-09-23T12:00:00.000Z');
  await activeSnapshot(depsOf(db, kv, () => new Date(activatedAt)));

  const within = await activeSnapshot(depsOf(unreachable(), kv, () => new Date(activatedAt + 600_000)));
  t.equal(within?.snapshot.registryVersion.id, versionId, 'the version D1 last named answers while D1 is unreachable');
  t.equal(within?.staleFor, 600, 'and the answer says how many seconds old it is');

  /*
   * With nothing to fall back on, the registry is unavailable, which every
   * route answers with 503 — and why is kept for the log.
   */
  const past = await activeSnapshot(depsOf(unreachable(), kv, () => new Date(activatedAt + (STALE + 60) * 1000)))
    .then(() => null, (error: unknown) => error as Error & { reason?: string });
  t.equal(past?.name, 'RegistryUnavailable', 'past the window there is no answer to give');
  t.equal(past?.reason, 'unreadable', 'because the registry could not be read');
  t.match((past?.cause as Error | undefined)?.message, /D1_ERROR/, 'and the D1 failure is its cause');

  await t.rejects(
    activeSnapshot({ ...depsOf(unreachable(), kv, () => new Date(activatedAt + 600_000)), staleSeconds: 0 }),
    { name: 'RegistryUnavailable', reason: 'unreadable' },
    'an environment that configures no window would rather fail than serve an older version',
  );

  const { kv: empty } = await freshEnvironment();
  await t.rejects(
    activeSnapshot(depsOf(unreachable(), empty, () => new Date(activatedAt + 600_000))),
    { name: 'RegistryUnavailable', reason: 'unreadable' },
    'and so does a cache that holds nothing',
  );
});

/*
 * A database that cannot be reached is an error an operator has to see, even
 * while the fallback answers every request. The log says so once a minute,
 * not once a request: an outage served for an hour would otherwise write a
 * line, with the whole error, for every request it answered.
 */
t.test('an outage the fallback answers is an error in the log, once a minute', async t => {
  const { db, kv } = await activeFixture();
  const start = Date.parse('2026-09-23T12:00:00.000Z');
  await activeSnapshot(depsOf(db, kv, () => new Date(start)));

  const lines = { error: [] as unknown[], warn: [] as unknown[] };
  const debug = {
    error: (message: unknown) => lines.error.push(message),
    warn:  (message: unknown) => lines.warn.push(message),
  };
  const down = unreachable();
  for (const seconds of [ 1, 2, 30, 59, 61, 62 ]) {
    const served = await activeSnapshot({ ...depsOf(down, kv, () => new Date(start + seconds * 1000)), debug });
    t.equal(served?.staleFor, seconds, `${seconds} seconds into the outage the request is answered, as that old`);
  }
  t.same(lines.error, [
    'registry database unreachable; answering from the version it last named',
    'registry database unreachable; answering from the version it last named',
  ], 'the log says so as an error when the outage is first met, and again once a minute has passed');
  t.same(lines.warn, [], 'and says nothing else about it');
});

t.test('a registry with nothing active is an answer, not an outage', async t => {
  const { db, kv } = await activeFixture();
  const cached = await activeSnapshot(depsOf(db, kv));
  const pointer = cached!.snapshot.registryVersion;
  const bytes   = JSON.stringify(cached!.snapshot);

  /*
   * A database with no activation, and a cache that could answer for one:
   * the reset clears both stores, so the cache is written again by hand —
   * otherwise this would assert nothing.
   */
  const empty = await freshEnvironment();
  await empty.kv.put(snapshotKey(pointer), bytes);
  await empty.kv.put(POINTER_KEY, JSON.stringify({ ...pointer, at: new Date().toISOString() }), { expirationTtl: 3600 });
  t.ok((await empty.kv.list()).keys.length >= 2, 'the cache holds a version and the pointer that named it');

  t.equal(await activeSnapshot(depsOf(empty.db, empty.kv)), null,
    'a D1 that says no version is active is believed, even with a cache that could answer');
});

t.test('the public read is served through the cache', async t => {
  const { kv, versionId } = await activeFixture();

  const response = await server.fetch('/registry/v1/active');
  t.equal(response.status, 200);
  t.equal(response.headers.get('x-registry-version'), versionId);
  t.equal(response.headers.get('x-registry-stale'), null, 'a verified answer is not stale');
  t.match(response.headers.get('cache-control') ?? '', /max-age=\d+/);

  const keys: string[] = (await kv.list()).keys.map((key: { name: string }) => key.name);
  t.ok(keys.some(name => name.startsWith('snapshot:v1:')), 'the worker cached the snapshot it served');
  t.ok(keys.includes(POINTER_KEY), 'and the pointer it verified');
});

/*
 * The headers a cross-origin client needs: which version answered, whether
 * it came from the cache because the database could not be reached, and the
 * tag a conditional request sends back.
 */
t.test('the version headers are readable by a browser', async t => {
  await activeFixture();

  const response = await server.fetch('/registry/v1/active');
  const exposed  = response.headers.get('access-control-expose-headers') ?? '';
  for (const header of [ 'ETag', 'X-Registry-Version', 'X-Registry-Checksum', 'X-Registry-Stale' ]) {
    t.match(exposed, header, `${header} is exposed to a cross-origin client`);
  }
});

/*
 * An entry is trusted for what it is, not for what it claims to be. The key
 * names the version and its checksum, and the content is checked against
 * that checksum: an entry edited by hand, or one that is not a snapshot at
 * all, would otherwise be served under the version's genuine checksum, or
 * fail in the catalog on every request of every isolate.
 */
t.test('an entry that is not the version it is cached as is refused, and replaced', async t => {
  const { db, kv } = await activeFixture();
  const first   = await activeSnapshot(depsOf(counting(db).db, kv));
  const pointer = first!.snapshot.registryVersion;

  const tampered: RegistrySnapshotV1 = structuredClone(first!.snapshot);
  tampered.networks[0]!.markets[0]!.baseAsset.token.symbol = 'TAMPERED';
  const broken = structuredClone(first!.snapshot) as unknown as { networks: Array<{ markets: unknown }> };
  broken.networks[0]!.markets = null;
  const elsewhere: RegistrySnapshotV1 = {
    ...first!.snapshot,
    registryVersion: { ...pointer, sourceRepository: 'someone-else/comet', sourceCommitSha: 'f'.repeat(40) },
  };

  for (const [ what, entry ] of [
    [ 'an edited value',         tampered ],
    [ 'a network without a list of markets', broken ],
    [ 'something that is not a snapshot', { registryVersion: pointer } ],
    [ 'the version said to come from another source', elsewhere ],
  ] as const) {
    await kv.put(snapshotKey(pointer), JSON.stringify(entry));

    const { answer: answered, from } = await answeredFrom(counting(db), kv);
    t.equal(from, 'origin', `${what} is refused, and D1 answers instead`);
    t.same(answered?.snapshot, first?.snapshot, 'with the version itself');

    const rewritten = await kv.get(snapshotKey(pointer), 'json');
    t.same(rewritten, first?.snapshot, 'and the entry is replaced by the version');
  }
});

/*
 * What is served of an entry is what was checked: the version as its row
 * names it, and the networks its checksum covers. Anything else the entry
 * holds stays in KV.
 */
t.test('only what was checked of an entry is served', async t => {
  const { db, kv } = await activeFixture();
  const first   = await activeSnapshot(depsOf(counting(db).db, kv));
  const pointer = first!.snapshot.registryVersion;

  await kv.put(snapshotKey(pointer), JSON.stringify({ ...first!.snapshot, injected: 'not part of the version' }));
  const { answer: answered, from } = await answeredFrom(counting(db), kv);
  t.equal(from, 'cache', 'an entry that holds the version is read from KV');
  t.equal((answered?.snapshot as unknown as Record<string, unknown>).injected, undefined, 'without what else it holds');
  t.same(answered?.snapshot, first?.snapshot, 'as the version itself');

  // during an outage the version is named by the pointer record, and checked against it the same way
  const record = JSON.parse(await kv.get(POINTER_KEY) ?? 'null') as Record<string, string>;
  t.same([ record.sourceRepository, record.sourceCommitSha ], [ pointer.sourceRepository, pointer.sourceCommitSha ],
    'the pointer record names the source of the version');
  const stale = await activeSnapshot(depsOf(unreachable(), kv));
  t.not(stale?.staleFor ?? null, null, 'and answered as stale');
  t.equal((stale?.snapshot as unknown as Record<string, unknown>).injected, undefined, 'and serves no more of it');
});

/*
 * The checksum a version was validated with covers its content as the
 * release that validated it hydrated it. A release that hydrates another
 * shape no longer matches it: such a version is served from D1, and then
 * from memory, but never written to KV, where every isolate would read it,
 * refuse it and hydrate it again.
 */
t.test('a version this release cannot verify is served, but not cached', async t => {
  const { db, kv } = await freshEnvironment();
  const { versionId } = await seedCandidate(db, snapshot);
  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, 'f'.repeat(64));
  await activate(db, versionId);

  const isolate = counting(db);
  const served  = await answeredFrom(isolate, kv);
  t.equal(served.from, 'origin', 'the version is served from D1');
  t.equal(served.answer?.snapshot.registryVersion.id, versionId);
  t.equal((await kv.list({ prefix: 'snapshot:' })).keys.length, 0, 'and its bytes are not cached');
  t.equal((await answeredFrom(isolate, kv)).from, 'memory', 'while the isolate keeps them');
});

/*
 * The fallback is for a database that could not be reached. A database that
 * answered — with a table that does not exist, because a release went out
 * ahead of its migration — must not be papered over with an hour of older
 * data: that is the one failure an operator has to see.
 */
t.test('a database that answers with a fault is not masked by the cache', async t => {
  const { db, kv } = await activeFixture();
  await activeSnapshot(depsOf(db, kv));

  const faulty = {
    prepare() { throw new Error(`D1_ERROR: no such column: version.snapshot_digest`); },
    batch()   { throw new Error(`D1_ERROR: no such column: version.snapshot_digest`); },
  } as unknown as D1Database;

  await t.rejects(
    activeSnapshot(depsOf(faulty, kv)),
    { message: /no such column/ },
    'the fault is raised, with what the database actually said',
  );
  t.not((await activeSnapshot(depsOf(unreachable(), kv)))?.staleFor ?? null, null,
    'while a database that could not be reached is what the fallback is for');
});

/*
 * A version named by id is read the way the active one is: its row names its
 * bytes, and the bytes come from memory or KV before D1. Its reference alone
 * is what a conditional request needs.
 */
t.test('a pinned version is read through the cache', async t => {
  const { db, kv, versionId } = await activeFixture();
  await activeSnapshot(depsOf(counting(db).db, kv));

  const isolate = counting(db);
  const pinned  = await versionSnapshot(depsOf(isolate.db, kv), versionId);
  t.same(pinned?.ref, { id: versionId, checksum: await snapshotChecksum(snapshot.networks) }, 'its row names it');
  t.equal(isolate.statements.length, 1, 'which is one statement');
  t.equal((await pinned!.snapshot())?.registryVersion.id, versionId);
  t.equal(isolate.statements.length, 1, 'and its bytes come from KV, not from D1');

  isolate.statements.length = 0;
  const again = await versionSnapshot(depsOf(isolate.db, kv), versionId);
  t.equal(again?.ref.id, versionId, 'an isolate that holds it');
  t.equal(isolate.statements.length, 0, 'answers without asking D1: a validated version never changes');

  t.equal(await versionSnapshot(depsOf(db, kv), randomUUID()), null, 'a version that does not exist is none');
  await t.rejects(
    versionSnapshot(depsOf(unreachable(), kv), randomUUID()),
    { name: 'RegistryUnavailable', reason: 'unreadable' },
    'and a database that does not answer is the registry being unavailable',
  );
});

/*
 * Entries have no expiry, so the scheduled job removes those of versions
 * nothing is about to serve: what stays is the active version, the one the
 * pointer record names for an outage, and every validated version newer than
 * the active one, cached for its activation.
 */
t.test('the scheduled job removes the bytes nothing is about to serve', async t => {
  const { db, kv } = await freshEnvironment();
  const later = () => new Promise(resolve => setTimeout(resolve, 5));
  const seed  = async () => {
    const { versionId } = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 1 });
    await validate(db, versionId);
    await later();
    return versionId;
  };
  const older   = await seed();
  const active  = await seed();
  const waiting = await seed();
  await activate(db, active);

  for (const versionId of [ older, active, waiting ]) {
    await warmSnapshot(depsOf(db, kv), versionId);
  }
  const foreign = `snapshot:v0:${randomUUID()}:${'a'.repeat(64)}`;
  await kv.put(foreign, '{}');
  await activeSnapshot(depsOf(counting(db).db, kv));

  const checksum = await snapshotChecksum(snapshot.networks);
  const pruned   = await pruneSnapshots(depsOf(db, kv));
  t.same(pruned.sort(), [ foreign, snapshotKey({ id: older, checksum }) ].sort(),
    'an older version nothing serves and an entry of another schema are removed');

  const left: string[] = (await kv.list({ prefix: 'snapshot:' })).keys.map((key: { name: string }) => key.name).sort();
  t.same(left, [ snapshotKey({ id: active, checksum }), snapshotKey({ id: waiting, checksum }) ].sort(),
    'the active version and the one waiting for its activation stay');

  // a rollback to the pruned version caches it again when it is read
  await activate(db, older);
  t.equal((await answeredFrom(counting(db), kv)).from, 'origin', 'a version pruned and switched on again');
  t.ok(await kv.get(snapshotKey({ id: older, checksum })) !== null, 'is cached again by the first read');

  await t.rejects(pruneSnapshots(depsOf(unreachable(), kv)), /D1_ERROR/, 'and with D1 unreachable');
  t.equal((await kv.list({ prefix: 'snapshot:' })).keys.length, 3, 'nothing is removed');
});

/*
 * The removal runs in the hourly Cron, beside the import. Entries have no
 * expiry, so a Cron that stopped pruning would leave every version ever
 * served in KV for good.
 */
t.test('the hourly Cron prunes the cache', async t => {
  const { db, kv, versionId } = await activeFixture();
  const scheduledTime = new Date();
  /*
   * The Cron reaches out to two services, and each was asked recently: the
   * source, which discovery asks once a day, and the chain, which the version
   * on is held against once a day. A check of each recorded now keeps the
   * Cron off the network.
   */
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(scheduledTime.toISOString()).run();
  const checked = { versionId, checkedAt: scheduledTime.toISOString(), drifts: [], unreadable: [] };
  await kv.put(CHECK_KEY, JSON.stringify(checked));
  await activeSnapshot(depsOf(counting(db).db, kv));

  const checksum = await snapshotChecksum(snapshot.networks);
  const unwanted = snapshotKey({ id: randomUUID(), checksum });
  await kv.put(unwanted, '{}');

  const scheduled = await server.getWorker<Env>().scheduled({ cron: '0 * * * *', scheduledTime });
  t.equal(scheduled.outcome, 'ok', 'the Cron runs');
  t.equal(await kv.get(unwanted), null, 'and removes the bytes of a version nothing serves');
  t.ok(await kv.get(snapshotKey({ id: versionId, checksum })) !== null, 'while the active version keeps its own');
  t.same(await kv.get(CHECK_KEY, 'json'), checked, 'and leaves the chain, checked this hour, alone');
});
