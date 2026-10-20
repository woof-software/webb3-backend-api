import t, { Test } from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';

import * as market from '../../../lib/computations/market.js';
import type * as KnownNetwork from '../../../lib/well-known/networks/network.js';
import { checksumAddress } from '../../../lib/model/comet-registry.js';
import type { ActiveMarketV1, Address, RegistrySnapshotV1, TokenListV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import { setDeprecatedCollateral } from '../../../src/registry/deprecated-collateral-repository.js';
import { DEPRECATED_KEY } from '../../../src/registry/deprecated-collaterals.js';
import { SUMMARY_DEADLINE_MS } from '../../../src/registry/summary-tokens.js';
import { DEADLINE_MS, positionSetOf, positionsOf, recordKey } from '../../../src/registry/token-collateral.js';
import { setTokenPolicy } from '../../../src/registry/token-policy-repository.js';

import { consoleLines } from '../../util/console.js';
import { executionContext } from '../../util/execution-context.js';
import { NodeScript, fakeNode, isValuation, valuations } from '../../util/fake-node.js';
import { MemoryKv } from '../../util/kv.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { COLLATERAL_KEYS, onSummary } from '../../util/summary-token-fields.js';
import { failingStatements, makeTestEnv } from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * What /summary says of the token of each collateral, through the whole
 * worker: the legacy router, the decisions in D1 and the record the worker
 * keeps of the deprecated ones, the token list's record of the chain's minute
 * in KV, and a node behind the node proxy's service binding. What a collateral
 * says of its token across the chain is held to what the token list answers
 * in the same minute.
 */
const fixture = loadRegistrySnapshotFixture();
const LATEST  = { number: 23_500_000, timestamp: 1_791_204_930 };

const MAINNET  = fixture.networks.find(network => network.chainId === 1)!;
const marketOf = (key: string) => MAINNET.markets.find(entry => entry.deploymentKey === key)!;
const tokenOf  = (key: string, symbol: string) => marketOf(key).collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address;
const cometOf  = (key: string) => marketOf(key).contracts.comet!;

const EVERY_NETWORK = '/market/all-networks/all-contracts/summary';
const OF_MAINNET    = '/market/ethereum-mainnet/all-contracts/summary';

let seed = 0;

async function workerOf(t: Test, script: NodeScript = {}, snapshot: RegistrySnapshotV1 = fixture) {
  const registry = await activeRegistryDatabase({ snapshot });
  t.teardown(() => registry.dispose());
  const node = fakeNode(snapshot, LATEST, script);
  const env  = makeTestEnv({
    APP_DB:                           registry.db,
    MEMORY_CACHE_SEED:                `summary-tokens-${seed++}`,
    NODE_PROXY_HOST:                  'node.test',
    NODE_PROXY_KEY:                   'node-key',
    URL_SERVICE_BINDING_OVERRIDES:    [ { host: 'node.test', binding: 'node_provider_proxy' } ],
    node_provider_proxy:              { fetch: node.fetch as typeof fetch },
    // Node takes every computation to be indexed unless told otherwise, which would cache the latest block
    FLAGS_ETH_COMPUTATION_INDEX_BIAS: 'default',
  });
  /*
   * Without an execution context unless a test passes one: the request then
   * answers once what it handed to waitUntil is done, so what it wrote to KV
   * is there for the next one.
   */
  const get = (path: string, overrides: Partial<Env> = {}, context?: ExecutionContext) => (
    C3Api.fetch(new Request(`https://api.test.local${path}`), { ...env, ...overrides }, context)
  );
  return { registry, node, env, get };
}

type Collateral = { address: string, symbol: string, status: string, [field: string]: unknown };
type Entry      = { chain_id: number, comet: { address: string }, deployment_key: string, collaterals?: Collateral[] };

async function summaryOf(response: Response): Promise<Entry[]> {
  if (response.status !== 200) {
    throw new Error(`the summary answered ${response.status}: ${await response.text()}`);
  }
  return await response.json() as Entry[];
}

async function listOf(response: Response): Promise<TokenListV1> {
  if (response.status !== 200) {
    throw new Error(`the token list answered ${response.status}: ${await response.text()}`);
  }
  return await response.json() as TokenListV1;
}

// every collateral of every market of a summary, with its market
const collateralsOf = (entries: Entry[]) => entries.flatMap(entry => (entry.collaterals ?? []).map(collateral => ({ entry, collateral })));
const entryOf       = (entries: Entry[], key: string) => entries.find(entry => entry.chain_id === 1 && entry.deployment_key === key)!;
const collateralOf  = (entry: Entry, symbol: string) => entry.collaterals!.find(collateral => collateral.symbol === symbol)!;
const nameOf        = ({ entry, collateral }: { entry: Entry, collateral: Collateral }) => `${entry.chain_id} ${entry.deployment_key} ${collateral.symbol}`;

const without = (object: object, ...fields: string[]) => Object.fromEntries(Object.entries(object).filter(([ field ]) => !fields.includes(field)));
const picked  = (object: object, ...fields: string[]) => Object.fromEntries(Object.entries(object).filter(([ field ]) => fields.includes(field)));

const decide = (db: D1Database, key: string, symbol: string) => setTokenPolicy(db, {
  chainId:      1,
  tokenAddress: tokenOf(key, symbol),
  isStrategic:  true,
  actor:        'test',
  reason:       'decided for a summary test',
});

const markDeprecated = (db: D1Database, key: string, symbol: string) => setDeprecatedCollateral(db, {
  chainId:      1,
  cometAddress: cometOf(key),
  tokenAddress: tokenOf(key, symbol),
  isDeprecated: true,
  actor:        'test',
  reason:       'decided for a summary test',
});

const FIXED = '0x351a133fd850ea81ed8a782016e308acbaddec91' as Address;

// the fixture with pumpBTC priced through the feed the network's fixed price is stated for, which expires at `expiresAt`, or never
function fixedPumpBtc(expiresAt: string | null): RegistrySnapshotV1 {
  return {
    ...fixture,
    networks: fixture.networks.map(network => network !== MAINNET ? network : {
      ...network,
      priceExceptions: network.priceExceptions.map(exception => exception.priceFeedAddress === FIXED ? { ...exception, expiresAt } : exception),
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

t.test('every form of the summary answers each collateral with the fields of its token, after what was read of it', async t => {
  const { node, get } = await workerOf(t);

  const every    = await summaryOf(await get(EVERY_NETWORK));
  const networks = new Set(every.map(entry => entry.chain_id)).size;
  t.equal(valuations(node).length, networks, 'the collateral of each network is valued in one batch, in a minute nobody had valued');
  for (const read of collateralsOf(every)) {
    t.strictSame(Object.keys(read.collateral), COLLATERAL_KEYS, `${nameOf(read)}: what was read of it, then its token's fields`);
  }

  const mainnet = await summaryOf(await get(OF_MAINNET));
  t.equal(JSON.stringify(mainnet), JSON.stringify(every.filter(entry => entry.chain_id === 1)), 'the summary of a network answers its collaterals alike');
  const alone = await summaryOf(await get(`/market/ethereum-mainnet/${cometOf('usdt')}/summary`));
  t.equal(JSON.stringify(alone), JSON.stringify([ entryOf(every, 'usdt') ]), 'and so does the summary of one market');
  t.equal(valuations(node).length, networks, 'both from the record of the minute, valuing nothing again');
});

/*
 * The summary and the token list answer a minute from one record of the
 * chain. pumpBTC is priced through a price exception of the registry with an
 * expiry, XAUt is strategic, and weETH and mETH are deprecated in USDT's
 * market, so every field the list has is held to something.
 */
t.test('what a collateral says of its token is what the token list says of it in the same minute', async t => {
  const { registry, node, get } = await workerOf(t, {}, fixedPumpBtc('2999-01-01T00:00:00+01:00'));
  await decide(registry.db, 'usdt', 'XAUt');
  await markDeprecated(registry.db, 'usdt', 'weETH');
  await markDeprecated(registry.db, 'usdt', 'mETH');

  const every   = await summaryOf(await get(EVERY_NETWORK));
  const valued  = valuations(node).length;
  for (const chainId of new Set(every.map(entry => entry.chain_id))) {
    const tokens = new Map((await listOf(await get(`/registry/v1/networks/${chainId}/tokens`))).tokens.map(token => [ token.address, token ]));
    for (const read of collateralsOf(every).filter(({ entry }) => entry.chain_id === chainId)) {
      const token = tokens.get(read.collateral.address.toLowerCase() as Address)!;
      t.strictSame(without(read.collateral, 'address', 'symbol', 'status', 'message', 'is_deprecated'), onSummary(token),
        `${nameOf(read)}: as the list says it of ${token.symbol}`);
    }
  }
  t.equal(valuations(node).length, valued, 'the list answers from the record the summary made, valuing nothing again');

  const wbtc = entryOf(every, 'wbtc');
  const { provenance } = MAINNET.priceExceptions.find(exception => exception.priceFeedAddress === FIXED)!;
  t.strictSame(collateralOf(wbtc, 'pumpBTC').network_value_exceptions,
    [ { kind: 'fixed_price', price_feed_address: checksumAddress(FIXED), provenance, expires_at: '2998-12-31T23:00:00.000Z' } ],
    'pumpBTC: the exception that priced it, its feed checksummed and its expiry an instant');
  t.strictSame(picked(collateralOf(entryOf(every, 'usdt'), 'XAUt'), 'is_strategic', 'is_visible', 'visibility_reason'),
    { is_strategic: true, is_visible: true, visibility_reason: 'strategic' }, 'XAUt: strategic, and shown for it');
});

// that an exception never expires is known, so its expiry is null rather than left out as an unknown value is
t.test('an exception that does not expire is answered with a null expiry, not without one', async t => {
  const { get } = await workerOf(t, {}, fixedPumpBtc(null));

  const every = await summaryOf(await get(EVERY_NETWORK));
  const { provenance } = MAINNET.priceExceptions.find(exception => exception.priceFeedAddress === FIXED)!;
  t.strictSame(collateralOf(entryOf(every, 'wbtc'), 'pumpBTC').network_value_exceptions,
    [ { kind: 'fixed_price', price_feed_address: checksumAddress(FIXED), provenance, expires_at: null } ],
    'pumpBTC: the exception that priced it, with a null expiry');
});

/*
 * weETH is a collateral of the USDC, WETH and USDT markets of mainnet, and
 * mETH of the USDT market alone. Deprecated in USDT's, each is deprecated
 * there and nowhere else, as /registry/v1 marks the collaterals of a market;
 * across the chain, mETH is deprecated in every enabled market that takes it,
 * and hidden, while weETH is still offered by two.
 */
t.test('is_deprecated is the decision of the market\'s own Comet, and is_network_deprecated the list\'s across the chain', async t => {
  const { registry, get } = await workerOf(t);
  await markDeprecated(registry.db, 'usdt', 'weETH');
  await markDeprecated(registry.db, 'usdt', 'mETH');

  const mainnet = await summaryOf(await get(OF_MAINNET));
  const usdt    = checksumAddress(cometOf('usdt'));
  const stateOf = (key: string, symbol: string) => {
    const { is_deprecated, is_network_deprecated, deprecated_in, is_visible, visibility_reason } = collateralOf(entryOf(mainnet, key), symbol);
    return { is_deprecated, is_network_deprecated, deprecated_in, is_visible, visibility_reason };
  };
  t.strictSame(stateOf('usdt', 'weETH'),
    { is_deprecated: true, is_network_deprecated: false, deprecated_in: [ usdt ], is_visible: false, visibility_reason: 'below_threshold' },
    'weETH in USDT\'s market: deprecated there, and not across the chain, which decides its visibility by its value');
  for (const key of [ 'usdc', 'weth' ]) {
    t.strictSame(stateOf(key, 'weETH'),
      { is_deprecated: false, is_network_deprecated: false, deprecated_in: [ usdt ], is_visible: false, visibility_reason: 'below_threshold' },
      `weETH in ${key.toUpperCase()}'s market: current there, and the same across the chain`);
  }
  t.strictSame(stateOf('usdt', 'mETH'),
    { is_deprecated: true, is_network_deprecated: true, deprecated_in: [ usdt ], is_visible: false, visibility_reason: 'deprecated' },
    'mETH, which USDT\'s market alone takes: deprecated there and across the chain, and hidden');

  for (const key of [ 'usdc', 'weth', 'usdt', 'wbtc' ]) {
    const { market } = await (await get(`/registry/v1/networks/1/markets/${cometOf(key)}`)).json() as { market: ActiveMarketV1 };
    t.strictSame(entryOf(mainnet, key).collaterals!.map(collateral => [ collateral.symbol, collateral.is_deprecated ]),
      market.collateralAssets.map(asset => [ asset.token.symbol, asset.isDeprecated ]),
      `${key.toUpperCase()}: every collateral as the market read of the registry marks it`);
  }
});

// matches no statement, so that a database fails only while it is down
const NO_STATEMENT = /^$/;

// what the deprecated decisions decide, what the strategic ones decide, and what takes both
const decidedBy = { deprecated: [ 'is_deprecated', 'is_network_deprecated', 'deprecated_in' ], strategic: [ 'is_strategic' ], both: [ 'is_visible', 'visibility_reason' ] };

/*
 * The deprecated decisions are read as the active reads read them: from D1,
 * or, while D1 cannot be reached, from the record the worker keeps of them,
 * and an answer marked with those says that it could not be confirmed. The
 * strategic ones have no record, and what they decide is left out. Either way
 * the summary is answered: a summary is every market's.
 */
t.test('while D1 cannot be reached, the deprecated decisions come from the record and are said to be unconfirmed', async t => {
  const { registry, env, get } = await workerOf(t);
  const logs = consoleLines(t, [ 'error', 'warn' ], { prefixed: true });
  await decide(registry.db, 'usdt', 'XAUt');
  await markDeprecated(registry.db, 'usdt', 'mETH');
  let down = false;
  const db = failingStatements(registry.db, NO_STATEMENT, { down: () => down });

  const confirmed = await get(OF_MAINNET, { APP_DB: db });
  t.same([ confirmed.headers.get('x-registry-stale'), confirmed.headers.get('cache-control') ], [ null, null ],
    'an answer D1 confirmed says nothing of the kind');
  t.same((await env.kv_registry.get(DEPRECATED_KEY, 'json') as { collaterals: unknown[] }).collaterals,
    [ { chainId: 1, cometAddress: cometOf('usdt'), tokenAddress: tokenOf('usdt', 'mETH') } ], 'and records the decisions it read');
  const before = await summaryOf(confirmed);

  const partly = await get(OF_MAINNET, { APP_DB: failingStatements(registry.db, /FROM deprecated_collaterals/) });
  t.same([ partly.headers.get('x-registry-stale'), partly.headers.get('cache-control') ], [ '0', 'no-store' ],
    'decisions D1 did not give, the version it did: the decisions last recorded, said to be no older than now, and not to be kept');
  t.equal(JSON.stringify(await summaryOf(partly)), JSON.stringify(before), 'which mark the collaterals as D1 did');

  down = true;
  const response = await get(OF_MAINNET, { APP_DB: db });
  t.equal(response.status, 200, 'with D1 down, the summary is answered from the version it last named');
  t.match(response.headers.get('x-registry-stale'), /^[0-9]+$/, 'saying how old that version is');
  t.equal(response.headers.get('cache-control'), 'no-store', 'and that nothing may keep it');
  const during = await summaryOf(response);
  t.strictSame(picked(collateralOf(entryOf(during, 'usdt'), 'mETH'), 'is_deprecated', 'is_network_deprecated'),
    { is_deprecated: true, is_network_deprecated: true }, 'its collaterals marked by the decisions last recorded');
  const strategic = [ ...decidedBy.strategic, ...decidedBy.both ];
  for (const read of collateralsOf(during)) {
    t.strictSame(Object.keys(read.collateral), COLLATERAL_KEYS.filter(key => !strategic.includes(key)),
      `${nameOf(read)}: without what the strategic decisions decide`);
  }
  t.strictSame(during.map(entry => ({ ...entry, collaterals: entry.collaterals!.map(collateral => without(collateral, ...strategic)) })),
    before.map(entry => ({ ...entry, collaterals: entry.collaterals!.map(collateral => without(collateral, ...strategic)) })),
    'and everything else as when D1 answered');
  t.ok(logs.some(line => line === 'warn: deprecated collateral decisions unreadable; answering with the ones last recorded'),
    'the log says where the deprecated decisions came from');
  t.ok(logs.some(line => line === 'error: the summary could not read the token policies'), 'and which decisions could not be read');
});

/*
 * A failed read is logged once a minute for each database binding, as the
 * cache logs an outage it answers through, and its fields are left out of
 * every answer all the same.
 */
t.test('decisions that cannot be read leave out what they decide, and are logged under the request', async t => {
  const { registry, get } = await workerOf(t);
  const errors = consoleLines(t, [ 'error' ]);
  await decide(registry.db, 'usdt', 'XAUt');
  await markDeprecated(registry.db, 'usdt', 'mETH');
  const before = await summaryOf(await get(OF_MAINNET));

  const cases = [
    [ 'the deprecated decisions, with none recorded', /FROM deprecated_collaterals/, [ ...decidedBy.deprecated, ...decidedBy.both ], 'deprecated collateral decisions' ],
    [ 'the strategic decisions',                      /FROM token_policies WHERE is_strategic/, [ ...decidedBy.strategic, ...decidedBy.both ], 'token policies' ],
  ] as const;
  for (const [ what, failing, decided, logged ] of cases) {
    errors.length = 0;
    const db       = failingStatements(registry.db, failing);
    const response = await get(OF_MAINNET, { APP_DB: db, kv_registry: MemoryKv({}) });
    t.same([ response.status, response.headers.get('x-registry-stale'), response.headers.get('cache-control') ], [ 200, null, null ],
      `${what}: the summary is answered, and says nothing is unconfirmed`);
    const answered = await summaryOf(response);
    for (const read of collateralsOf(answered)) {
      t.strictSame(Object.keys(read.collateral), COLLATERAL_KEYS.filter(key => !(decided as readonly string[]).includes(key)), `${what}: ${nameOf(read)} without what they decide`);
    }
    t.strictSame(answered.map(entry => ({ ...entry, collaterals: entry.collaterals!.map(collateral => without(collateral, ...decided)) })),
      before.map(entry => ({ ...entry, collaterals: entry.collaterals!.map(collateral => without(collateral, ...decided)) })),
      `${what}: and everything else as when they were read`);
    const at = errors.indexOf(`the summary could not read the ${logged}`);
    t.ok(at >= 0, `${what}: the log says so`);
    t.match(errors[at + 1], /requestId: '[0-9a-f-]{36}'[\s\S]*Network connection lost/, `${what}: with its cause, under the request's id`);

    errors.length = 0;
    const again = await summaryOf(await get(OF_MAINNET, { APP_DB: db, kv_registry: MemoryKv({}) }));
    t.equal(JSON.stringify(again), JSON.stringify(answered), `${what}: a request right after leaves them out as well`);
    t.notOk(errors.includes(`the summary could not read the ${logged}`), `${what}: and is not logged again for that database within a minute`);
  }
});

/*
 * A node that holds the valuation of a minute is waited for no longer than
 * the summary's deadline, shorter than the token list's: the summary answers
 * every market without the values, and the valuation goes on past the answer,
 * so the next request of the minute answers from it.
 */
t.test('a valuation the node holds is waited for two seconds, and the summary answers without its values', async t => {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const { node, get } = await workerOf(t, { hold: request => isValuation(request) ? released : undefined });
  const { context, handed } = executionContext();

  const started  = Date.now();
  const response = await get(EVERY_NETWORK, {}, context);
  const elapsed  = Date.now() - started;
  t.equal(response.status, 200, 'the summary is answered');
  t.ok(elapsed >= SUMMARY_DEADLINE_MS - 20 && elapsed < DEADLINE_MS,
    `having waited ${SUMMARY_DEADLINE_MS} ms for the values, short of the ${DEADLINE_MS} the token list waits (${elapsed} ms)`);
  const held = await summaryOf(response);
  const unknown = [ 'total_network_collateral_value_usd', 'network_value_at', 'network_value_block', 'network_value_stale_age_seconds' ];
  for (const read of collateralsOf(held)) {
    t.strictSame(Object.keys(read.collateral), COLLATERAL_KEYS.filter(key => !unknown.includes(key)), `${nameOf(read)}: without a value nobody could read`);
    t.strictSame(picked(read.collateral, 'total_network_collateral_value_status', 'network_value_exceptions', 'is_visible', 'visibility_reason'),
      { total_network_collateral_value_status: 'unavailable', network_value_exceptions: [], is_visible: true, visibility_reason: 'data_unavailable' },
      `${nameOf(read)}: unavailable, and shown for it`);
  }
  t.ok(handed.some(entry => !entry.settled), 'while the valuation goes on past the answer');

  release();
  await Promise.all(handed.map(entry => entry.work));
  const next = await summaryOf(await get(EVERY_NETWORK));
  t.ok(collateralsOf(next).every(({ collateral }) => collateral.total_network_collateral_value_status === 'fresh'),
    'the next request of the minute answers the values it finished');
  t.equal(valuations(node).length, new Set(next.map(entry => entry.chain_id)).size, 'without valuing them again');
});

/*
 * Nothing of the token list's is cached with the summary's computations: they
 * keep their versions and their keys, and the only records the summary adds
 * are the token list's own, of each chain's minute, which the list answers
 * from. Valuing a chain's collateral is one batch to the node, in a minute
 * nobody has valued.
 */
t.test('the summary keeps the versions and the keys of its computations, and adds the token list\'s records alone', async t => {
  t.equal(market.marketMinutelySummary.version, 9, 'the minutely summary is version 9, as before');
  t.equal(market.marketLatestSummary.version, 5, 'and the latest summary version 5');

  const { node, env, get } = await workerOf(t);
  await summaryOf(await get(EVERY_NETWORK));
  const networks = [ ...new Set(fixture.networks.map(network => network.key)) ];
  for (const network of networks) {
    const requests = node.requests.filter(request => request.network === network);
    t.same([ requests.length, requests.filter(isValuation).length ], [ 5, 1 ],
      `${network}: the latest block, three rounds of reads, and one batch that values its collateral`);
  }

  const catalog = catalogOf(fixture, new Date());
  const minute  = Math.floor(LATEST.timestamp / 60);
  const records = fixture.networks.map(network => recordKey(network.chainId, positionSetOf(positionsOf(catalog, network.key as KnownNetwork.Name)), minute));
  const keysOf  = async (kv: KVNamespace) => (await kv.list()).keys.map(entry => entry.name);
  const written = await keysOf(env.kv_mainnet);
  t.strictSame(written.filter(key => key.startsWith('token-collateral:')).sort(), [ ...records ].sort(), 'one record of each chain\'s minute');
  const others = written.filter(key => !key.startsWith('token-collateral:'));
  t.ok(others.length > 0 && others.every(key => key.startsWith('marketMinutelySummary-v9')), 'beside the minutely summaries of the markets, under the key they had');
  t.ok((await keysOf(env.kv_registry)).every(key => key === 'active:v1' || key === DEPRECATED_KEY || key.startsWith('snapshot:')),
    'and in the registry\'s namespace nothing the active reads do not keep');

  node.requests.length = 0;
  await summaryOf(await get(EVERY_NETWORK));
  t.equal(node.requests.length, networks.length, 'the next request of the minute reads the latest block of each network alone');
  for (const network of fixture.networks) {
    await listOf(await get(`/registry/v1/networks/${network.chainId}/tokens`));
  }
  t.equal(valuations(node).length, 0, 'and the token list answers from the summary\'s records');
  t.strictSame(await keysOf(env.kv_mainnet), written, 'writing none of its own');
});
