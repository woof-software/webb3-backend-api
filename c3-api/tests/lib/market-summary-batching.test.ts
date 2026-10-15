import t, { Test } from 'tap';

import * as Debug    from '../../lib/debug-log.js';
import * as Flags    from '../../lib/flags.js';
import * as jsonRpc  from '../../lib/json-rpc.js';
import { BigNumber } from '../../lib/bignumber.js';
import { BigFixnum } from '../../lib/bigfixnum.js';

import * as Evaluator  from '../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../lib/symbolic/cache.js';

import * as evm     from '../../lib/computations/evm.js';
import * as comet   from '../../lib/computations/comet.js';
import * as market  from '../../lib/computations/market.js';
import * as rewards from '../../lib/computations/rewards.js';

import * as marketHandlers from '../../src/market.js';
import {
  AllContracts,
  AllNetworks,
  type MarketRouteData,
  type UninstantiatedContext,
} from '../../src/router.js';

import { consoleLines } from '../util/console.js';
import { type Call, type FakeNode, fakeNode, serve } from '../util/fake-node.js';
import { fixtureCatalog, loadRegistrySnapshotFixture } from '../util/registry-fixture.js';

import '../../shim/node-self.js';

/*
 * The summary and the rewards of every market, on the real evaluator against
 * a fake node, counting what reaches the node. Each request to the node
 * provider proxy is a subrequest, of which a Worker invocation has a budget
 * (README, "Workers Plan"), so what the summary of every market costs has to
 * grow with the networks, not with the markets.
 *
 * This is where their batching is counted, and only here: what the route asks
 * the node is the cost that matters, however the handler and the evaluator
 * share the work out between them.
 *
 * It is also where one market's read failing at the node meets the real
 * computations: a price feed that reverts is that market's answer, and a call
 * the node did not serve fails the summary, as does a request the node
 * provider failed, both as a request the node did not serve.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const snapshot = loadRegistrySnapshotFixture();
const catalog  = fixtureCatalog(snapshot);

const LATEST = { number: 30_000_000, timestamp: 1_790_000_000 };
const USDC   = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WBTC   = '0xe85dc543813b8c2cfeaac371517b925a166a9293';

/*
 * The error the node answers a call to a Comet with instead of its result,
 * if any, by the Comet called, the function, and its argument where it
 * takes one: an asset's index, a feed or a token. Addresses are lowercase.
 */
type Fault = (comet: string, fragment: string, argument: string | undefined) => { code: number, message: string, data?: string } | undefined;

// the registry version's description of a Comet's market
const marketOf = (comet: string) => catalog.markets().find(entry => entry.comet.address.toLowerCase() === comet)!.comet.registry.market;

/*
 * The prices the node answers, at eight decimals, where they are not 1.0:
 * BTC / USD, through which the version prices the base asset of WBTC's market
 * in USD, so that its base_usd_price shows which feed was read.
 */
const PRICES = new Map<string, number>([
  [ marketOf(WBTC).baseAsset.usdPriceFeed!.address, 8_610_669_000_000 ], // BTC / USD: 86106.69
]);

/*
 * The node of the fixture at LATEST, which answers the prices above and, in
 * place of a call's result, the error `fault` answers it with.
 */
function nodeOf(fault: Fault = () => undefined): FakeNode {
  return fakeNode(snapshot, LATEST, {
    answer: ({ comet, name, argument }) => fault(comet, name, argument)
      ?? (name === 'getPrice' && PRICES.has(argument!) ? [ PRICES.get(argument!) ] : undefined),
  });
}

function everyMarket(): MarketRouteData {
  return { apiHost: '', nodeHost: 'node.test', nodeKey: 'key', network: AllNetworks, contract: AllContracts, catalog, queryParams: new URLSearchParams() };
}

/*
 * What the router hands a handler that makes its own evaluator. Every
 * evaluation the handler starts is kept in `evaluations`: a summary that one
 * network fails answers without waiting for the others, and a test waits for
 * them, so none of them asks a node after it ends.
 */
function context(evaluations: Promise<unknown>[] = []): UninstantiatedContext {
  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  return {
    flags,
    instantiateEvaluator: (_: string, overrides: { flags?: Flags.SomeFlags } = {}) => {
      const evaluator = Evaluator.instantiate(
        { ...evm, ...comet, ...market, ...rewards } as any,
        { cache, debug, flags: { ...flags, ...overrides.flags } },
      );
      // a handler takes evaluate off the evaluator, so the evaluations are kept where it reads it
      const evaluate = evaluator.evaluate;
      evaluator.evaluate = (redex => {
        const evaluation = evaluate(redex);
        evaluations.push(evaluation);
        return evaluation;
      }) as typeof evaluate;
      return evaluator;
    },
  } as unknown as UninstantiatedContext;
}

// how the summary of every market failed, once every evaluation it started has ended
async function failureOf(node: FakeNode, t: Test): Promise<unknown> {
  serve(t, node);
  const evaluations: Promise<unknown>[] = [];
  const failure = await marketHandlers.latestSummary(everyMarket(), context(evaluations)).then(
    () => null,
    (error: unknown) => error,
  );
  await Promise.allSettled(evaluations);
  return failure;
}

t.test('the summary of every market makes four node requests per network', async t => {
  const node = nodeOf();
  serve(t, node);

  const response = await marketHandlers.latestSummary(everyMarket(), context());
  const body = await response.json() as Array<{ status: string }>;

  t.equal(response.status, 200);
  t.equal(body.length, catalog.markets().length, 'every market is answered');
  t.ok(body.every(entry => entry.status === 'success'));

  const networks = [ ...new Set(catalog.markets().map(entry => entry.network)) ];
  for (const network of networks) {
    const requests = node.requests.filter(request => request.network === network);
    t.equal(requests.length, 4, `${network}: the latest block, then three rounds of reads, whatever its market count`);
  }
  t.equal(node.requests.length, 4 * networks.length);

  for (const { network, calls } of node.requests) {
    const distinct = new Set(calls.map(({ method, params }) => JSON.stringify([ method, params ])));
    t.equal(distinct.size, calls.length, `${network}: no call is sent twice in one batch`);
  }
});

/*
 * The rewards of a market are read in one round once the block is known:
 * each APR reads the base price it divides by beside the reward price and the
 * rates (rewards-apr.ts), not in a round of its own once they are in.
 */
t.test('the rewards of every market make two node requests per network', async t => {
  const node = nodeOf();
  serve(t, node);

  const response = await marketHandlers.rewardsDappData(everyMarket(), context());
  t.equal(response.status, 200);

  const rewarded = catalog.markets().filter(entry => entry.comet.registry.market.capabilities.rewards);
  const networks = [ ...new Set(rewarded.map(entry => entry.network)) ];
  for (const network of networks) {
    const requests = node.requests.filter(request => request.network === network);
    t.equal(requests.length, 2, `${network}: the latest block, then one round of reads, whatever its market count`);
  }
  t.equal(node.requests.length, 2 * networks.length);

  // a market whose APRs divide by the USD price of its base asset, as the rewards summary reads them
  const wbtc = rewarded.find(entry => entry.comet.address.toLowerCase() === WBTC)!;
  node.requests.length = 0;
  const summary = await marketHandlers.latestRewardsSummary({ ...everyMarket(), network: wbtc.network, contract: wbtc.comet }, context());
  t.equal(summary.status, 200);
  t.equal(node.requests.length, 2, 'and so does the rewards summary of one market');
});

/*
 * The rewards of every market cost the same per network. A reward feed that
 * quotes a market's base asset — mainnet's WETH market values COMP in ETH —
 * is converted to USD with one more price, read beside the reward price, not
 * in a round of its own once the rates are in: mainnet takes as many
 * requests as Base, which has no such market.
 */
t.test('the rewards of every market convert a reward price to USD in no round of its own', async t => {
  const node = nodeOf();
  serve(t, node);

  const response = await marketHandlers.rewardsDappData(everyMarket(), context());
  const body = await response.json() as Array<{ status: string }>;

  t.equal(response.status, 200);
  t.equal(body.length, catalog.markets().filter(entry => entry.comet.registry.market.capabilities.rewards).length,
    'every market with rewards is answered');
  t.ok(body.every(entry => entry.status === 'success'));

  const weth = catalog.marketsOn('ethereum-mainnet').find(entry => entry.deploymentKey === 'weth')!.comet.registry.market;
  const priceRead = (feed: string) => JSON.stringify([ weth.contracts.comet, `0x41976e09${feed.slice(2).padStart(64, '0')}` ]);
  const reads = (request: { calls: Call[] }) => request.calls
    .filter(({ method }) => method === 'eth_call')
    .map(({ params: [ { to, data } ] }) => JSON.stringify([ to.toLowerCase(), data ]));
  const converted = node.requests.find(request => reads(request).includes(priceRead(weth.rewardAsset!.priceFeed!.address)));
  t.ok(converted !== undefined && reads(converted).includes(priceRead(weth.baseAsset.usdPriceFeed!.address)),
    'the USD price of WETH is read in the request that reads COMP in ETH');

  const requestsOn = (network: string) => node.requests.filter(request => request.network === network).length;
  t.equal(requestsOn('ethereum-mainnet'), requestsOn('base-mainnet'), 'and mainnet makes as many requests as Base');

  for (const { network, calls } of node.requests) {
    const distinct = new Set(calls.map(({ method, params }) => JSON.stringify([ method, params ])));
    t.equal(distinct.size, calls.length, `${network}: no call is sent twice in one batch`);
  }
});

t.test('a price feed that reverts is one market\'s error, and the rest are answered', async t => {
  serve(t, nodeOf((comet, fragment) => (
    comet === WBTC && fragment === 'getPrice' ? { code: 3, message: 'execution reverted', data: '0x' } : undefined
  )));
  const response = await marketHandlers.latestSummary(everyMarket(), context());
  t.equal(response.status, 200);
  const body = await response.json() as Array<{ comet: { address: string }, status: string }>;
  t.equal(body.length, catalog.markets().length, 'every market is answered');
  t.same(
    body.filter(entry => entry.status !== 'success').map(entry => [ entry.comet.address.toLowerCase(), entry.status ]),
    [ [ WBTC, 'error' ] ],
    'the market whose feeds revert as an error, and every other one as read',
  );
});

t.test('a call the node did not serve for one market fails the summary', async t => {
  const failure = await failureOf(nodeOf((comet, fragment) => (
    comet === WBTC && fragment === 'totalSupply' ? { code: -32000, message: 'header not found' } : undefined
  )), t);
  t.match((failure as Error | null)?.message, /header not found/);
  t.ok(jsonRpc.isNotServed(failure), 'as a call the node did not serve, which a route answers 503');
});

/*
 * The node provider proxy fails a request outright when no provider served
 * its calls: 503, and how long to wait before asking again. One network's
 * failing so fails the summary of every network.
 */
t.test('a request the node provider failed for one network fails the summary', async t => {
  const node = nodeOf();
  const down = 'base-mainnet';
  const failure = await failureOf({
    ...node,
    fetch: async (input: string | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      return new URL(request.url).pathname.split('/')[1] === down
        ? new Response('upstream error', { status: 503, headers: { 'Retry-After': '5' } })
        : node.fetch(request);
    },
  }, t);
  t.ok(jsonRpc.isNotServed(failure), 'as a request the node did not serve');
  t.same([ (failure as jsonRpc.NotServed).status, (failure as jsonRpc.NotServed).retryAfter ], [ 503, 5 ],
    'with the status the proxy answered, and the seconds it asked to wait, for a route to pass on');
  t.ok(node.requests.some(request => request.network !== down), 'while the other networks were read');
});

// a market of the summary as the route answers it, in JSON
type Summary = {
  comet: { address: string },
  [field: string]: unknown,
};

// the summary of every market, as the route answers it from `node`
async function summaryFrom(t: Test, node: FakeNode): Promise<Summary[]> {
  serve(t, node);
  const response = await marketHandlers.latestSummary(everyMarket(), context());
  t.equal(response.status, 200, 'the summary is answered');
  return await response.json() as Summary[];
}

const entryOf = (summary: Summary[], comet: string) => summary.find(entry => entry.comet.address.toLowerCase() === comet)!;
const without = (entry: object, ...fields: string[]) => Object.fromEntries(Object.entries(entry).filter(([ field ]) => !fields.includes(field)));

const REVERT = { code: 3, message: 'execution reverted', data: '0x' };

/*
 * A market whose base asset could not be priced is an error, and answers
 * every field that does not need the price it lacks. The version prices the
 * totals of WBTC's market with WBTC / BTC, and its base asset in USD with
 * BTC / USD: without the first, it answers all but its borrow and supply
 * totals, in BTC and in USD. One feed prices both on USDC's market, which
 * answers all but those totals and its base asset's USD price.
 */
t.test('a market whose base feed reverts answers every field it can', async t => {
  const reading = await summaryFrom(t, nodeOf());
  // the warnings the summary logs, kept out of the test's output
  consoleLines(t, [ 'warn' ]);
  const feeds = new Map([ WBTC, USDC ].map(comet => [ comet, marketOf(comet).baseAsset.priceFeed.address ]));
  const reverting = await summaryFrom(t, nodeOf((comet, fragment, argument) => (
    fragment === 'getPrice' && argument === feeds.get(comet) ? REVERT : undefined
  )));
  const totals = [ 'total_borrow_value', 'total_supply_value', 'total_borrow_value_usd', 'total_supply_value_usd' ];

  const wbtc = entryOf(reverting, WBTC);
  t.strictSame(wbtc, { ...without(entryOf(reading, WBTC), ...totals), status: 'error', message: 'execution reverted' },
    'WBTC: an error, and every field as read but its totals');
  t.strictSame(Object.keys(wbtc), [
    'chain_id', 'comet', 'status', 'message', 'borrow_apr', 'supply_apr', 'total_collateral_value', 'total_collateral_value_usd',
    'utilization', 'base_usd_price', 'collateral_asset_symbols', 'collaterals',
  ], 'WBTC: its message after its status');
  t.equal(wbtc.base_usd_price, '86106.69', 'WBTC: its USD price, which is the price of BTC');

  const usdc = entryOf(reverting, USDC);
  t.strictSame(usdc, { ...without(entryOf(reading, USDC), ...totals, 'base_usd_price'), status: 'error', message: 'execution reverted' },
    'USDC: an error, and every field as read but its totals and its USD price');
  t.strictSame(Object.keys(usdc), [
    'chain_id', 'comet', 'status', 'message', 'borrow_apr', 'supply_apr', 'total_collateral_value', 'total_collateral_value_usd',
    'utilization', 'collateral_asset_symbols', 'collaterals',
  ], 'USDC: its message after its status');

  const others = (summary: Summary[]) => summary.filter(entry => ![ WBTC, USDC ].includes(entry.comet.address.toLowerCase()));
  t.strictSame(others(reverting), others(reading), 'and every other market as read');
});

/*
 * Where the base feed the version names reverts, a market's base asset is
 * priced through the feed its Comet names at the block: USDC's here, a
 * market quoted in USD, so its USD price too. Asking the Comet for that feed,
 * and reading it, takes two rounds after the one that reverted, which the
 * summary takes anyway for the collateral, so no network sends another
 * request. The rewards are read in one round, so the network of such a
 * market takes two more.
 */
t.test('a base feed that reverts is read through the Comet\'s in the requests the summary makes anyway', async t => {
  const own   = marketOf(USDC).baseAsset.priceFeed.address;
  const OTHER = '0x2222222222222222222222222222222222222222';
  // USDC's Comet names OTHER for its base asset, which answers 2.0, where the feed the version names reverts
  const fallingBack = () => fakeNode(snapshot, LATEST, {
    answer: ({ comet, name, argument }) => {
      if (comet === USDC && name === 'baseTokenPriceFeed') {
        return [ OTHER ];
      }
      if (comet === USDC && name === 'getPrice' && (argument === own || argument === OTHER)) {
        return argument === own ? 'revert' : [ 200_000_000 ];
      }
      return name === 'getPrice' && PRICES.has(argument!) ? [ PRICES.get(argument!) ] : undefined;
    },
  });

  const reading = await summaryFrom(t, nodeOf());
  const node    = fallingBack();
  const summary = await summaryFrom(t, node);
  t.strictSame(entryOf(summary, USDC), {
    ...entryOf(reading, USDC),
    total_borrow_value:     '200.0',
    total_supply_value:     '200.0',
    total_borrow_value_usd: '200.0',
    total_supply_value_usd: '200.0',
    base_usd_price:         '2.0',
  }, 'USDC: a success, its totals and its USD price at the 2.0 of the feed its Comet names');
  const others = (entries: Summary[]) => entries.filter(entry => entry.comet.address.toLowerCase() !== USDC);
  t.strictSame(others(summary), others(reading), 'and every other market as read');

  const networks = [ ...new Set(catalog.markets().map(entry => entry.network)) ];
  for (const network of networks) {
    t.equal(node.requests.filter(request => request.network === network).length, 4, `${network}: four requests, as without the revert`);
  }
  for (const { network, calls } of node.requests) {
    const distinct = new Set(calls.map(({ method, params }) => JSON.stringify([ method, params ])));
    t.equal(distinct.size, calls.length, `${network}: no call is sent twice in one batch`);
  }

  const rewarding = fallingBack();
  serve(t, rewarding);
  const rewards = await marketHandlers.rewardsDappData(everyMarket(), context());
  t.equal(rewards.status, 200);
  t.ok((await rewards.json() as Array<{ status: string }>).every(entry => entry.status === 'success'), 'the rewards of every market are answered');
  const requestsOn = (network: string) => rewarding.requests.filter(request => request.network === network).length;
  t.equal(requestsOn('ethereum-mainnet'), 4, 'the rewards of USDC\'s network take two requests more');
  t.equal(requestsOn('base-mainnet'), 2, 'and those of another network none');
});
