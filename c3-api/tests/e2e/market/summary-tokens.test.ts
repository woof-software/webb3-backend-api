import t, { Test } from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';

import * as market from '../../../lib/computations/market.js';
import type * as KnownNetwork from '../../../lib/well-known/networks/network.js';
import { checksumAddress } from '../../../lib/model/comet-registry.js';
import type { ActiveMarketV1, Address, RegistrySnapshotV1, TokenListV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import {
  DEPRECATED_COLLATERAL_KIND,
  HIDDEN_COLLATERAL_KIND,
  setCollateral,
} from '../../../src/registry/collateral-decision-repository.js';
import { DEPRECATED_KEY, HIDDEN_KEY } from '../../../src/registry/collateral-decisions.js';
import { SUMMARY_DEADLINE_MS } from '../../../src/registry/summary-tokens.js';
import { DEADLINE_MS, positionSetOf, positionsOf, recordKey } from '../../../src/registry/token-collateral.js';
import { setTokenPolicy } from '../../../src/registry/token-policy-repository.js';

import { consoleLines } from '../../util/console.js';
import { executionContext } from '../../util/execution-context.js';
import { NodeScript, fakeNode, isValuation, valuations } from '../../util/fake-node.js';
import { MemoryKv } from '../../util/kv.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { COLLATERAL_KEYS, onSummary, visibilityOnSummary } from '../../util/summary-token-fields.js';
import { failingStatements, makeTestEnv } from '../../util/test-env.js';

import { DEPRECATED_COLLATERALS, HIDDEN_COLLATERALS, TOKEN_POLICIES, statementsOf } from '../registry/decision-scenarios.js';

import '../../../shim/node-self.js';

/*
 * What /summary says of the token of each collateral, through the whole
 * worker: the legacy router, the decisions in D1 and the records the worker
 * keeps of the deprecated and the hidden ones, the token list's record of the
 * chain's minute in KV, and a node behind the node proxy's service binding.
 * What a collateral says of its token across the chain is held to what the
 * token list answers in the same minute.
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

// `migrated` stops the database's migrations at `through`, as a release deployed before its own finds it
async function workerOf(t: Test, script: NodeScript = {}, snapshot: RegistrySnapshotV1 = fixture, migrated: { through?: string } = {}) {
  const registry = await activeRegistryDatabase({ snapshot, ...migrated });
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

const markDeprecated = (db: D1Database, key: string, symbol: string) => setCollateral(db, DEPRECATED_COLLATERAL_KIND, {
  chainId:      1,
  cometAddress: cometOf(key),
  tokenAddress: tokenOf(key, symbol),
  isDeprecated: true,
  actor:        'test',
  reason:       'decided for a summary test',
});

const hide = (db: D1Database, key: string, symbol: string) => setCollateral(db, HIDDEN_COLLATERAL_KIND, {
  chainId:      1,
  cometAddress: cometOf(key),
  tokenAddress: tokenOf(key, symbol),
  isHidden:     true,
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
 * expiry, XAUt is strategic, weETH and mETH are deprecated in USDT's market,
 * and weETH is hidden in USDC's, so every field the list has is held to
 * something.
 */
t.test('what a collateral says of its token is what the token list says of it in the same minute', async t => {
  const { registry, node, get } = await workerOf(t, {}, fixedPumpBtc('2999-01-01T00:00:00+01:00'));
  await decide(registry.db, 'usdt', 'XAUt');
  await markDeprecated(registry.db, 'usdt', 'weETH');
  await markDeprecated(registry.db, 'usdt', 'mETH');
  await hide(registry.db, 'usdc', 'weETH');

  const every   = await summaryOf(await get(EVERY_NETWORK));
  const valued  = valuations(node).length;
  for (const chainId of new Set(every.map(entry => entry.chain_id))) {
    const tokens = new Map((await listOf(await get(`/registry/v1/networks/${chainId}/tokens`))).tokens.map(token => [ token.address, token ]));
    for (const read of collateralsOf(every).filter(({ entry }) => entry.chain_id === chainId)) {
      const token          = tokens.get(read.collateral.address.toLowerCase() as Address)!;
      const onMainnet      = read.entry.chain_id === 1;
      const hiddenHere     = onMainnet && read.entry.deployment_key === 'usdc' && read.collateral.symbol === 'weETH';
      const deprecatedHere = onMainnet && read.entry.deployment_key === 'usdt' && [ 'weETH', 'mETH' ].includes(read.collateral.symbol);
      t.equal(read.collateral.is_hidden, hiddenHere, `${nameOf(read)}: ${hiddenHere ? 'hidden, as its Comet decided' : 'not hidden, which nobody decided'}`);
      t.equal(read.collateral.is_deprecated, deprecatedHere,
        `${nameOf(read)}: ${deprecatedHere ? 'deprecated, as its Comet decided' : 'not deprecated, which nobody decided'}`);
      t.strictSame(without(read.collateral, 'address', 'symbol', 'status', 'message', 'is_deprecated', 'is_hidden'),
        onSummary(token, { isHidden: hiddenHere, isDeprecated: deprecatedHere }), `${nameOf(read)}: as the list says it of ${token.symbol}`);
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
 * there and nowhere else, as /registry/v1 marks the collaterals of a market,
 * and is not shown there: whether discovery shows a token is the market's own.
 * Across the chain, mETH is deprecated in every enabled market that takes it,
 * and not shown, while weETH is still offered by two.
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
    { is_deprecated: true, is_network_deprecated: false, deprecated_in: [ usdt ], is_visible: false, visibility_reason: 'deprecated' },
    'weETH in USDT\'s market: deprecated there, and so not shown there, though not deprecated across the chain');
  for (const key of [ 'usdc', 'weth' ]) {
    t.strictSame(stateOf(key, 'weETH'),
      { is_deprecated: false, is_network_deprecated: false, deprecated_in: [ usdt ], is_visible: false, visibility_reason: 'below_threshold' },
      `weETH in ${key.toUpperCase()}'s market: current there, and the same across the chain`);
  }
  t.strictSame(stateOf('usdt', 'mETH'),
    { is_deprecated: true, is_network_deprecated: true, deprecated_in: [ usdt ], is_visible: false, visibility_reason: 'deprecated' },
    'mETH, which USDT\'s market alone takes: deprecated there and across the chain, and not shown');

  for (const key of [ 'usdc', 'weth', 'usdt', 'wbtc' ]) {
    const { market } = await (await get(`/registry/v1/networks/1/markets/${cometOf(key)}`)).json() as { market: ActiveMarketV1 };
    t.strictSame(entryOf(mainnet, key).collaterals!.map(collateral => [ collateral.symbol, collateral.is_deprecated ]),
      market.collateralAssets.map(asset => [ asset.token.symbol, asset.isDeprecated ]),
      `${key.toUpperCase()}: every collateral as the market read of the registry marks it`);
  }
});

/*
 * A collateral is hidden as it is deprecated, by one Comet, and whether
 * discovery shows the token is the market's own on the summary: weETH,
 * strategic here, is hidden in USDC's market only, so it is not shown there
 * while WETH's and USDT's markets show it, as the list does across the chain.
 * mETH, hidden in USDT's, the one market that takes it, is not shown there
 * nor by the list.
 */
t.test('is_hidden is the decision of the market\'s own Comet, and is_visible what discovery shows in that market', async t => {
  const { registry, get } = await workerOf(t);
  await decide(registry.db, 'usdt', 'weETH');
  await hide(registry.db, 'usdc', 'weETH');
  await hide(registry.db, 'usdt', 'mETH');

  const mainnet = await summaryOf(await get(OF_MAINNET));
  const [ usdc, usdt ] = [ checksumAddress(cometOf('usdc')), checksumAddress(cometOf('usdt')) ];
  const stateOf = (key: string, symbol: string) => picked(collateralOf(entryOf(mainnet, key), symbol), 'is_hidden', 'hidden_in', 'is_visible', 'visibility_reason');
  t.strictSame(stateOf('usdc', 'weETH'), { is_hidden: true, hidden_in: [ usdc ], is_visible: false, visibility_reason: 'hidden' },
    'weETH in USDC\'s market: hidden there, and not shown in it');
  for (const key of [ 'weth', 'usdt' ]) {
    t.strictSame(stateOf(key, 'weETH'), { is_hidden: false, hidden_in: [ usdc ], is_visible: true, visibility_reason: 'strategic' },
      `weETH in ${key.toUpperCase()}'s market: not hidden there, and shown for being strategic`);
  }
  t.strictSame(stateOf('usdt', 'mETH'), { is_hidden: true, hidden_in: [ usdt ], is_visible: false, visibility_reason: 'hidden' },
    'mETH, which USDT\'s market alone takes: hidden there, and not shown');

  const tokens = new Map((await listOf(await get('/registry/v1/networks/1/tokens'))).tokens.map(token => [ token.symbol, token ]));
  t.strictSame([ 'weETH', 'mETH' ].map(symbol => picked(tokens.get(symbol)!, 'hiddenIn', 'isVisible', 'visibilityReason')), [
    { hiddenIn: [ cometOf('usdc') ], isVisible: true, visibilityReason: 'strategic' },
    { hiddenIn: [ cometOf('usdt') ], isVisible: false, visibilityReason: 'hidden' },
  ], 'while the list says it of the chain: weETH shown, which two enabled markets still do not hide, and mETH not');

  for (const key of [ 'usdc', 'weth', 'usdt', 'wbtc' ]) {
    const { market } = await (await get(`/registry/v1/networks/1/markets/${cometOf(key)}`)).json() as { market: ActiveMarketV1 };
    t.strictSame(entryOf(mainnet, key).collaterals!.map(collateral => [ collateral.symbol, collateral.is_hidden ]),
      market.collateralAssets.map(asset => [ asset.token.symbol, asset.isHidden ]),
      `${key.toUpperCase()}: every collateral as the market read of the registry marks it`);
  }

  // the Comet named checksummed, as a client may name it
  for (const key of [ 'usdc', 'weth' ]) {
    const alone = await summaryOf(await get(`/market/ethereum-mainnet/${checksumAddress(cometOf(key))}/summary`));
    t.equal(JSON.stringify(alone), JSON.stringify([ entryOf(mainnet, key) ]),
      `the summary of ${key.toUpperCase()}'s market alone answers it as the summary of the network does, by its own Comet's decisions`);
  }
});

/*
 * Where a market's status is deprecated, its Comet's decision may differ from
 * the enabled markets': here USDT's market is deprecated. weETH, strategic,
 * is hidden in the USDC and WETH markets, the enabled ones that take it, so
 * the list does not show it, while USDT's market does not hide it, and the
 * rest of the rule shows it there. mETH, strategic as well, is taken by
 * USDT's market alone, which hides it and does not show it, while no enabled
 * market takes it, and the list shows it.
 */
t.test('a market whose status is deprecated answers by its own Comet\'s decision where the enabled markets decide otherwise', async t => {
  const snapshot: RegistrySnapshotV1 = {
    ...fixture,
    networks: fixture.networks.map(network => network !== MAINNET ? network : {
      ...network,
      markets: network.markets.map(entry => entry.deploymentKey === 'usdt' ? { ...entry, status: 'deprecated' as const } : entry),
    }),
  };
  const { registry, get } = await workerOf(t, {}, snapshot);
  await decide(registry.db, 'usdt', 'weETH');
  await decide(registry.db, 'usdt', 'mETH');
  await hide(registry.db, 'usdc', 'weETH');
  await hide(registry.db, 'weth', 'weETH');
  await hide(registry.db, 'usdt', 'mETH');

  const tokens = new Map((await listOf(await get('/registry/v1/networks/1/tokens'))).tokens.map(token => [ token.symbol, token ]));
  t.strictSame([ 'weETH', 'mETH' ].map(symbol => picked(tokens.get(symbol)!, 'hiddenIn', 'isVisible', 'visibilityReason')), [
    { hiddenIn: [ cometOf('usdc'), cometOf('weth') ].sort(), isVisible: false, visibilityReason: 'hidden' },
    { hiddenIn: [ cometOf('usdt') ], isVisible: true, visibilityReason: 'strategic' },
  ], 'the list does not show weETH, which every enabled market that takes it hides, and shows mETH, which no enabled market takes');

  const mainnet  = await summaryOf(await get(OF_MAINNET));
  const stateOf  = (key: string, symbol: string) => picked(collateralOf(entryOf(mainnet, key), symbol), 'is_hidden', 'hidden_in', 'is_visible', 'visibility_reason');
  const hiddenIn = tokens.get('weETH')!.hiddenIn.map(address => checksumAddress(address));
  for (const key of [ 'usdc', 'weth' ]) {
    t.strictSame(stateOf(key, 'weETH'), { is_hidden: true, hidden_in: hiddenIn, is_visible: false, visibility_reason: 'hidden' },
      `weETH in ${key.toUpperCase()}'s market: hidden there, and not shown in it`);
  }
  t.strictSame(stateOf('usdt', 'weETH'), { is_hidden: false, hidden_in: hiddenIn, is_visible: true, visibility_reason: 'strategic' },
    'weETH in USDT\'s market: not hidden there, and shown for being strategic, where the list does not show it');
  t.strictSame(stateOf('usdt', 'mETH'), { is_hidden: true, hidden_in: [ checksumAddress(cometOf('usdt')) ], is_visible: false, visibility_reason: 'hidden' },
    'mETH in USDT\'s market: hidden there, and not shown in it, where the list shows it');
});

// matches no statement, so that a database fails only while it is down
const NO_STATEMENT = /^$/;

// what each kind of decision decides, and the two fields every kind takes part in: whether the token is shown, and why
const decidedBy = {
  deprecated: [ 'is_deprecated', 'is_network_deprecated', 'deprecated_in' ],
  hidden:     [ 'is_hidden', 'hidden_in' ],
  strategic:  [ 'is_strategic' ],
  shown:      [ 'is_visible' ],
  why:        [ 'visibility_reason' ],
};

// a kind of decision the summary may not have read
type Unread = 'deprecated' | 'hidden' | 'strategic';

/*
 * A collateral a summary answered with every decision read, as a summary
 * answers it while the kinds named cannot be read: without what they decide,
 * and saying whether its token is shown, and why, only where the decisions
 * read settle it whichever way the others went (visibilityOnSummary), each as
 * when every decision was read.
 */
function unreadOf(collateral: Collateral, unread: readonly Unread[]): Collateral {
  const settled = visibilityOnSummary({
    isHidden:     unread.includes('hidden')     ? null : collateral.is_hidden as boolean,
    isDeprecated: unread.includes('deprecated') ? null : collateral.is_deprecated as boolean,
    isStrategic:  unread.includes('strategic')  ? null : collateral.is_strategic as boolean,
  }, (collateral.total_network_collateral_value_usd as string | undefined) ?? null);
  const unsettled = [ ...decidedBy.shown, ...decidedBy.why ].filter(field => !(field in settled));
  return without(collateral, ...unread.flatMap(kind => decidedBy[kind]), ...unsettled) as Collateral;
}

// a summary answered with every decision read, as unreadOf answers each collateral
const unreadSummary = (entries: Entry[], unread: readonly Unread[]): Entry[] => entries.map(entry => ({
  ...entry,
  collaterals: entry.collaterals!.map(collateral => unreadOf(collateral, unread)),
}));

// every collateral of a summary answered with every decision read, by name, as unreadOf answers it
const unreadCollaterals = (entries: Entry[], unread: readonly Unread[]) => new Map(collateralsOf(unreadSummary(entries, unread)).map(read => (
  [ nameOf(read), read.collateral ]
)));

// the fields of a collateral in the order the summary writes them, the message of one that is `error` after its status
const keysOf = (collateral: Collateral) => COLLATERAL_KEYS
  .flatMap((key): string[] => key === 'status' && 'message' in collateral ? [ key, 'message' ] : [ key ])
  .filter(key => key in collateral);

// whether a collateral says its token is shown, and why
const saidOf = (collateral: Collateral) => picked(collateral, ...decidedBy.shown, ...decidedBy.why);

/*
 * The deprecated and the hidden decisions are read as the active reads read
 * them: from D1, or, while D1 cannot be reached, from the record the worker
 * keeps of each kind, and an answer marked with those says that it could not
 * be confirmed. The strategic ones have no record, and what they decide is
 * left out. Every value here is worth less than the threshold, so a
 * collateral its Comet neither hides nor deprecates is told nothing of
 * whether it is shown, as a strategic mark would show it, while one its Comet
 * hides or has deprecated is not shown there whatever they say. Either way
 * the summary is answered: a summary is every market's.
 */
t.test('while D1 cannot be reached, the deprecated and the hidden decisions come from their records and are said to be unconfirmed', async t => {
  const { registry, env, get } = await workerOf(t);
  const logs = consoleLines(t, [ 'error', 'warn' ], { prefixed: true });
  await decide(registry.db, 'usdt', 'XAUt');
  await markDeprecated(registry.db, 'usdt', 'mETH');
  await hide(registry.db, 'usdc', 'weETH');
  let down = false;
  const db = failingStatements(registry.db, NO_STATEMENT, { down: () => down });

  const confirmed = await get(OF_MAINNET, { APP_DB: db });
  t.same([ confirmed.headers.get('x-registry-stale'), confirmed.headers.get('cache-control') ], [ null, null ],
    'an answer D1 confirmed says nothing of the kind');
  const recorded = async (key: string) => (await env.kv_registry.get(key, 'json') as { collaterals: unknown[] }).collaterals;
  t.same([ await recorded(DEPRECATED_KEY), await recorded(HIDDEN_KEY) ], [
    [ { chainId: 1, cometAddress: cometOf('usdt'), tokenAddress: tokenOf('usdt', 'mETH') } ],
    [ { chainId: 1, cometAddress: cometOf('usdc'), tokenAddress: tokenOf('usdc', 'weETH') } ],
  ], 'and records the decisions it read, each kind apart');
  const before = await summaryOf(confirmed);

  for (const [ kind, failing ] of [ [ 'deprecated', statementsOf(DEPRECATED_COLLATERALS) ], [ 'hidden', statementsOf(HIDDEN_COLLATERALS) ] ] as const) {
    const partly = await get(OF_MAINNET, { APP_DB: failingStatements(registry.db, failing) });
    t.same([ partly.headers.get('x-registry-stale'), partly.headers.get('cache-control') ], [ '0', 'no-store' ],
      `${kind} decisions D1 did not give, the version it did: the decisions last recorded, said to be no older than now, and not to be kept`);
    t.equal(JSON.stringify(await summaryOf(partly)), JSON.stringify(before), 'which mark the collaterals as D1 did');
  }

  down = true;
  const response = await get(OF_MAINNET, { APP_DB: db });
  t.equal(response.status, 200, 'with D1 down, the summary is answered from the version it last named');
  t.match(response.headers.get('x-registry-stale'), /^[0-9]+$/, 'saying how old that version is');
  t.equal(response.headers.get('cache-control'), 'no-store', 'and that nothing may keep it');
  const during = await summaryOf(response);
  t.strictSame(picked(collateralOf(entryOf(during, 'usdt'), 'mETH'), 'is_deprecated', 'is_network_deprecated'),
    { is_deprecated: true, is_network_deprecated: true }, 'its collaterals marked by the decisions last recorded');
  t.strictSame(picked(collateralOf(entryOf(during, 'usdc'), 'weETH'), 'is_hidden', 'is_visible', 'visibility_reason'),
    { is_hidden: true, is_visible: false, visibility_reason: 'hidden' }, 'of either kind, and a collateral its Comet hides is not shown there');
  t.strictSame(picked(collateralOf(entryOf(during, 'usdt'), 'mETH'), 'is_hidden', 'is_visible', 'visibility_reason'),
    { is_hidden: false, is_visible: false, visibility_reason: 'deprecated' }, 'nor one its Comet has deprecated and does not hide');
  const strategic = [ ...decidedBy.strategic, ...decidedBy.shown, ...decidedBy.why ];
  const expected  = unreadCollaterals(before, [ 'strategic' ]);
  for (const read of collateralsOf(during)) {
    const fields = expected.get(nameOf(read))!;
    t.strictSame(Object.keys(read.collateral), keysOf(fields),
      `${nameOf(read)}: without what the strategic decisions decide${'visibility_reason' in fields ? ', but for whether it is shown, which its Comet\'s decision decides' : ''}`);
  }
  t.strictSame(during.map(entry => ({ ...entry, collaterals: entry.collaterals!.map(collateral => without(collateral, ...strategic)) })),
    before.map(entry => ({ ...entry, collaterals: entry.collaterals!.map(collateral => without(collateral, ...strategic)) })),
    'and everything else as when D1 answered');
  for (const kind of [ 'deprecated', 'hidden' ]) {
    t.ok(logs.some(line => line === `warn: ${kind} collateral decisions unreadable; answering with the ones last recorded`),
      `the log says where the ${kind} decisions came from`);
  }
  t.ok(logs.some(line => line === 'error: the summary could not read the token policies'), 'and which decisions could not be read');
});

/*
 * A failed read is logged once a minute for each database binding, as the
 * cache logs an outage it answers through, and its fields are left out of
 * every answer all the same. Whether discovery shows a token, and why, which
 * every kind takes part in, are each said only where the decisions read
 * settle them whichever way the others went. Every value here is worth less
 * than the threshold, so a collateral the strategic decisions do not mark is
 * not shown whatever its Comet decided, and is told nothing of it while they
 * cannot be read, as a mark would show it. mETH, which USDT's Comet has
 * deprecated, is not shown there whatever its hiding or its strategic mark,
 * and is told why while the strategic decisions alone cannot be read. XAUt,
 * strategic, is shown unless its Comet hides it or has it deprecated, and so
 * is told nothing of it while either cannot be read.
 */
t.test('decisions that cannot be read leave out what they decide, and are logged under the request', async t => {
  const { registry, get } = await workerOf(t);
  const errors = consoleLines(t, [ 'error' ]);
  await decide(registry.db, 'usdt', 'XAUt');
  await markDeprecated(registry.db, 'usdt', 'mETH');
  const before = await summaryOf(await get(OF_MAINNET));

  const cases = [
    [ 'the deprecated decisions, with none recorded', statementsOf(DEPRECATED_COLLATERALS), 'deprecated', 'deprecated collateral decisions' ],
    [ 'the hidden decisions, with none recorded',     statementsOf(HIDDEN_COLLATERALS), 'hidden', 'hidden collateral decisions' ],
    [ 'the strategic decisions',                      statementsOf(TOKEN_POLICIES), 'strategic', 'token policies' ],
  ] as const;
  for (const [ what, failing, kind, logged ] of cases) {
    errors.length = 0;
    const db       = failingStatements(registry.db, failing);
    const response = await get(OF_MAINNET, { APP_DB: db, kv_registry: MemoryKv({}) });
    t.same([ response.status, response.headers.get('x-registry-stale'), response.headers.get('cache-control') ], [ 200, null, null ],
      `${what}: the summary is answered, and says nothing is unconfirmed`);
    const answered = await summaryOf(response);
    const expected = unreadCollaterals(before, [ kind ]);
    for (const read of collateralsOf(answered)) {
      const fields = expected.get(nameOf(read))!;
      t.strictSame([ Object.keys(read.collateral), saidOf(read.collateral) ], [ keysOf(fields), saidOf(fields) ],
        `${what}: ${nameOf(read)} without what they decide${'visibility_reason' in fields ? ', but for whether it is shown, which its Comet\'s deprecating decides' : ''}`);
    }
    const decided = [ ...decidedBy[kind], ...decidedBy.shown, ...decidedBy.why ];
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
 * A release deployed before migration 0008 finds no table of hidden
 * decisions to read, where the other routes that read them answer 503: the
 * summary is answered without what they decide, as when D1 cannot give them,
 * and the log says why. Whether a token is shown is said where the other
 * decisions settle it: every collateral here is neither strategic nor worth
 * the threshold, so none is shown, whatever its hiding.
 */
t.test('a database without the hidden collateral migration leaves out what the hidden decisions decide', async t => {
  const { get } = await workerOf(t, {}, fixture, { through: '0007' });
  const errors = consoleLines(t, [ 'error' ]);

  const response = await get(OF_MAINNET, { kv_registry: MemoryKv({}) });
  t.same([ response.status, response.headers.get('x-registry-stale'), response.headers.get('cache-control') ], [ 200, null, null ],
    'the summary is answered, and says nothing is unconfirmed');
  const unread = [ ...decidedBy.hidden, ...decidedBy.why ];
  for (const read of collateralsOf(await summaryOf(response))) {
    t.strictSame([ Object.keys(read.collateral), saidOf(read.collateral) ], [ COLLATERAL_KEYS.filter(key => !unread.includes(key)), { is_visible: false } ],
      `${nameOf(read)}: without what they decide`);
  }
  const logged = 'the summary could not read the hidden collateral decisions';
  t.equal(errors.filter(line => line === logged).length, 1, 'the log says so once');
  t.match(errors[errors.indexOf(logged) + 1], /no such table: hidden_collaterals/, 'with the table D1 does not have');
});

/*
 * Whether discovery shows a token takes every kind of decision, but a Comet's
 * hiding it decides that alone, since the rule asks it first. So a collateral
 * its Comet hides is said not to be shown there, and why, even when the other
 * decisions could not be read: a client told nothing would show it. Without
 * the deprecated decisions, every other collateral but weETH, strategic here,
 * is said not to be shown either, though not why: worth less than the
 * threshold, it is not shown whether or not its Comet has deprecated it.
 * Without the strategic ones, every other collateral is told nothing of it,
 * as a strategic mark would show it.
 */
t.test('a collateral its Comet hides is not shown there, though the other decisions could not be read', async t => {
  const { registry, get } = await workerOf(t);
  consoleLines(t, [ 'error' ]);
  await decide(registry.db, 'usdc', 'weETH');
  await hide(registry.db, 'usdc', 'weETH');
  const before = await summaryOf(await get(OF_MAINNET));

  const cases = [
    [ 'the deprecated decisions, with none recorded', statementsOf(DEPRECATED_COLLATERALS), 'deprecated' ],
    [ 'the strategic decisions',                      statementsOf(TOKEN_POLICIES), 'strategic' ],
  ] as const;
  for (const [ what, failing, kind ] of cases) {
    const answered = await summaryOf(await get(OF_MAINNET, { APP_DB: failingStatements(registry.db, failing), kv_registry: MemoryKv({}) }));
    t.strictSame(picked(collateralOf(entryOf(answered, 'usdc'), 'weETH'), 'is_hidden', 'is_visible', 'visibility_reason'),
      { is_hidden: true, is_visible: false, visibility_reason: 'hidden' }, `${what}: weETH in USDC's market, which hides it, is not shown there`);
    const expected = unreadCollaterals(before, [ kind ]);
    for (const read of collateralsOf(answered)) {
      const fields = expected.get(nameOf(read))!;
      const said   = 'visibility_reason' in fields ? 'says whether it is shown'
        : 'is_visible' in fields ? `is said ${fields.is_visible ? 'to be' : 'not to be'} shown, though not why`
        : 'is told nothing of whether it is shown';
      t.strictSame([ Object.keys(read.collateral), saidOf(read.collateral) ], [ keysOf(fields), saidOf(fields) ], `${what}: ${nameOf(read)} ${said}`);
    }
    t.strictSame(picked(collateralOf(entryOf(answered, 'weth'), 'weETH'), 'is_hidden', 'hidden_in'),
      { is_hidden: false, hidden_in: [ checksumAddress(cometOf('usdc')) ] }, `${what}: while WETH's market says only where it is hidden`);
  }
});

/*
 * The strategic decisions have no record, so while they cannot be read, as
 * in any outage of D1, the summary cannot tell whether a token is strategic.
 * A collateral its Comet neither hides nor deprecates is shown, strategic or
 * not, where its value reaches the threshold or cannot be read, so the
 * summary says it is shown, though not why: here rETH, which WETH's market
 * alone takes, held there at 300,000 tokens of a dollar each, and osETH,
 * whose price reverts there. cbETH, worth less, is told nothing of it, as a
 * strategic mark would show it.
 */
t.test('while the strategic decisions cannot be read, a collateral its value shows is said to be shown, though not why', async t => {
  const assetOf = (symbol: string) => marketOf('weth').collateralAssets.find(asset => asset.token.symbol === symbol)!;
  const [ rEth, osEth ] = [ assetOf('rETH'), assetOf('osETH') ];
  const { registry, get } = await workerOf(t, {
    answer: ({ name, argument }) => (
        name === 'totalsCollateral' && argument === rEth.token.address ? [ (300_000n * 10n ** BigInt(rEth.token.decimals)).toString() ]
      : name === 'getPrice' && argument === osEth.priceFeed.address    ? 'revert'
      : undefined
    ),
  });
  consoleLines(t, [ 'error', 'warn' ]);
  let down = false;
  const db     = failingStatements(registry.db, NO_STATEMENT, { down: () => down });
  const before = await summaryOf(await get(OF_MAINNET, { APP_DB: db }));

  const policies = await summaryOf(await get(OF_MAINNET, { APP_DB: failingStatements(registry.db, statementsOf(TOKEN_POLICIES)) }));
  down = true;
  const outage   = await summaryOf(await get(OF_MAINNET, { APP_DB: db }));
  for (const [ what, answered ] of [ [ 'the token policies alone', policies ], [ 'D1 down', outage ] ] as const) {
    const weth = entryOf(answered, 'weth');
    t.strictSame([ 'rETH', 'osETH', 'cbETH' ].map(symbol => picked(collateralOf(weth, symbol), 'total_network_collateral_value_status', 'is_strategic', ...decidedBy.shown, ...decidedBy.why)), [
      { total_network_collateral_value_status: 'fresh',       is_visible: true },
      { total_network_collateral_value_status: 'unavailable', is_visible: true },
      { total_network_collateral_value_status: 'fresh' },
    ], `${what}: in WETH's market, rETH, worth the threshold, and osETH, of a value nobody could read, are said to be shown, though not why, and cbETH, worth less, is told nothing`);
    const expected = unreadCollaterals(before, [ 'strategic' ]);
    for (const symbol of [ 'rETH', 'osETH' ]) {
      const fields = expected.get(nameOf({ entry: weth, collateral: collateralOf(weth, symbol) }))!;
      t.strictSame(Object.keys(collateralOf(weth, symbol)), keysOf(fields), `${what}: ${symbol} without what the strategic decisions decide, but for whether it is shown`);
    }
    t.strictSame(answered, unreadSummary(before, [ 'strategic' ]), `${what}: and everything else as when every decision was read`);
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
  t.ok((await keysOf(env.kv_registry)).every(key => [ 'active:v1', DEPRECATED_KEY, HIDDEN_KEY ].includes(key) || key.startsWith('snapshot:')),
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
