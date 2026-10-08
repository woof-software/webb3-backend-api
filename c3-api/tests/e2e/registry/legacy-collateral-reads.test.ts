import t, { Test } from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';
import type { ActiveMarketV1, ActiveSnapshotV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import { setLegacyCollateral } from '../../../src/registry/legacy-collateral-repository.js';
import { LEGACY_KEY, legacyDecisions, recordLegacyCollaterals } from '../../../src/registry/legacy-collaterals.js';

import { MemoryKv } from '../../util/kv.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { makeTestEnv } from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * What the active reads answer about legacy collaterals, through the worker's
 * own entry point: the flag on every collateral of /active and the market
 * reads, by the decisions in force when they answer; ETags that change with
 * the flags they name, and only then; when the database cannot be reached,
 * the decisions the Worker last recorded, said to be unconfirmed; and how
 * the reads keep that record, which some of the tests below drive directly.
 *
 * Decisions are made through the repository, or through the command where
 * what it records is the point, so nothing here spends the limiter's budget.
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';

let seed = 0;

type Envelope = { error: { code: string, message: string } };

/*
 * The database as requests reach it: every statement fails as D1 does when it
 * cannot be reached while `down()` says so, and the statements `failing`
 * matches fail that way always.
 */
function reachable(db: D1Database, { down = () => false, failing = /^$/ }: { down?: () => boolean, failing?: RegExp } = {}): D1Database {
  const lost = () => { throw new Error('D1_ERROR: Network connection lost.'); };
  const statement = { bind: () => statement, all: lost, first: lost, run: lost, raw: lost };
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'prepare') {
        return (sql: string) => down() ? lost() : failing.test(sql) ? statement : (value as D1Database['prepare']).call(target, sql);
      }
      if (property === 'batch') {
        return (statements: D1PreparedStatement[]) => down() ? lost() : (value as D1Database['batch']).call(target, statements);
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

async function envOf(db: D1Database, kv: KVNamespace, overrides: Partial<Env> = {}): Promise<Env> {
  return makeTestEnv({
    APP_DB:                           db,
    kv_registry:                      kv,
    MEMORY_CACHE_SEED:                `legacy-collateral-reads-${seed++}`,
    COMET_REGISTRY_ADMIN_TOKEN_HASH:  await sha256Hex(ADMIN_TOKEN),
    REGISTRY_ADMIN_RATE_LIMITER:      { limit: async () => ({ success: true }) },
    REGISTRY_ADMIN_AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  });
}

async function get(env: Env, path: string, headers: Record<string, string> = {}): Promise<Response> {
  return C3Api.fetch(new Request(`https://api.test.local${path}`, { headers }), env);
}

async function json<T>(env: Env, path: string): Promise<T> {
  const response = await get(env, path);
  if (response.status !== 200) {
    throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  }
  return await response.json() as T;
}

// what the worker logged, for the length of a test, each line after its level
function captureLogs(t: Test): string[] {
  const lines: string[] = [];
  const { error, warn } = console;
  console.error = (...parameters: unknown[]) => { lines.push(`error: ${parameters.map(String).join(' ')}`); };
  console.warn  = (...parameters: unknown[]) => { lines.push(`warn: ${parameters.map(String).join(' ')}`); };
  t.teardown(() => {
    console.error = error;
    console.warn  = warn;
  });
  return lines;
}

async function fixture(t: Test) {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const mainnet = registry.snapshot.networks.find(network => network.chainId === 1)!;
  const market  = (key: string) => mainnet.markets.find(entry => entry.deploymentKey === key)!;
  const token   = (key: string, symbol: string) => market(key).collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address;
  const decide  = (key: string, symbol: string, isLegacy: boolean) => setLegacyCollateral(registry.db, {
    chainId:      1,
    cometAddress: market(key).contracts.comet!,
    tokenAddress: token(key, symbol),
    isLegacy,
    actor:        'test',
    reason:       'decided for a legacy collateral read test',
  });
  return { registry, market, decide, USDT: market('usdt').contracts.comet!, USDC: market('usdc').contracts.comet! };
}

// the collaterals an answer flags legacy, as `market/symbol`
function flaggedIn(networks: Array<{ markets: ActiveMarketV1[] }>): string[] {
  return networks.flatMap(network => network.markets.flatMap(market => market.collateralAssets
    .filter(asset => asset.isLegacy)
    .map(asset => `${market.deploymentKey}/${asset.token.symbol}`)));
}

t.test('the active reads mark every collateral by the decisions in force, and the version read by id marks none', async t => {
  const { registry, decide, USDT } = await fixture(t);
  const env = await envOf(registry.db, MemoryKv({}));

  const before = await json<ActiveSnapshotV1>(env, '/registry/v1/active');
  const assets = before.networks.flatMap(network => network.markets.flatMap(market => market.collateralAssets));
  t.ok(assets.length > 0 && assets.every(asset => asset.isLegacy === false), 'every collateral is current while nobody has decided');
  t.same(Object.keys(assets[0]!), [ 'assetIndex', 'token', 'priceFeed', 'isLegacy' ], 'the flag stands beside what the version says');
  t.same(
    before.networks.map(network => ({ ...network, markets: network.markets.map(market => ({
      ...market,
      collateralAssets: market.collateralAssets.map(({ isLegacy: _isLegacy, ...asset }) => asset),
    })) })),
    registry.snapshot.networks,
    'and everything else is the version as it was stored',
  );

  await decide('usdt', 'mETH', true);
  await decide('usdc', 'weETH', true);
  const after = await json<ActiveSnapshotV1>(env, '/registry/v1/active');
  t.same(flaggedIn(after.networks), [ 'usdc/weETH', 'usdt/mETH' ], 'the next answer flags each decided collateral in its own market');

  const markets = await json<{ markets: ActiveMarketV1[] }>(env, '/registry/v1/networks/1/markets');
  t.same(flaggedIn([ markets ]), [ 'usdc/weETH', 'usdt/mETH' ], 'and so does the chain\'s market list');
  const usdt = await json<{ market: ActiveMarketV1 }>(env, `/registry/v1/networks/1/markets/${USDT}`);
  t.same(flaggedIn([ { markets: [ usdt.market ] } ]), [ 'usdt/mETH' ], 'and the market itself, its own decisions only');
  t.same(flaggedIn([ await json<{ markets: ActiveMarketV1[] }>(env, '/registry/v1/networks/8453/markets') ]), [],
    'while another chain flags nothing');

  const pinned = await json<RegistrySnapshotV1>(env, `/registry/v1/versions/${registry.versionId}`);
  t.same(pinned.networks, registry.snapshot.networks, 'the version read by id is the version as it was imported, without a flag');
});

t.test('a decision changes the tag of every answer whose flags it changes, and of no other', async t => {
  const { registry, decide, USDT, USDC } = await fixture(t);
  const env  = await envOf(registry.db, MemoryKv({}));
  const tag  = async (path: string) => (await get(env, path)).headers.get('etag')!;
  const paths = [
    '/registry/v1/active',
    '/registry/v1/networks/1/markets',
    `/registry/v1/networks/1/markets/${USDT}`,
    `/registry/v1/networks/1/markets/${USDC}`,
    '/registry/v1/networks/8453/markets',
    `/registry/v1/versions/${registry.versionId}`,
    '/registry/v1/networks',
  ];
  const first = Object.fromEntries(await Promise.all(paths.map(async path => [ path, await tag(path) ] as const)));
  t.match(first['/registry/v1/active'], new RegExp(`^"v1-r3-snapshot\\+legacy-[0-9a-f]{16}-${registry.versionId}-[0-9a-f]{64}"$`),
    'the bootstrap tag names the flags it carries beside the version');
  t.equal(first[`/registry/v1/versions/${registry.versionId}`], `"v1-r3-snapshot-${registry.versionId}-${registry.snapshot.registryVersion.checksum}"`,
    'and the version read by id, which carries none, is another representation');

  await decide('usdt', 'mETH', true);
  const answered = async (path: string, etag: string) => (await get(env, path, { 'If-None-Match': etag })).status;
  for (const path of paths.slice(0, 3)) {
    t.equal(await answered(path, first[path]!), 200, `${path} sends the body again to a client holding a copy without the flag`);
    const next = await tag(path);
    t.not(next, first[path], 'under a new tag');
    t.equal(await answered(path, next), 304, 'which it then confirms');
    t.equal(await answered(path, `W/${next}`), 304, 'weak or strong');
  }
  for (const path of paths.slice(3)) {
    t.equal(await answered(path, first[path]!), 304, `${path}, which flags nothing the decision changed, still confirms its copy`);
  }

  await decide('usdt', 'mETH', false);
  t.equal(await tag('/registry/v1/active'), first['/registry/v1/active'], 'taking the decision back is the first answer again, under its tag');
  t.equal(await answered('/registry/v1/active', first['/registry/v1/active']!), 304, 'which confirms the copy made before it');
});

/*
 * The fallback (cache.ts) answers with the version D1 last named; the flags it
 * marks are the decisions the Worker last recorded, which a read records where
 * the record does not hold them.
 */
t.test('during an outage the active reads answer with the decisions last recorded', async t => {
  const { registry, market, decide, USDT } = await fixture(t);
  const logs = captureLogs(t);
  let down = false;
  const kv  = MemoryKv({});
  const env = await envOf(reachable(registry.db, { down: () => down }), kv);

  await decide('usdt', 'mETH', true);
  t.equal((await get(env, '/registry/v1/active')).status, 200, 'a read while the database answers caches the version');
  const mEth = market('usdt').collateralAssets.find(asset => asset.token.symbol === 'mETH')!.token.address;
  const recorded = await kv.get(LEGACY_KEY, 'json') as { at: string, collaterals: unknown[] };
  t.same(recorded.collaterals, [ { chainId: 1, cometAddress: USDT, tokenAddress: mEth } ], 'and records the decisions it read');

  down = true;
  for (const path of [ '/registry/v1/active', '/registry/v1/networks/1/markets', `/registry/v1/networks/1/markets/${USDT}` ]) {
    const response = await get(env, path);
    t.equal(response.status, 200, `${path} answers from the cache`);
    t.match(response.headers.get('x-registry-stale'), /^[0-9]+$/, 'saying how old its answer is');
    t.equal(response.headers.get('cache-control'), 'no-store', 'and that nothing may keep it');
    const body = await response.json() as { networks?: Array<{ markets: ActiveMarketV1[] }>, markets?: ActiveMarketV1[], market?: ActiveMarketV1 };
    const networks = body.networks ?? [ { markets: body.markets ?? [ body.market! ] } ];
    t.same(flaggedIn(networks), [ 'usdt/mETH' ], 'with the decisions last recorded');
    t.equal((await get(env, path, { 'If-None-Match': response.headers.get('etag')! })).status, 200, 'and confirms nothing');
  }
  t.ok(logs.some(line => line === 'warn: legacy collateral decisions unreadable; answering with the ones last recorded'),
    'the log says where the flags came from');
  t.equal(logs.filter(line => line.includes('legacy collateral decisions unreadable')).length, 1, 'once a minute, not once a request');
});

t.test('a decision a command makes is recorded at once, for an outage to answer with', async t => {
  const { registry, market } = await fixture(t);
  captureLogs(t);
  let down = false;
  const env = await envOf(reachable(registry.db, { down: () => down }), MemoryKv({}));
  t.same(flaggedIn((await json<ActiveSnapshotV1>(env, '/registry/v1/active')).networks), [], 'nothing is legacy at first');

  const usdc  = market('usdc');
  const weEth = usdc.collateralAssets.find(asset => asset.token.symbol === 'weETH')!.token.address;
  const command = await C3Api.fetch(new Request(
    `https://api.test.local/registry/v1/admin/networks/1/markets/${usdc.contracts.comet}/collaterals/${weEth}/legacy`,
    {
      method:  'PATCH',
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ isLegacy: true, reason: 'Linear COM-18' }),
    },
  ), env);
  t.equal(command.status, 200, 'the command commits');

  down = true;
  const response = await get(env, '/registry/v1/active');
  t.equal(response.status, 200);
  t.same(flaggedIn((await response.json() as ActiveSnapshotV1).networks), [ 'usdc/weETH' ],
    'and an outage right after it, before any read, answers with its decision');
});

t.test('decisions the database does not give are answered from the record, and said to be unconfirmed', async t => {
  const { registry, decide } = await fixture(t);
  const logs = captureLogs(t);
  const kv = MemoryKv({});
  await decide('wbtc', 'LBTC', true);
  await json(await envOf(registry.db, kv), '/registry/v1/active');

  const env = await envOf(reachable(registry.db, { failing: /FROM legacy_collaterals/ }), kv);
  const response = await get(env, '/registry/v1/active');
  t.equal(response.status, 200, 'a version the database confirms is answered');
  t.equal(response.headers.get('x-registry-version'), registry.versionId);
  t.equal(response.headers.get('x-registry-stale'), '0', 'as no older than now, since the version is the one on');
  t.equal(response.headers.get('cache-control'), 'no-store', 'but not to be kept, since its flags are as last recorded');
  t.same(flaggedIn((await response.json() as ActiveSnapshotV1).networks), [ 'wbtc/LBTC' ], 'which they are');
  t.equal((await get(env, '/registry/v1/active', { 'If-None-Match': response.headers.get('etag')! })).status, 200,
    'and such an answer confirms no copy');
  t.ok(logs.some(line => line.includes('legacy collateral decisions unreadable; answering with the ones last recorded')));
});

t.test('without a record to answer with, decisions the database does not give are a 503', async t => {
  const { registry, decide } = await fixture(t);
  captureLogs(t);
  await decide('wbtc', 'LBTC', true);
  const failing = /FROM legacy_collaterals/;

  const fresh = await envOf(reachable(registry.db, { failing }), MemoryKv({}));
  const unrecorded = await get(fresh, '/registry/v1/active');
  t.equal(unrecorded.status, 503, 'nothing recorded is nothing to answer with');
  t.equal((await unrecorded.json() as Envelope).error.code, 'UPSTREAM_UNAVAILABLE');

  const garbled = MemoryKv({ seed: { [LEGACY_KEY]: { collaterals: 'not a list' } } });
  t.equal((await get(await envOf(reachable(registry.db, { failing }), garbled), '/registry/v1/active')).status, 503,
    'nor is a record that is not one');

  /*
   * An environment that would rather fail than answer from the cache has no
   * fallback window, so nothing records the decisions and nothing answers
   * with them.
   */
  const kv = MemoryKv({});
  const windowless = { REGISTRY_STALE_FALLBACK_MAX_S: '0' };
  await json(await envOf(registry.db, kv, windowless), '/registry/v1/active');
  t.equal(await kv.get(LEGACY_KEY), null, 'without a window, a read records nothing');
  t.equal((await get(await envOf(reachable(registry.db, { failing }), kv, windowless), '/registry/v1/active')).status, 503,
    'and decisions the database does not give are a 503 there');
});

/*
 * The version selects what a market read asks for before the decisions mark
 * it, so a request the version refuses is refused as it always was, even
 * while the decisions cannot be read and nothing is recorded to answer with:
 * only a request the version answers waits for them.
 */
t.test('a market read the version refuses is refused as before, whatever the decisions did', async t => {
  const { registry } = await fixture(t);
  captureLogs(t);
  const failing = /FROM legacy_collaterals/;
  const refused = [
    [ '/registry/v1/networks/01/markets',                                              400, 'BAD_REQUEST' ],
    [ '/registry/v1/networks/999/markets',                                             404, 'NOT_FOUND' ],
    [ '/registry/v1/networks/11155111/markets',                                        404, 'NOT_FOUND' ],
    [ '/registry/v1/networks/1/markets/not-an-address',                                400, 'BAD_REQUEST' ],
    [ '/registry/v1/networks/1/markets/0x0000000000000000000000000000000000000001',   404, 'NOT_FOUND' ],
    [ '/registry/v1/networks/0x1/markets/0x0000000000000000000000000000000000000001', 400, 'BAD_REQUEST' ],
  ] as const;
  for (const [ setting, overrides ] of [ [ 'nothing recorded', {} ], [ 'no fallback window', { REGISTRY_STALE_FALLBACK_MAX_S: '0' } ] ] as const) {
    const env = await envOf(reachable(registry.db, { failing }), MemoryKv({}), overrides);
    for (const [ path, status, code ] of refused) {
      const response = await get(env, path);
      t.same([ response.status, (await response.json() as Envelope).error.code ], [ status, code ], `${setting}: ${path} is refused`);
    }
    const answered = await get(env, '/registry/v1/networks/1/markets');
    t.same([ answered.status, (await answered.json() as Envelope).error.code ], [ 503, 'UPSTREAM_UNAVAILABLE' ],
      `${setting}: while a read the version answers needs the decisions`);
  }
});

/*
 * Another binding of a namespace: what another isolate reads and writes the
 * same store through, since an isolate knows the record by its own binding.
 * `put` stands in for its writes, given the write itself to make.
 */
function bindingOf(store: KVNamespace, { put }: { put?: (parameters: unknown[], write: () => Promise<void>) => Promise<void> } = {}): KVNamespace {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'put' && put !== undefined) {
        return (...parameters: unknown[]) => put(parameters, () => (value as (...parameters: unknown[]) => Promise<void>).apply(target, parameters));
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
}

// waits for a condition, for five seconds at most: one never met fails the assertions after it, not the run
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

/*
 * The database, and how many reads of the legacy decisions it has answered:
 * what a test waits on to know that a read has gone past it. Whatever a read
 * does with the answer before it next waits on I/O is done by the time a
 * timer sees the count.
 */
function counting(db: D1Database): { db: D1Database, answered: () => number } {
  let answered = 0;
  const wrapped = new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property !== 'prepare') {
        return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
      }
      return (sql: string) => {
        const statement = (value as D1Database['prepare']).call(target, sql);
        if (!/FROM legacy_collaterals/.test(sql)) {
          return statement;
        }
        return new Proxy(statement, {
          get(inner, name) {
            const method = Reflect.get(inner, name) as unknown;
            if (name === 'all') {
              return async (...parameters: unknown[]) => {
                const result = await (method as (...parameters: unknown[]) => Promise<unknown>).apply(inner, parameters);
                answered += 1;
                return result;
              };
            }
            return typeof(method) === 'function' ? (method as () => unknown).bind(inner) : method;
          },
        });
      };
    },
  });
  return { db: wrapped, answered: () => answered };
}

/*
 * KV keeps whichever write reaches it last, and takes one write a second to a
 * key. The reads of an isolate check the record once between them, and write
 * it only where it does not hold the decisions they found: the isolates of a
 * deploy, starting together, find it right and write nothing.
 */
t.test('the reads of an isolate check the record once between them, and write it only where it differs', async t => {
  const { registry, decide } = await fixture(t);
  const store = MemoryKv({});
  let gets = 0;
  let puts = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const counted = (gate: Promise<void>) => new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'get' || property === 'put') {
        return async (...parameters: unknown[]) => {
          if (property === 'get') {
            gets += 1;
            await gate;
          } else {
            puts += 1;
          }
          return (value as (...parameters: unknown[]) => Promise<unknown>).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  const warnings: unknown[] = [];
  const { db, answered } = counting(registry.db);
  const depsOf = (kv: KVNamespace) => ({
    db,
    kv,
    ttlSeconds:   300,
    staleSeconds: 3600,
    debug:        { error: () => {}, warn: (message: unknown) => { warnings.push(message); } },
  });

  const deps  = depsOf(counted(held));
  let settled = 0;
  const burst = Array.from({ length: 8 }, () => legacyDecisions(deps).then(read => { settled += 1; return read; }));
  await until(() => settled >= 7);
  t.equal(gets, 1, 'eight reads arriving together check the record once, the other seven leaving it to that check');
  const command = recordLegacyCollaterals(deps);
  await until(() => answered() === 9);
  release();
  await Promise.all([ ...burst, command ]);
  t.same([ gets, puts, warnings ], [ 1, 1, [] ],
    'and the one check writes what it did not find, once, as does a command that decided nothing meanwhile');

  const started = depsOf(counted(Promise.resolve()));
  await Promise.all(Array.from({ length: 8 }, () => legacyDecisions(started)));
  t.same([ gets, puts ], [ 2, 1 ], 'an isolate starting after it finds the record right, and writes nothing');

  await decide('usdt', 'mETH', true);
  await legacyDecisions(started);
  t.same([ gets, puts ], [ 3, 2 ], 'until the decisions change, when its next read finds the record behind them and writes it');
  await legacyDecisions(deps);
  t.same([ gets, puts ], [ 4, 2 ], 'which another isolate then finds written');

  await store.put(LEGACY_KEY, JSON.stringify({ collaterals: 'not a list' }));
  await legacyDecisions(depsOf(counted(Promise.resolve())));
  t.equal(puts, 3, 'and a record that is not one is written over');
  t.equal((await store.get(LEGACY_KEY, 'json') as { collaterals: unknown[] }).collaterals.length, 1, 'with the decisions');
});

/*
 * A read that began before a decision can write after the decision's own
 * record, and put back the decisions before it. Every isolate checks the
 * record again every five minutes, even while the decisions it reads stay the
 * same, so such a record is put right by the first check after it.
 */
t.test('a record a read put back after a decision is put right by the next check', async t => {
  const { registry, decide } = await fixture(t);
  const store = MemoryKv({});
  let now = Date.parse('2026-10-08T12:00:00.000Z');
  const depsOf = (kv: KVNamespace) => ({
    db:           registry.db,
    kv,
    ttlSeconds:   300,
    staleSeconds: 3600,
    now:          () => new Date(now),
    debug:        { error: () => {}, warn: () => {} },
  });
  const recorded = async () => (await store.get(LEGACY_KEY, 'json') as { collaterals: unknown[] }).collaterals.length;

  // isolate A reads the decisions before one is made, and its write of them is slow
  let reached!: () => void;
  let release!: () => void;
  const atWrite  = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const a = depsOf(bindingOf(store, { put: async (_parameters, write) => { reached(); await released; await write(); } }));
  const b = depsOf(bindingOf(store));
  const reading = legacyDecisions(a);
  await atWrite;

  // isolate B makes a decision meanwhile, and its command records it
  await decide('usdt', 'mETH', true);
  await recordLegacyCollaterals(b);
  t.equal(await recorded(), 1, 'the command records its decision');
  release();
  t.equal((await reading).decisions.collaterals.length, 0, 'A read the decisions before it');
  t.equal(await recorded(), 0, 'and its write, landing last, put back the decisions before the decision');

  now += 4 * 60_000;
  await legacyDecisions(b);
  t.equal(await recorded(), 0, 'B, which recorded the decision itself, checks the record again only after five minutes');
  now += 60_000;
  await legacyDecisions(b);
  t.equal(await recorded(), 1, 'and puts it right at that check');
});

/*
 * KV takes one write a second to a key, which the isolates of a deploy can
 * still exceed together, where the record is behind the decisions. One whose
 * write failed records again a minute later, or as soon as the decisions
 * change, rather than on every read it answers.
 */
t.test('a record that could not be written is written again a minute later, not on every read', async t => {
  const { registry, decide } = await fixture(t);
  const kv = MemoryKv({});
  let refusing = true;
  let puts     = 0;
  const throttled = new Proxy(kv, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'put') {
        return async (...parameters: unknown[]) => {
          puts += 1;
          if (refusing) {
            throw new Error('KV PUT failed: 429 Too Many Requests');
          }
          return (value as (...parameters: unknown[]) => Promise<void>).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  const warnings: unknown[] = [];
  let now = Date.parse('2026-10-08T12:00:00.000Z');
  const deps = {
    db:           registry.db,
    kv:           throttled,
    ttlSeconds:   300,
    staleSeconds: 3600,
    now:          () => new Date(now),
    debug:        { error: () => {}, warn: (message: unknown) => { warnings.push(message); } },
  };

  t.equal((await legacyDecisions(deps)).recorded, false, 'the decisions come from the database');
  t.same([ puts, warnings ], [ 1, [ 'legacy collateral record unwritable' ] ], 'and a refused write is a warning, never a failure');
  await legacyDecisions(deps);
  now += 30_000;
  await legacyDecisions(deps);
  t.equal(puts, 1, 'the reads of the next minute do not write again');

  now += 31_000;
  refusing = false;
  await legacyDecisions(deps);
  t.equal(puts, 2, 'a minute later a read writes again');
  t.same((await kv.get(LEGACY_KEY, 'json') as { collaterals: unknown[] }).collaterals, [], 'and the record is written');
  await legacyDecisions(deps);
  t.equal(puts, 2, 'after which reads of the same decisions write nothing');

  await decide('usdt', 'mETH', true);
  await legacyDecisions(deps);
  t.equal(puts, 3, 'and the first read of changed decisions records them');
});
