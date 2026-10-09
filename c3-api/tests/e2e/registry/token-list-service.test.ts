import t from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';

import type { RegistrySnapshotV1, TokenListV1, TokenVisibilityV1 } from '../../../lib/model/comet-registry.js';

import { setLegacyCollateral } from '../../../src/registry/legacy-collateral-repository.js';
import { setTokenPolicy } from '../../../src/registry/token-policy-repository.js';

import { FakeNode, NodeScript, batches, fakeNode } from '../../util/fake-node.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { makeTestEnv } from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * The token list through the whole worker, in the order production runs it:
 * the entrypoint and the computations it registers, the registry router's
 * batching evaluator, the per-minute valuation, the policies in D1, the rule
 * and the body. The node is a fake behind the node proxy's service binding, so
 * every value is one the test chose, and asserted to the digit.
 */
const fixture = loadRegistrySnapshotFixture();
const LATEST  = { number: 23_500_000, timestamp: 1_791_204_930 };

const BASE  = 8453;
const AERO  = fixture.networks.find(network => network.chainId === BASE)!.markets[0]!;
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';

const assetOf = (market: RegistrySnapshotV1['networks'][number]['markets'][number], symbol: string) =>
  market.collateralAssets.find(asset => asset.token.symbol === symbol)!;
const units = (amount: bigint, decimals: number) => (amount * 10n ** BigInt(decimals)).toString();

type ErrorBody = { error: { code: string, message: string, requestId: string } };
type Teardown  = { teardown: (fn: () => unknown) => void };

let seed = 0;

async function workerOf(t: Teardown, script: NodeScript = {}, snapshot: RegistrySnapshotV1 = fixture) {
  const registry = await activeRegistryDatabase({ snapshot });
  t.teardown(() => registry.dispose());
  const node = fakeNode(snapshot, LATEST, script);
  const env  = envOf(registry.db, node);
  const get  = (path: string, db?: D1Database) => C3Api.fetch(
    new Request(`https://api.test.local${path}`),
    db === undefined ? env : { ...env, APP_DB: db },
  );
  return { registry, node, env, get };
}

function envOf(db: D1Database, node: FakeNode): Env {
  return makeTestEnv({
    APP_DB:                           db,
    MEMORY_CACHE_SEED:                `token-list-service-${seed++}`,
    NODE_PROXY_HOST:                  'node.test',
    NODE_PROXY_KEY:                   'node-key',
    URL_SERVICE_BINDING_OVERRIDES:    [ { host: 'node.test', binding: 'node_provider_proxy' } ],
    node_provider_proxy:              { fetch: node.fetch as typeof fetch },
    // Node takes every computation to be indexed unless told otherwise, which would cache the latest block
    FLAGS_ETH_COMPUTATION_INDEX_BIAS: 'default',
  });
}

async function listOf(response: Response): Promise<TokenListV1> {
  if (response.status !== 200) {
    throw new Error(`the token list answered ${response.status}: ${await response.text()}`);
  }
  return await response.json() as TokenListV1;
}

const bySymbol = (list: TokenListV1) => new Map<string, TokenVisibilityV1>(list.tokens.map(token => [ token.symbol, token ]));

/*
 * A database whose statements matching `failing` throw what D1 throws when it
 * cannot be reached, and whose other statements answer as before.
 */
function unreachableFor(db: D1Database, failing: RegExp): D1Database {
  const fail = async () => { throw new Error('D1_ERROR: Network connection lost.'); };
  const statement = { bind: () => statement, all: fail, first: fail, run: fail, raw: fail };
  return {
    prepare: (sql: string) => failing.test(sql) ? statement : db.prepare(sql),
    batch:   (statements: D1PreparedStatement[]) => db.batch(statements),
    exec:    (sql: string) => db.exec(sql),
    dump:    () => db.dump(),
  } as unknown as D1Database;
}

// what the worker logged as errors, for the length of a test
function captureErrors(t: Teardown): string[] {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...parameters: unknown[]) => { lines.push(parameters.map(String).join(' ')); };
  t.teardown(() => { console.error = error; });
  return lines;
}

const decide = (db: D1Database, chainId: number, tokenAddress: string, isStrategic: boolean) => setTokenPolicy(db, {
  chainId,
  tokenAddress: tokenAddress as `0x${string}`,
  isStrategic,
  actor:        'test',
  reason:       'decided for a token list test',
});

// 200 WETH at 2500 is visible by its collateral; 1000 USDC at 1 is not
const BASE_NODE: NodeScript = {
  answer: read => {
    const weth = assetOf(AERO, 'WETH');
    const usdc = assetOf(AERO, 'USDC');
    if (read.name === 'totalsCollateral' && read.argument === weth.token.address) return [ units(200n, 18) ];
    if (read.name === 'totalsCollateral' && read.argument === usdc.token.address) return [ units(1_000n, 6) ];
    if (read.name === 'getPrice' && read.argument === weth.priceFeed.address) return [ units(2_500n, weth.priceFeed.decimals) ];
    return undefined;
  },
};

t.test('a chain is valued in one batch through the whole worker, and answered as the contract says', async t => {
  const { registry, node, get } = await workerOf(t, BASE_NODE);

  const response = await get(`/registry/v1/networks/${BASE}/tokens`);
  const list = await listOf(response);
  t.equal(response.headers.get('cache-control'), 'public, max-age=30');
  t.equal(response.headers.get('etag'), null);
  t.equal(response.headers.get('x-registry-version'), registry.versionId);

  t.same(
    { registryVersion: list.registryVersion, chainId: list.chainId, thresholdUsd: list.thresholdUsd, ruleVersion: list.ruleVersion, block: list.block },
    { registryVersion: { id: registry.versionId, checksum: fixture.registryVersion.checksum }, chainId: BASE, thresholdUsd: '250000', ruleVersion: 1, block: LATEST },
  );
  t.equal(new Date(list.computedAt).toISOString(), list.computedAt, 'computedAt is an ISO instant');
  t.equal(node.requests.length, 2, 'the latest block, then every position of the chain in one batch');
  t.equal(batches(node).length, 1);

  const tokens = bySymbol(list);
  t.same(
    [ 'AERO', 'COMP', 'WETH', 'USDC' ].map(symbol => {
      const token = tokens.get(symbol)!;
      return [ symbol, token.roles, token.collateralValueUsd, token.collateralValueStatus, token.isVisible, token.visibilityReason ];
    }),
    [
      [ 'AERO', [ 'base' ],       '0',      'fresh', false, 'below_threshold' ],
      [ 'COMP', [ 'reward' ],     '0',      'fresh', false, 'below_threshold' ],
      [ 'WETH', [ 'collateral' ], '500000', 'fresh', true,  'collateral_threshold' ],
      [ 'USDC', [ 'collateral' ], '1000',   'fresh', false, 'below_threshold' ],
    ],
    'each token is valued exactly and decided by the rule',
  );
  const weth = tokens.get('WETH')!;
  t.same(
    { valueBlock: weth.valueBlock, valueAt: weth.valueAt, staleAgeSeconds: weth.staleAgeSeconds, exceptions: weth.exceptions, isStrategic: weth.isStrategic },
    { valueBlock: LATEST, valueAt: new Date(LATEST.timestamp * 1000).toISOString(), staleAgeSeconds: 0, exceptions: [], isStrategic: false },
  );

  await get(`/registry/v1/networks/${BASE}/tokens`);
  t.equal(batches(node).length, 1, 'the next request of the minute answers from it');
});

t.test('a strategic token is shown below the threshold, and a decision is read on every request', async t => {
  const { registry, get } = await workerOf(t, BASE_NODE);
  const usdc = assetOf(AERO, 'USDC').token.address;
  const visible = async () => (await listOf(await get(`/registry/v1/networks/${BASE}/tokens?visibleOnly=true`))).tokens.map(token => token.symbol);

  t.same(await visible(), [ 'WETH' ], 'visibleOnly lists what discovery shows');

  await decide(registry.db, BASE, usdc, true);
  const decided = bySymbol(await listOf(await get(`/registry/v1/networks/${BASE}/tokens`))).get('USDC')!;
  t.same([ decided.isStrategic, decided.isVisible, decided.visibilityReason, decided.collateralValueUsd ], [ true, true, 'strategic', '1000' ],
    'a strategic token is shown, and its value is still told');
  t.same(await visible(), [ 'USDC', 'WETH' ]);

  await decide(registry.db, BASE, usdc, false);
  t.same(await visible(), [ 'WETH' ], 'a decision taken back is seen by the next request');
});

t.test('a mark belongs to its chain: the same address elsewhere is not strategic', async t => {
  const { registry, get } = await workerOf(t, BASE_NODE);
  await decide(registry.db, 1, CBBTC, true);

  const onBase = bySymbol(await listOf(await get(`/registry/v1/networks/${BASE}/tokens`))).get('cbBTC')!;
  t.equal(onBase.address, CBBTC, 'cbBTC has the same address on Base as on Ethereum');
  t.same([ onBase.isStrategic, onBase.visibilityReason ], [ false, 'below_threshold' ]);
});

t.test('policies the database cannot give are a 503, and are logged', async t => {
  const { registry, get } = await workerOf(t, BASE_NODE);
  const errors = captureErrors(t);

  const response = await get(`/registry/v1/networks/${BASE}/tokens`, unreachableFor(registry.db, /FROM token_policies WHERE chain_id/));
  t.equal(response.status, 503);
  const body = await response.json() as ErrorBody;
  t.same([ body.error.code, body.error.message ], [ 'UPSTREAM_UNAVAILABLE', 'the token policies could not be read' ]);
  t.ok(errors.some(line => line.includes('the token list could not read the token policies')), 'the outage is logged');
  t.ok(errors.some(line => line.includes('Network connection lost') && line.includes(body.error.requestId)),
    'with its cause, under the id the answer names');
});

const MAINNET_MARKETS = fixture.networks.find(network => network.chainId === 1)!.markets;

// marks one collateral of one mainnet market legacy, by the market's deployment key and the token's symbol
const markLegacy = (db: D1Database, key: string, symbol: string, isLegacy: boolean = true) => {
  const market = MAINNET_MARKETS.find(entry => entry.deploymentKey === key)!;
  return setLegacyCollateral(db, {
    chainId:      1,
    cometAddress: market.contracts.comet!,
    tokenAddress: assetOf(market, symbol).token.address,
    isLegacy,
    actor:        'test',
    reason:       'decided for a token list test',
  });
};

/*
 * Legacy collateral (migrations/0006): weETH is a collateral of the USDC,
 * WETH and USDT markets of the fixture's mainnet, and mETH of the USDT market
 * alone. A decision is read on every request, and changes nothing but the two
 * fields that say where a token is legacy.
 */
t.test('a token says where it is a legacy collateral, read on every request, and nothing else changes', async t => {
  const { registry, get } = await workerOf(t);
  const comet = (key: string) => MAINNET_MARKETS.find(entry => entry.deploymentKey === key)!.contracts.comet!;
  const list  = async () => bySymbol(await listOf(await get('/registry/v1/networks/1/tokens')));
  const legacyOf = (tokens: Map<string, TokenVisibilityV1>, symbol: string) => {
    const { isLegacy, legacyIn } = tokens.get(symbol)!;
    return { isLegacy, legacyIn };
  };

  const before = await list();
  t.ok([ ...before.values() ].every(token => token.isLegacy === false && token.legacyIn.length === 0), 'nothing is legacy at first');

  await markLegacy(registry.db, 'usdc', 'weETH');
  await markLegacy(registry.db, 'usdt', 'weETH');
  await markLegacy(registry.db, 'usdt', 'mETH');
  const partly = await list();
  t.same(legacyOf(partly, 'weETH'), { isLegacy: false, legacyIn: [ comet('usdc'), comet('usdt') ].sort() },
    'a token legacy in two of the three enabled markets that take it names the two, and is not legacy');
  t.same(legacyOf(partly, 'mETH'), { isLegacy: true, legacyIn: [ comet('usdt') ] }, 'one legacy in the one market that takes it is');

  await markLegacy(registry.db, 'weth', 'weETH');
  const after = await list();
  t.same(legacyOf(after, 'weETH'), { isLegacy: true, legacyIn: [ comet('usdc'), comet('usdt'), comet('weth') ].sort() },
    'and a token legacy in every enabled market that takes it is legacy, the next request says');

  const rest = (tokens: Map<string, TokenVisibilityV1>) => [ ...tokens.values() ].map(({ isLegacy: _isLegacy, legacyIn: _legacyIn, ...token }) => token);
  t.same(rest(after), rest(before), 'every other field of every token is what it was, whether it is shown included');
});

t.test('legacy decisions the database cannot give are a 503, and are logged', async t => {
  const { registry, get } = await workerOf(t, BASE_NODE);
  const errors = captureErrors(t);

  const response = await get(`/registry/v1/networks/${BASE}/tokens`, unreachableFor(registry.db, /FROM legacy_collaterals\s+WHERE chain_id/));
  t.equal(response.status, 503, 'without them the list would call a legacy collateral current');
  const body = await response.json() as ErrorBody;
  t.same([ body.error.code, body.error.message ], [ 'UPSTREAM_UNAVAILABLE', 'the legacy collateral decisions could not be read' ]);
  t.ok(errors.some(line => line.includes('the token list could not read the legacy collateral decisions')), 'the outage is logged');
  t.ok(errors.some(line => line.includes('Network connection lost') && line.includes(body.error.requestId)),
    'with its cause, under the id the answer names');
});

/*
 * When D1 cannot be reached, the registry answers from the version it last
 * saw, and says so. Such an answer may not be stored, by a browser or
 * anything else: the token list's own short max-age gives way to no-store.
 */
t.test('an answer from a version the database could not confirm is not stored', async t => {
  const { get, registry } = await workerOf(t, BASE_NODE);
  const errors = captureErrors(t);
  await listOf(await get(`/registry/v1/networks/${BASE}/tokens`));

  const response = await get(`/registry/v1/networks/${BASE}/tokens`, unreachableFor(registry.db, /FROM registry_state/));
  const list = await listOf(response);
  t.equal(response.headers.get('cache-control'), 'no-store');
  t.match(response.headers.get('x-registry-stale'), /^[0-9]+$/, 'and it says how old the version is');
  t.equal(list.registryVersion.id, registry.versionId);
  t.equal(bySymbol(list).get('WETH')!.collateralValueUsd, '500000', 'the values are still the current minute\'s');
  t.ok(errors.some(line => line.includes('registry database unreachable; answering from the version it last named')), 'and the fallback is logged');
});

// the security headers every response carries, which tests/e2e/security-headers.test.ts holds to
const SECURITY_HEADERS = new Set([
  'strict-transport-security', 'content-security-policy', 'x-content-type-options',
  'x-frame-options', 'referrer-policy', 'cross-origin-resource-policy',
]);

// what a response says beyond them
const headersOf = (response: Response) => Object.fromEntries([ ...response.headers ].filter(([ name ]) => !SECURITY_HEADERS.has(name)));

/*
 * Whichever way the token list answers, it carries the CORS headers of a
 * public registry read, and once it has read a version it names that version:
 * a refusal after the version was read names it as an answer does, and says
 * so when the database could not confirm it, while a refusal before any
 * version was read names none.
 */
t.test('every answer of the token list names the version it read, and only that', async t => {
  const { registry, env } = await workerOf(t, BASE_NODE);
  captureErrors(t);
  const answer = async (method: string, chainAndQuery: string, db: D1Database = registry.db) => {
    const response = await C3Api.fetch(
      new Request(`https://api.test.local/registry/v1/networks/${chainAndQuery}`, { method }),
      { ...env, APP_DB: db },
    );
    return { status: response.status, headers: headersOf(response) };
  };
  const readable = {
    'access-control-allow-origin':   '*',
    'access-control-expose-headers': 'ETag, X-Registry-Version, X-Registry-Checksum, X-Registry-Stale, Retry-After',
  };
  const json    = { 'content-type': 'application/json; charset=utf-8' };
  const version = { 'x-registry-version': registry.versionId, 'x-registry-checksum': fixture.registryVersion.checksum };
  const tokens  = `${BASE}/tokens`;

  t.same(await answer('GET', tokens), { status: 200, headers: { ...readable, ...json, 'cache-control': 'public, max-age=30', ...version } },
    'a list names the version it was made from, and is kept briefly');
  t.same(await answer('GET', '10/tokens'), { status: 404, headers: { ...readable, ...json, ...version } },
    'a chain the version does not hold is refused under that version');
  t.same(await answer('GET', tokens, unreachableFor(registry.db, /FROM token_policies WHERE chain_id/)),
    { status: 503, headers: { ...readable, ...json, ...version } },
    'and so is a list whose policies could not be read after the version was');
  t.same(await answer('GET', tokens, unreachableFor(registry.db, /FROM legacy_collaterals\s+WHERE chain_id/)),
    { status: 503, headers: { ...readable, ...json, ...version } },
    'or whose legacy collateral decisions could not be');
  t.same(await answer('GET', `${tokens}?visibleOnly=yes`), { status: 400, headers: { ...readable, ...json } },
    'while a request refused before any version was read names none');
  t.same(await answer('OPTIONS', tokens), {
    status:  204,
    headers: {
      ...readable,
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Content-Type, If-None-Match',
      'access-control-max-age':       '86400',
    },
  }, 'and its preflight is the public registry preflight');

  const stale = await answer('GET', tokens, unreachableFor(registry.db, /FROM registry_state|FROM token_policies WHERE chain_id/));
  const { 'x-registry-stale': age, ...rest } = stale.headers;
  t.match(age, /^[0-9]+$/, 'a refusal under a version the database could not confirm says how old it is');
  t.same({ status: stale.status, headers: rest }, { status: 503, headers: { ...readable, ...json, ...version, 'cache-control': 'no-store' } },
    'and that nothing may keep it');
});

const FIXED   = '0x351a133fd850ea81ed8a782016e308acbaddec91';
const MAINNET = fixture.networks.find(network => network.chainId === 1)!;

/*
 * The fixture with pumpBTC priced through the feed the network's fixed price
 * is stated for, and that exception described as `description` says.
 */
function fixedPumpBtc(description: { provenance?: string, expiresAt?: string | null }): RegistrySnapshotV1 {
  return {
    ...fixture,
    networks: fixture.networks.map(network => network !== MAINNET ? network : {
      ...network,
      priceExceptions: network.priceExceptions.map(exception => (
        exception.priceFeedAddress === FIXED ? { ...exception, ...description } : exception
      )),
      markets: network.markets.map(entry => entry.deploymentKey !== 'wbtc' ? entry : {
        ...entry,
        collateralAssets: entry.collateralAssets.map(asset => asset.token.symbol !== 'pumpBTC' ? asset : {
          ...asset,
          priceFeed: { ...asset.priceFeed, address: FIXED },
        }),
      }),
    }),
  };
}

/*
 * Statuses other than fresh, as the body carries them. pumpBTC is priced
 * through the feed the network's fixed price is stated for, with an expiry
 * written with an offset; wstETH's price in the WETH market fails at the node,
 * and what its other two markets hold already reaches the threshold.
 */
t.test('an exception and a partial value reach the body as the rule decided them', async t => {
  const snapshot = fixedPumpBtc({ expiresAt: '2999-01-01T00:00:00+01:00' });
  const market = (key: string) => MAINNET.markets.find(entry => entry.deploymentKey === key)!;
  const wstEth = assetOf(market('usdc'), 'wstETH');
  const comets = { usdc: market('usdc').contracts.comet!, weth: market('weth').contracts.comet!, usdt: market('usdt').contracts.comet! };
  // the node's refusal is logged by the JSON-RPC client, which is not what this test reads
  captureErrors(t);
  const { get } = await workerOf(t, {
    answer: read => {
      if (read.name === 'totalsCollateral' && read.argument === wstEth.token.address && read.comet !== comets.weth) return [ units(100n, 18) ];
      if (read.name === 'getPrice' && read.comet !== comets.weth && read.argument === wstEth.priceFeed.address) return [ units(4_000n, 8) ];
      if (read.name === 'getPrice' && read.comet === comets.weth && read.argument === assetOf(market('weth'), 'wstETH').priceFeed.address) return 'fail';
      return undefined;
    },
  }, snapshot);

  const tokens = bySymbol(await listOf(await get('/registry/v1/networks/1/tokens')));
  const pumpBtc = tokens.get('pumpBTC')!;
  t.equal(pumpBtc.collateralValueStatus, 'exception');
  t.equal(pumpBtc.collateralValueUsd, '1.02447384', 'one pumpBTC at the stated 1.02447384 BTC, at a BTC price of 1');
  t.match(pumpBtc.exceptions, [ { kind: 'fixed_price', priceFeedAddress: FIXED, expiresAt: '2998-12-31T23:00:00.000Z' } ],
    'the exception applied, its expiry written as an instant');

  const partial = tokens.get('wstETH')!;
  t.same(
    [ partial.collateralValueStatus, partial.collateralValueUsd, partial.staleAgeSeconds, partial.isVisible, partial.visibilityReason ],
    [ 'partial', '800000', 0, true, 'collateral_threshold' ],
    'what could be read already reaches the threshold, and is a lower bound (D7)',
  );
});

/*
 * Why an exception was added and until when it applies change no value, so
 * two versions that differ only in them share the minute's record. Each
 * answers with its own description of the exception, whichever valued it.
 */
t.test('an exception is described as the version that answers describes it', async t => {
  const first  = fixedPumpBtc({ provenance: 'as the first version describes it', expiresAt: '2999-01-01T00:00:00.000Z' });
  const edited = fixedPumpBtc({ provenance: 'as the second version describes it', expiresAt: '2999-06-01T00:00:00.000Z' });
  const second = await activeRegistryDatabase({
    snapshot: { ...edited, registryVersion: { ...edited.registryVersion, id: '00000000-0000-4000-8000-0000000000b2' } },
  });
  t.teardown(() => second.dispose());
  const { node, get } = await workerOf(t, {}, first);
  const described = (list: TokenListV1) => bySymbol(list).get('pumpBTC')!.exceptions
    .map(({ provenance, expiresAt }) => ({ provenance, expiresAt }));

  t.same(described(await listOf(await get('/registry/v1/networks/1/tokens'))),
    [ { provenance: 'as the first version describes it', expiresAt: '2999-01-01T00:00:00.000Z' } ]);

  const answered = await listOf(await get('/registry/v1/networks/1/tokens', second.db));
  t.equal(answered.registryVersion.id, second.versionId, 'the second version answers');
  t.equal(batches(node).length, 1, 'from the minute the first one valued');
  t.same(described(answered), [ { provenance: 'as the second version describes it', expiresAt: '2999-06-01T00:00:00.000Z' } ],
    'with its own description of the exception');
});
