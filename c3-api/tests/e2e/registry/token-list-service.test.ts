import t, { Test } from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';

import type { Address, RegistrySnapshotV1, TokenListV1, TokenVisibilityV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import { DEPRECATED_KEY, HIDDEN_KEY } from '../../../src/registry/collateral-decisions.js';
import { DEADLINE_MS, positionSetOf, positionsOf, recordKey } from '../../../src/registry/token-collateral.js';
import { setTokenPolicy } from '../../../src/registry/token-policy-repository.js';

import { consoleLines } from '../../util/console.js';
import { executionContext, settledWithin } from '../../util/execution-context.js';
import { FakeNode, NodeScript, batches, fakeNode } from '../../util/fake-node.js';
import { MemoryKv } from '../../util/kv.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { failingStatements, makeTestEnv } from '../../util/test-env.js';

import type { DecisionKindUnderTest } from './decision-scenarios.js';
import { DEPRECATED_COLLATERALS, HIDDEN_COLLATERALS, TOKEN_POLICIES, statementsOf } from './decision-scenarios.js';

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

// what the worker logged as errors, for the length of a test
function captureErrors(t: Test): string[] {
  return consoleLines(t, [ 'error' ]);
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
    { registryVersion: { id: registry.versionId, checksum: fixture.registryVersion.checksum }, chainId: BASE, thresholdUsd: '250000', ruleVersion: 3, block: LATEST },
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

/*
 * A valuation the request stops waiting for goes on past the answer, because
 * the entrypoint hands the request's execution context to the registry
 * router, and the token list hands the valuation to its waitUntil: the next
 * request of the minute answers from it. The node holds the minute's batch
 * past the deadline, until the test lets it through.
 */
t.test('a valuation the request stopped waiting for is left to waitUntil, and the next request answers from it', async t => {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const { node, env } = await workerOf(t, {
    ...BASE_NODE,
    hold: ({ calls }) => calls[0]!.method === 'eth_getBlockByNumber' ? undefined : released,
  });
  const { context, handed } = executionContext();
  const tokens = () => C3Api.fetch(new Request(`https://api.test.local/registry/v1/networks/${BASE}/tokens`), env, context);
  const weth   = async () => bySymbol(await listOf(await tokens())).get('WETH')!;

  const first = await weth();
  t.same([ first.collateralValueStatus, first.collateralValueUsd ], [ 'unavailable', null ],
    `the first request answers without the minute, after waiting ${DEADLINE_MS} ms for it`);
  t.ok(handed.some(entry => !entry.settled), 'having handed the valuation, still under way, to waitUntil');

  release();
  await Promise.all(handed.map(entry => entry.work));
  const next = await weth();
  t.same([ next.collateralValueStatus, next.collateralValueUsd ], [ 'fresh', '500000' ], 'the next request answers from the minute it finished');
  t.equal(batches(node).length, 1, 'without another batch');
});

/*
 * A namespace over `store` that holds back the writes of the minute records
 * until `release`, and only those: the computation cache writes to the same
 * namespace, and the one write a request is seen to wait for is the record.
 */
function heldMinuteRecords(store: KVNamespace): { kv: KVNamespace, release: () => void } {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const kv = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'put' && typeof(value) === 'function') {
        return async (...parameters: unknown[]) => {
          if (String(parameters[0]).startsWith('token-collateral:')) {
            await released;
          }
          return (value as (...parameters: unknown[]) => unknown).apply(target, parameters);
        };
      }
      return typeof(value) === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as KVNamespace;
  return { kv, release };
}

/*
 * Without an execution context, as a test calls the worker, a request answers
 * once everything it handed to waitUntil is done (entrypoint.ts), the token
 * list's write of the minute's record included, so the record is there for
 * the request after it.
 */
t.test('a request without an execution context answers once the minute\'s record is written', async t => {
  const { env } = await workerOf(t, BASE_NODE);
  const store = MemoryKv({});
  const held  = heldMinuteRecords(store);

  const answer = C3Api.fetch(new Request(`https://api.test.local/registry/v1/networks/${BASE}/tokens`), { ...env, kv_mainnet: held.kv });
  t.notOk(await settledWithin(answer, 300), 'the request waits while the minute\'s record is held');

  held.release();
  t.equal((await answer).status, 200, 'and answers once it is written');
  const positionSet = positionSetOf(positionsOf(catalogOf(fixture, new Date()), 'base-mainnet'));
  t.same((await store.list({ prefix: 'token-collateral:' })).keys.map(entry => entry.name),
    [ recordKey(BASE, positionSet, Math.floor(LATEST.timestamp / 60)) ], 'which is the record of the minute of the latest block');
});

/*
 * A request refused for decisions it could not read answers before its
 * valuation is done (token-handlers.ts), and the valuation hands its record
 * over only once it is: past the answer, which a request without an
 * execution context waits for as well.
 */
t.test('a request without an execution context waits for what its work hands over after the answer', async t => {
  const { registry, env } = await workerOf(t, BASE_NODE);
  captureErrors(t);
  const store = MemoryKv({});
  const held  = heldMinuteRecords(store);

  const answer = C3Api.fetch(new Request(`https://api.test.local/registry/v1/networks/${BASE}/tokens`),
    { ...env, APP_DB: failingStatements(registry.db, statementsOf(TOKEN_POLICIES)), kv_mainnet: held.kv });
  t.notOk(await settledWithin(answer, 300), 'the refusal waits while the record its valuation handed over is held');

  held.release();
  t.equal((await answer).status, 503, 'and is answered once the record is written');
  t.equal((await store.list({ prefix: 'token-collateral:' })).keys.length, 1, 'the one record of the minute');
});

t.test('a strategic token is shown below the threshold, and a decision is read on every request', async t => {
  const { registry, get } = await workerOf(t, BASE_NODE);
  const usdc = assetOf(AERO, 'USDC').token.address;
  const visible = async () => (await listOf(await get(`/registry/v1/networks/${BASE}/tokens?visibleOnly=true`))).tokens.map(token => token.symbol);

  t.same(await visible(), [ 'WETH' ], 'visibleOnly lists what discovery shows');

  await decide(registry.db, BASE, usdc, true);
  const listed  = await listOf(await get(`/registry/v1/networks/${BASE}/tokens`));
  const decided = bySymbol(listed).get('USDC')!;
  t.same([ decided.isStrategic, decided.isVisible, decided.visibilityReason, decided.collateralValueUsd ], [ true, true, 'strategic', '1000' ],
    'a strategic token is shown, and its value is still told');
  t.same(await visible(), [ 'USDC', 'WETH' ]);
  t.equal((await listOf(await get(`/registry/v1/networks/${BASE}/tokens?visibleOnly=false`))).tokens.length, listed.tokens.length,
    'visibleOnly=false lists every token');

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

  const response = await get(`/registry/v1/networks/${BASE}/tokens`, failingStatements(registry.db, statementsOf(TOKEN_POLICIES)));
  t.equal(response.status, 503);
  const body = await response.json() as ErrorBody;
  t.same([ body.error.code, body.error.message ], [ 'UPSTREAM_UNAVAILABLE', 'the token policies could not be read' ]);
  t.ok(errors.some(line => line.includes('the token list could not read the token policies')), 'the outage is logged');
  t.ok(errors.some(line => line.includes('Network connection lost') && line.includes(body.error.requestId)),
    'with its cause, under the id the answer names');
});

const MAINNET_MARKETS = fixture.networks.find(network => network.chainId === 1)!.markets;

// a kind of decision about a collateral, as the token list answers for it
type ListedKind = {
  decisions:  DecisionKindUnderTest,
  // the record the active reads keep of the kind's decisions
  key:        string,
  // the fields a token says the kind's decisions in, as they are for the Comets that decided, and for every enabled market that takes it
  fields:     Array<keyof TokenVisibilityV1>,
  marks:      (comets: Address[], everywhere: boolean) => Partial<TokenVisibilityV1>,
  // the reason a token decided about across the chain is given
  reason:     string,
  // in the names of the tests: once a token is not shown, what a market's decision does to it, and why the list cannot answer without them
  everywhere: string,
  does:       string,
  unread:     string,
};

const DEPRECATED_LISTED: ListedKind = {
  decisions:  DEPRECATED_COLLATERALS,
  key:        DEPRECATED_KEY,
  fields:     [ 'isDeprecated', 'deprecatedIn' ],
  marks:      (comets, everywhere) => ({ isDeprecated: everywhere, deprecatedIn: comets }),
  reason:     'deprecated',
  everywhere: 'an enabled market takes it and every one that does has it deprecated',
  does:       'has it deprecated',
  unread:     'without them the list would call a deprecated collateral current, and show a token discovery does not',
};

// a token the list does not show for its hidden decisions says so only by its reason: it has no flag of its own for them
const HIDDEN_LISTED: ListedKind = {
  decisions:  HIDDEN_COLLATERALS,
  key:        HIDDEN_KEY,
  fields:     [ 'hiddenIn' ],
  marks:      comets => ({ hiddenIn: comets }),
  reason:     'hidden',
  everywhere: 'an enabled market that takes it hides it, and every other one hides it or has it deprecated',
  does:       'hides it',
  unread:     'without them the list would show a token an administrator hid',
};

const LISTED_KINDS = [ [ DEPRECATED_LISTED, HIDDEN_LISTED ], [ HIDDEN_LISTED, DEPRECATED_LISTED ] ] as const;

// a decision about one collateral of one mainnet market, by the market's deployment key and the token's symbol
const mark = (db: D1Database, listed: ListedKind, key: string, symbol: string, flag: boolean = true) => {
  const market = MAINNET_MARKETS.find(entry => entry.deploymentKey === key)!;
  return listed.decisions.set(db, {
    subject: { cometAddress: market.contracts.comet!, tokenAddress: assetOf(market, symbol).token.address },
    flag,
    actor:   'test',
    reason:  'decided for a token list test',
  });
};

const fieldsOf = (listed: ListedKind, token: TokenVisibilityV1) => Object.fromEntries(listed.fields.map(field => [ field, token[field] ]));

/*
 * Deprecated and hidden collateral (migrations 0006 to 0008), each kind
 * decided about alone and beside the other: weETH is a collateral of the
 * USDC, WETH and USDT markets of the fixture's mainnet, and mETH of the USDT
 * market alone. Both are strategic here, so discovery shows them whatever
 * they are worth, until a token is deprecated in every enabled market that
 * takes it, or an enabled market that takes it hides it and every other one
 * hides it or has it deprecated; either is asked before whether it is
 * strategic. A decision is read on every request, and changes nothing but
 * the fields that say where a token is decided about and, for a token
 * decided about across the chain, whether it is shown.
 */
for (const [ listed, other ] of LISTED_KINDS) {
  const { adjective } = listed.decisions;
  t.test(`a token says where it is a ${adjective} collateral, and is not shown once ${listed.everywhere}`, async t => {
    const { registry, get } = await workerOf(t);
    const comet   = (key: string) => MAINNET_MARKETS.find(entry => entry.deploymentKey === key)!.contracts.comet!;
    const token   = (key: string, symbol: string) => assetOf(MAINNET_MARKETS.find(entry => entry.deploymentKey === key)!, symbol).token.address;
    const list    = async () => bySymbol(await listOf(await get('/registry/v1/networks/1/tokens')));
    const visible = async () => (await listOf(await get('/registry/v1/networks/1/tokens?visibleOnly=true'))).tokens.map(entry => entry.symbol);
    const stateOf = (tokens: Map<string, TokenVisibilityV1>, symbol: string) => {
      const entry = tokens.get(symbol)!;
      return { ...fieldsOf(listed, entry), isVisible: entry.isVisible, visibilityReason: entry.visibilityReason };
    };

    await decide(registry.db, 1, token('usdt', 'mETH'), true);
    await decide(registry.db, 1, token('usdt', 'weETH'), true);
    const before = await list();
    t.same([ ...before.values() ].map(entry => fieldsOf(listed, entry)), [ ...before.values() ].map(() => listed.marks([], false)),
      `nothing is ${adjective} at first`);
    t.same(await visible(), [ 'mETH', 'weETH' ], 'and discovery shows the two strategic tokens');

    await mark(registry.db, listed, 'usdc', 'weETH');
    await mark(registry.db, listed, 'usdt', 'weETH');
    await mark(registry.db, listed, 'usdt', 'mETH');
    const partly = await list();
    t.same(stateOf(partly, 'weETH'), { ...listed.marks([ comet('usdc'), comet('usdt') ].sort(), false), isVisible: true, visibilityReason: 'strategic' },
      `a token ${adjective} in two of the three enabled markets that take it names the two, and is shown as before`);
    t.same(stateOf(partly, 'mETH'), { ...listed.marks([ comet('usdt') ], true), isVisible: false, visibilityReason: listed.reason },
      `one ${adjective} in the one market that takes it is not shown, strategic as it is`);
    t.same(await visible(), [ 'weETH' ], 'and visibleOnly leaves it out');

    await mark(registry.db, other, 'weth', 'weETH');
    const mixed = (await list()).get('weETH')!;
    t.same(
      { ...fieldsOf(listed, mixed), ...fieldsOf(other, mixed), isVisible: mixed.isVisible, visibilityReason: mixed.visibilityReason },
      { ...listed.marks([ comet('usdc'), comet('usdt') ].sort(), false), ...other.marks([ comet('weth') ], false), isVisible: false, visibilityReason: 'hidden' },
      `weETH, ${adjective} in two of them, is not shown once the third ${other.does}, though not deprecated in every one: none of them offers it and leaves it to discovery`,
    );
    await mark(registry.db, other, 'weth', 'weETH', false);

    await mark(registry.db, listed, 'weth', 'weETH');
    const after = await list();
    t.same(stateOf(after, 'weETH'),
      { ...listed.marks([ comet('usdc'), comet('usdt'), comet('weth') ].sort(), true), isVisible: false, visibilityReason: listed.reason },
      `a token ${adjective} in every enabled market that takes it is not shown, the next request says`);
    t.same(await visible(), [], 'which leaves discovery nothing to show');

    const decided = [ 'mETH', 'weETH' ];
    const shown = (tokens: Map<string, TokenVisibilityV1>) => [ ...tokens.values() ]
      .filter(entry => !decided.includes(entry.symbol))
      .map(entry => [ entry.symbol, entry.isVisible, entry.visibilityReason ]);
    t.same(shown(after), shown(before), 'every other token is shown or not as it was');
    const ruled = new Set<string>([ ...listed.fields, 'isVisible', 'visibilityReason' ]);
    const rest  = (tokens: Map<string, TokenVisibilityV1>) => [ ...tokens.values() ]
      .map(entry => Object.fromEntries(Object.entries(entry).filter(([ field ]) => !ruled.has(field))));
    t.same(rest(after), rest(before),
      `and every other field of every token is what it was, its value and its ${other.decisions.adjective} decisions included`);

    await mark(registry.db, listed, 'weth', 'weETH', false);
    t.same(await visible(), [ 'weETH' ], 'a decision taken back shows the token again');
  });
}

/*
 * The list reads each kind's decisions from the database on every request,
 * and does not answer from the record the active reads keep of them.
 */
for (const [ listed ] of LISTED_KINDS) {
  const { adjective, label } = listed.decisions;
  t.test(`${label} decisions the database cannot give are a 503, and are logged`, async t => {
    const { registry, env, get } = await workerOf(t, BASE_NODE);
    const errors = captureErrors(t);
    t.equal((await get('/registry/v1/active')).status, 200, 'a read of the active version');
    t.not(await env.kv_registry.get(listed.key), null, `records the ${adjective} decisions`);

    const response = await get(`/registry/v1/networks/${BASE}/tokens`, failingStatements(registry.db, statementsOf(listed.decisions)));
    t.equal(response.status, 503, listed.unread);
    const body = await response.json() as ErrorBody;
    t.same([ body.error.code, body.error.message ], [ 'UPSTREAM_UNAVAILABLE', `the ${label} decisions could not be read` ]);
    t.ok(errors.some(line => line.includes(`the token list could not read the ${label} decisions`)), 'the outage is logged');
    t.ok(errors.some(line => line.includes('Network connection lost') && line.includes(body.error.requestId)),
      'with its cause, under the id the answer names');
  });
}

/*
 * When D1 cannot be reached, the registry answers from the version it last
 * saw, and says so. Such an answer may not be stored, by a browser or
 * anything else: the token list's own short max-age gives way to no-store.
 */
t.test('an answer from a version the database could not confirm is not stored', async t => {
  const { get, registry } = await workerOf(t, BASE_NODE);
  const errors = captureErrors(t);
  await listOf(await get(`/registry/v1/networks/${BASE}/tokens`));

  const response = await get(`/registry/v1/networks/${BASE}/tokens`, failingStatements(registry.db, /FROM registry_state/));
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
  t.same(await answer('GET', tokens, failingStatements(registry.db, statementsOf(TOKEN_POLICIES))),
    { status: 503, headers: { ...readable, ...json, ...version } },
    'and so is a list whose policies could not be read after the version was');
  t.same(await answer('GET', tokens, failingStatements(registry.db, statementsOf(DEPRECATED_COLLATERALS))),
    { status: 503, headers: { ...readable, ...json, ...version } },
    'or whose deprecated collateral decisions could not be');
  t.same(await answer('GET', tokens, failingStatements(registry.db, statementsOf(HIDDEN_COLLATERALS))),
    { status: 503, headers: { ...readable, ...json, ...version } },
    'or whose hidden collateral decisions could not be');
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

  const stale = await answer('GET', tokens, failingStatements(failingStatements(registry.db, /FROM registry_state/), statementsOf(TOKEN_POLICIES)));
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
