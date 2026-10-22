import t, { Test } from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';
import type { ActiveMarketV1, ActiveSnapshotV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';
import { setDeprecatedCollateral } from '../../../src/registry/deprecated-collateral-repository.js';
import {
  DEPRECATED_KEY,
  HIDDEN_KEY,
  deprecatedDecisions,
  hiddenDecisions,
  recordHiddenCollaterals,
} from '../../../src/registry/deprecated-collaterals.js';
import { setHiddenCollateral } from '../../../src/registry/hidden-collateral-repository.js';

import { consoleLines } from '../../util/console.js';
import { executionContext, settledWithin } from '../../util/execution-context.js';
import { MemoryKv } from '../../util/kv.js';
import { quietLog } from '../../util/quiet-log.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { ADMIN_TOKEN, adminTestEnv, failingStatements } from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * What the active reads answer about hidden collaterals, through the worker's
 * own entry point, as they answer about deprecated ones
 * (deprecated-collateral-reads.test.ts): the flag on every collateral of
 * /active and the market reads, after the deprecated one, by the decisions in
 * force when they answer; ETags that name the hidden flags beside the
 * deprecated ones; and when the database cannot be reached, the decisions the
 * Worker last recorded, said to be unconfirmed.
 *
 * Then the record those answers come from, kept as the deprecated decisions'
 * is (deprecated-collaterals.ts): every command that decides records them
 * once it has committed, and before it answers; a read takes them from D1,
 * keeps the record in step, and while D1 cannot be reached answers with the
 * record, saying so. The two kinds keep two records, each in step on its own.
 * How a record is kept in step under load and races is the deprecated kind's
 * to test: the two kinds share that code.
 *
 * Decisions are made through the repository, or through the command where
 * what it records is the point, so nothing here spends the limiter's budget.
 */
let seed = 0;

type Envelope = { error: { code: string, message: string } };

// matches no statement, so that a database fails only while it is down
const NO_STATEMENT = /^$/;

function envOf(db: D1Database, kv: KVNamespace, overrides: Partial<Env> = {}): Promise<Env> {
  return adminTestEnv({
    APP_DB:            db,
    kv_registry:       kv,
    MEMORY_CACHE_SEED: `hidden-collateral-reads-${seed++}`,
    ...overrides,
  });
}

/*
 * Without an execution context, so the request writes the records an outage
 * reads before it answers, not past the answer: what a request records is
 * there for the request after it.
 */
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

// what a command sends, with the token
function command(method: string, path: string, body: unknown): Request {
  return new Request(`https://api.test.local${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

// what the reads of an isolate read the decisions with, and where they warn: nowhere, or into `warnings`
function depsOf(db: D1Database, kv: KVNamespace, warnings?: unknown[]) {
  const debug = warnings === undefined ? quietLog : { error: () => {}, warn: (message: unknown) => { warnings.push(message); } };
  return { db, kv, ttlSeconds: 300, staleSeconds: 3600, debug };
}

// what the worker logged, for the length of a test, each line after its level
function captureLogs(t: Test): string[] {
  return consoleLines(t, [ 'error', 'warn' ], { prefixed: true });
}

const UNAVAILABLE = { name: 'RegistryUnavailable', message: 'the hidden collateral decisions could not be read' };

async function fixture(t: Test) {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const mainnet    = registry.snapshot.networks.find(network => network.chainId === 1)!;
  const market     = (key: string) => mainnet.markets.find(entry => entry.deploymentKey === key)!;
  const collateral = (key: string, symbol: string) => ({
    chainId:      1,
    cometAddress: market(key).contracts.comet!,
    tokenAddress: market(key).collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address,
  });
  const hide = (key: string, symbol: string, isHidden: boolean) => setHiddenCollateral(registry.db, {
    ...collateral(key, symbol),
    isHidden,
    actor:  'test',
    reason: 'decided for a hidden collateral read test',
  });
  const deprecate = (key: string, symbol: string, isDeprecated: boolean) => setDeprecatedCollateral(registry.db, {
    ...collateral(key, symbol),
    isDeprecated,
    actor:  'test',
    reason: 'Linear COM-18',
  });
  return { registry, collateral, hide, deprecate };
}

// the collaterals an answer flags hidden, or deprecated, as `market/symbol`
function flaggedIn(networks: Array<{ markets: ActiveMarketV1[] }>, flag: 'isHidden' | 'isDeprecated' = 'isHidden'): string[] {
  return networks.flatMap(network => network.markets.flatMap(market => market.collateralAssets
    .filter(asset => asset[flag])
    .map(asset => `${market.deploymentKey}/${asset.token.symbol}`)));
}

// the collaterals a record holds, or null where there is none
async function recorded(kv: KVNamespace, key: string): Promise<unknown[] | null> {
  return (await kv.get(key, 'json') as { collaterals: unknown[] } | null)?.collaterals ?? null;
}

// a binding of `store` whose writes wait for `released`, as a namespace slow to take them
function held(store: KVNamespace, released: Promise<void>): KVNamespace {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'put') {
        return async (...parameters: unknown[]) => {
          await released;
          return (value as (...parameters: unknown[]) => Promise<void>).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
}

t.test('the active reads mark every collateral hidden by the decisions in force, apart from the deprecated ones', async t => {
  const { registry, collateral, hide, deprecate } = await fixture(t);
  const env = await envOf(registry.db, MemoryKv({}));

  const before = await json<ActiveSnapshotV1>(env, '/registry/v1/active');
  const assets = before.networks.flatMap(network => network.markets.flatMap(market => market.collateralAssets));
  t.ok(assets.length > 0 && assets.every(asset => asset.isHidden === false), 'no collateral is hidden while nobody has decided');
  t.same(Object.keys(assets[0]!), [ 'assetIndex', 'token', 'priceFeed', 'isDeprecated', 'isHidden' ], 'the flag stands after the deprecated one');

  await hide('usdt', 'mETH', true);
  await hide('usdc', 'weETH', true);
  await deprecate('wbtc', 'LBTC', true);
  const after = await json<ActiveSnapshotV1>(env, '/registry/v1/active');
  t.same(flaggedIn(after.networks), [ 'usdc/weETH', 'usdt/mETH' ], 'the next answer flags each hidden collateral in its own market');
  t.same(flaggedIn(after.networks, 'isDeprecated'), [ 'wbtc/LBTC' ], 'and each deprecated one by its own decisions');

  const markets = await json<{ markets: ActiveMarketV1[] }>(env, '/registry/v1/networks/1/markets');
  t.same(flaggedIn([ markets ]), [ 'usdc/weETH', 'usdt/mETH' ], 'and so does the chain\'s market list');
  const usdt = await json<{ market: ActiveMarketV1 }>(env, `/registry/v1/networks/1/markets/${collateral('usdt', 'mETH').cometAddress}`);
  t.same(flaggedIn([ { markets: [ usdt.market ] } ]), [ 'usdt/mETH' ], 'and the market itself, its own decisions only');
  t.same(flaggedIn([ await json<{ markets: ActiveMarketV1[] }>(env, '/registry/v1/networks/8453/markets') ]), [],
    'while another chain flags nothing');

  const pinned = await json<RegistrySnapshotV1>(env, `/registry/v1/versions/${registry.versionId}`);
  t.same(pinned.networks, registry.snapshot.networks, 'the version read by id is the version as it was imported, without a flag');
});

t.test('a hidden decision changes the tag of every answer whose flags it changes, and of no other', async t => {
  const { registry, collateral, hide, deprecate } = await fixture(t);
  const env   = await envOf(registry.db, MemoryKv({}));
  const tag   = async (path: string) => (await get(env, path)).headers.get('etag')!;
  const paths = [
    '/registry/v1/active',
    '/registry/v1/networks/1/markets',
    `/registry/v1/networks/1/markets/${collateral('usdt', 'mETH').cometAddress}`,
    `/registry/v1/networks/1/markets/${collateral('usdc', 'weETH').cometAddress}`,
    '/registry/v1/networks/8453/markets',
    `/registry/v1/versions/${registry.versionId}`,
    '/registry/v1/networks',
  ];
  const first = Object.fromEntries(await Promise.all(paths.map(async path => [ path, await tag(path) ] as const)));
  t.match(first['/registry/v1/active'], new RegExp(`^"v1-r5-snapshot\\+deprecated-[0-9a-f]{16}\\+hidden-[0-9a-f]{16}-${registry.versionId}-[0-9a-f]{64}"$`),
    'the bootstrap tag names the hidden flags it carries after the deprecated ones');

  await hide('usdt', 'mETH', true);
  const answered = async (path: string, etag: string) => (await get(env, path, { 'If-None-Match': etag })).status;
  for (const path of paths.slice(0, 3)) {
    t.equal(await answered(path, first[path]!), 200, `${path} sends the body again to a client holding a copy without the flag`);
    const next = await tag(path);
    t.not(next, first[path], 'under a new tag');
    t.equal(await answered(path, next), 304, 'which it then confirms');
  }
  for (const path of paths.slice(3)) {
    t.equal(await answered(path, first[path]!), 304, `${path}, which flags nothing the decision changed, still confirms its copy`);
  }
  // the digest of each flag, the deprecated one first
  const digests = (etag: string) => /\+deprecated-([0-9a-f]{16})\+hidden-([0-9a-f]{16})-/.exec(etag)!.slice(1);
  const hidden  = await tag('/registry/v1/active');
  t.same(digests(hidden).map((digest, at) => digest === digests(first['/registry/v1/active']!)[at]), [ true, false ],
    'the decision changes the digest of the hidden flags alone');

  await hide('usdt', 'mETH', false);
  t.equal(await tag('/registry/v1/active'), first['/registry/v1/active'], 'taking the decision back is the first answer again, under its tag');
  await deprecate('usdt', 'mETH', true);
  const deprecated = await tag('/registry/v1/active');
  t.same([ deprecated === first['/registry/v1/active'], deprecated === hidden ], [ false, false ],
    'and the same collateral deprecated rather than hidden is another answer again, under a tag of its own');
});

/*
 * The fallback (cache.ts) answers with the version D1 last named; the hidden
 * flags it marks are the decisions the Worker last recorded, beside the
 * deprecated ones it last recorded.
 */
t.test('during an outage the active reads answer with the hidden decisions last recorded', async t => {
  const { registry, collateral, hide } = await fixture(t);
  const logs = captureLogs(t);
  let down = false;
  const kv  = MemoryKv({});
  const env = await envOf(failingStatements(registry.db, NO_STATEMENT, { down: () => down }), kv);
  const mEth = collateral('usdt', 'mETH');

  await hide('usdt', 'mETH', true);
  t.equal((await get(env, '/registry/v1/active')).status, 200, 'a read while the database answers caches the version');
  t.same(await recorded(kv, HIDDEN_KEY), [ mEth ], 'and records the hidden decisions it read');

  down = true;
  for (const path of [ '/registry/v1/active', '/registry/v1/networks/1/markets', `/registry/v1/networks/1/markets/${mEth.cometAddress}` ]) {
    const response = await get(env, path);
    t.equal(response.status, 200, `${path} answers from the cache`);
    t.match(response.headers.get('x-registry-stale'), /^[0-9]+$/, 'saying how old its answer is');
    t.equal(response.headers.get('cache-control'), 'no-store', 'and that nothing may keep it');
    const body = await response.json() as { networks?: Array<{ markets: ActiveMarketV1[] }>, markets?: ActiveMarketV1[], market?: ActiveMarketV1 };
    t.same(flaggedIn(body.networks ?? [ { markets: body.markets ?? [ body.market! ] } ]), [ 'usdt/mETH' ], 'with the hidden decisions last recorded');
  }
  t.equal(logs.filter(line => line === 'warn: hidden collateral decisions unreadable; answering with the ones last recorded').length, 1,
    'which the log says once a minute, not once a request');
});

t.test('hidden decisions the database does not give are answered from the record, and said to be unconfirmed', async t => {
  const { registry, hide } = await fixture(t);
  const logs = captureLogs(t);
  const kv = MemoryKv({});
  await hide('wbtc', 'LBTC', true);
  await json(await envOf(registry.db, kv), '/registry/v1/active');

  const env = await envOf(failingStatements(registry.db, /FROM hidden_collaterals/), kv);
  const response = await get(env, '/registry/v1/active');
  t.equal(response.status, 200, 'a version the database confirms is answered');
  t.equal(response.headers.get('x-registry-version'), registry.versionId);
  t.equal(response.headers.get('x-registry-stale'), '0', 'as no older than now, since the version is the one on');
  t.equal(response.headers.get('cache-control'), 'no-store', 'but not to be kept, since its hidden flags are as last recorded');
  t.same(flaggedIn((await response.json() as ActiveSnapshotV1).networks), [ 'wbtc/LBTC' ], 'which they are');
  t.equal((await get(env, '/registry/v1/active', { 'If-None-Match': response.headers.get('etag')! })).status, 200,
    'and such an answer confirms no copy');
  t.ok(logs.some(line => line === 'warn: hidden collateral decisions unreadable; answering with the ones last recorded'));
});

/*
 * As for the deprecated decisions: nothing recorded, or a record that is not
 * one, is nothing to answer with, and only a read the version answers waits
 * for the decisions.
 */
t.test('without a record to answer with, hidden decisions the database does not give are a 503', async t => {
  const { registry, collateral, hide } = await fixture(t);
  captureLogs(t);
  await hide('wbtc', 'LBTC', true);
  const failing = failingStatements(registry.db, /FROM hidden_collaterals/);

  for (const path of [ '/registry/v1/active', '/registry/v1/networks/1/markets', `/registry/v1/networks/1/markets/${collateral('wbtc', 'LBTC').cometAddress}` ]) {
    const response = await get(await envOf(failing, MemoryKv({})), path);
    t.same([ response.status, (await response.json() as Envelope).error.code ], [ 503, 'UPSTREAM_UNAVAILABLE' ],
      `${path}: nothing recorded is nothing to answer with`);
  }
  const garbled = MemoryKv({ seed: { [HIDDEN_KEY]: { collaterals: 'not a list' } } });
  t.equal((await get(await envOf(failing, garbled), '/registry/v1/active')).status, 503, 'nor is a record that is not one');
  const refused = await get(await envOf(failing, MemoryKv({})), '/registry/v1/networks/999/markets');
  t.same([ refused.status, (await refused.json() as Envelope).error.code ], [ 404, 'NOT_FOUND' ],
    'while a market read the version refuses is refused as before');
});

/*
 * A command does not leave its record to waitUntil, as a read leaves its
 * check: it answers once the record holds what it committed, so an outage
 * right after it answers with its decision. Each command comes through the
 * worker with an execution context, as in production.
 */
t.test('a command answers once the record holds its hidden decisions, though it has a waitUntil to leave them to', async t => {
  const { registry, collateral } = await fixture(t);
  const weEth = collateral('usdc', 'weETH');
  const mEth  = collateral('usdt', 'mETH');
  const commands = [
    [ 'PATCH', `/registry/v1/admin/networks/1/markets/${weEth.cometAddress}/collaterals/${weEth.tokenAddress}/hidden`,
      { isHidden: true, reason: 'not for discovery' }, [ weEth ] ],
    [ 'POST', '/registry/v1/admin/hidden-collaterals/apply',
      { reason: 'not for discovery', hiddenCollaterals: [ { ...mEth, isHidden: true } ] }, [ mEth, weEth ] ],
  ] as const;

  for (const [ method, path, body, decisions ] of commands) {
    const store = MemoryKv({});
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const env = await envOf(registry.db, held(store, released));
    const { context, handed } = executionContext();
    const answer = C3Api.fetch(command(method, path, body), env, context);
    t.notOk(await settledWithin(answer, 300), `${method} ${path} does not answer while the namespace holds the write of the record`);
    t.equal(handed.length, 0, 'and hands nothing to waitUntil');
    release();
    t.equal((await answer).status, 200, 'it answers once the record is written');
    t.same(await recorded(store, HIDDEN_KEY), decisions, 'with the hidden decisions in force once it committed');
    t.equal(await store.get(DEPRECATED_KEY), null, 'and leaves the record of the deprecated ones alone');
  }
});

/*
 * The record is there for an outage right after the command, before any read
 * has checked it; an environment without a fallback window answers nothing
 * from a record, so its commands keep none.
 */
t.test('a hidden decision a command makes is recorded at once, for an outage to answer with', async t => {
  const { registry, collateral } = await fixture(t);
  captureLogs(t);
  const weEth = collateral('usdc', 'weETH');
  const path  = `/registry/v1/admin/networks/1/markets/${weEth.cometAddress}/collaterals/${weEth.tokenAddress}/hidden`;

  let down = false;
  const kv  = MemoryKv({});
  const db  = failingStatements(registry.db, NO_STATEMENT, { down: () => down });
  const env = await envOf(db, kv);
  t.equal((await C3Api.fetch(command('PATCH', path, { isHidden: true, reason: 'not for discovery' }), env)).status, 200, 'the command commits');

  down = true;
  const read = await hiddenDecisions(depsOf(db, kv));
  t.same([ read.recorded, read.decisions.collaterals ], [ true, [ weEth ] ],
    'and an outage right after it, before any read, answers with its decision');
  t.ok(read.decisions.has(1, weEth.cometAddress, weEth.tokenAddress), 'which marks the collateral in its Comet');
  t.notOk(read.decisions.has(1, collateral('usdt', 'weETH').cometAddress, weEth.tokenAddress), 'and not in another');

  const windowless = MemoryKv({});
  down = false;
  const reversed = await C3Api.fetch(command('PATCH', path, { isHidden: false, reason: 'shown again' }),
    await envOf(registry.db, windowless, { REGISTRY_STALE_FALLBACK_MAX_S: '0' }));
  t.equal(reversed.status, 200, 'a command without a fallback window commits');
  t.equal(await windowless.get(HIDDEN_KEY), null, 'and records nothing');
});

t.test('a read takes the hidden decisions from the database, and from the record while it cannot be reached', async t => {
  const { registry, collateral, hide } = await fixture(t);
  const warnings: unknown[] = [];
  const kv   = MemoryKv({});
  const mEth = collateral('usdt', 'mETH');
  await hide('usdt', 'mETH', true);

  const read = await hiddenDecisions(depsOf(registry.db, kv, warnings));
  t.same([ read.recorded, read.decisions.collaterals ], [ false, [ mEth ] ], 'a read takes the decisions from the database');
  t.same(await recorded(kv, HIDDEN_KEY), [ mEth ], 'and records them');

  const unreachable = failingStatements(registry.db, /FROM hidden_collaterals/);
  const fallback = await hiddenDecisions(depsOf(unreachable, kv, warnings));
  t.same([ fallback.recorded, fallback.decisions.collaterals ], [ true, [ mEth ] ],
    'while the database does not give them, a read answers with the record, and says so');
  await hiddenDecisions(depsOf(unreachable, kv, warnings));
  t.same(warnings, [ 'hidden collateral decisions unreadable; answering with the ones last recorded' ],
    'which the log says once a minute, not once a request');

  await t.rejects(hiddenDecisions(depsOf(unreachable, MemoryKv({}))), UNAVAILABLE, 'with nothing recorded, there is nothing to answer with');
  await t.rejects(hiddenDecisions(depsOf(unreachable, MemoryKv({ seed: { [HIDDEN_KEY]: { collaterals: 'not a list' } } }))), UNAVAILABLE,
    'nor with a record that is not one');

  const windowless = { ...depsOf(registry.db, MemoryKv({})), staleSeconds: 0 };
  await hiddenDecisions(windowless);
  t.equal(await windowless.kv.get(HIDDEN_KEY), null, 'without a window, a read records nothing');
  await t.rejects(
    hiddenDecisions({ ...windowless, db: unreachable }),
    { name: 'RegistryUnavailable', message: 'the comet registry could not be read' },
    'and decisions the database does not give are unavailable there',
  );
});

/*
 * Each kind keeps a record of its own, and what an isolate knows of one says
 * nothing of the other: the record of one kind's decisions, the same as the
 * other's as none are made, is no reason to leave the other's unwritten.
 */
t.test('the hidden and the deprecated decisions are recorded apart', async t => {
  const { registry, collateral, hide } = await fixture(t);
  const kv   = MemoryKv({});
  const deps = depsOf(registry.db, kv);

  await hiddenDecisions(deps);
  await deprecatedDecisions(deps);
  t.same([ await recorded(kv, HIDDEN_KEY), await recorded(kv, DEPRECATED_KEY) ], [ [], [] ],
    'a read of each kind, neither decided, writes each record');

  const mEth = collateral('usdt', 'mETH');
  await hide('usdt', 'mETH', true);
  await setDeprecatedCollateral(registry.db, { ...collateral('usdc', 'weETH'), isDeprecated: true, actor: 'test', reason: 'Linear COM-18' });
  await recordHiddenCollaterals(deps);
  t.same([ await recorded(kv, HIDDEN_KEY), await recorded(kv, DEPRECATED_KEY) ], [ [ mEth ], [] ],
    'a hidden command records the hidden decisions alone');
  t.same((await deprecatedDecisions(deps)).decisions.collaterals, [ collateral('usdc', 'weETH') ],
    'while the deprecated ones are their own');
  t.same((await hiddenDecisions(deps)).decisions.collaterals, [ mEth ], 'as the hidden ones are');
});
