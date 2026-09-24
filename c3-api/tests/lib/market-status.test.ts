import t from 'tap';

import * as Eth          from '../../lib/eth-constants.js';
import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import { CallReverted } from '../../lib/computations/evm.js';

import { eachOrMarketError, orMarketError } from '../../src/market-status.js';
import * as marketHandlers from '../../src/market.js';
import { rewardsSummary as accountRewardsSummary } from '../../src/account-handlers/rewards.js';
import {
  AllContracts,
  AllNetworks,
  type Context,
  type MarketRouteData,
  type UninstantiatedContext,
} from '../../src/router.js';

import { fixtureCatalog } from '../util/registry-fixture.js';

import '../../shim/node-self.js';

/*
 * A market one of whose contract calls reverts — a Comet reading a reward or
 * base price feed Chainlink retired — is reported by every route with
 * `status: error` and what identifies it, and every other market with
 * `status: success`. A node that fails still fails the request.
 */
const catalog = fixtureCatalog();

const MAINNET = 'ethereum-mainnet' as const;
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WBTC    = '0xe85dc543813b8c2cfeaac371517b925a166a9293';
const AERO    = '0x784efeb622244d2348d4f2522f8860b96fbece89';
const COMP    = '0xc00e94cb662c3520282e6f5717214004a7f26888';
const ACCOUNT = '0x1111111111111111111111111111111111111111';

const LATEST = { number: 50_000_000, timestamp: 1_790_000_000 };

function comet(network: KnownNetwork.Name, address: string) {
  return catalog.marketsOn(network).find(entry => entry.comet.address.toLowerCase() === address)!.comet;
}

function reverted(network: KnownNetwork.Name, to: Eth.Address): CallReverted {
  return new CallReverted(
    { code: 3, message: 'execution reverted' },
    { network, to, data: '0x41976e09', block: LATEST.number },
  );
}

/*
 * Silence the line each reverted market logs, and keep it for the assertions.
 */
const logged: string[] = [];
const consoleError = console.error;
t.beforeEach(() => {
  logged.length = 0;
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
});
t.afterEach(() => {
  console.error = consoleError;
});

/*
 * An evaluator shaped like the one the router hands a handler. pipe1, pull1,
 * split and value describe the work; evaluate walks it and answers every
 * computation from `answer` instead of a node.
 */
class Pipe  { constructor(readonly lookup: Record<string, unknown>, readonly receiver: (value: any) => unknown) {} }
class Pull  { constructor(readonly lookup: Record<string, unknown>) {} }
class Split { constructor(readonly items: unknown[]) {} }
class Value { constructor(readonly value: unknown) {} }

function stubEvaluator(answer: (name: string, context: any) => unknown) {
  const lookup = async (entries: Record<string, unknown>) => {
    const [ [ name, context ] ] = Object.entries(entries);
    return answer(name, context);
  };
  const walk = async (work: unknown): Promise<unknown> => {
    if (work instanceof Value) return work.value;
    if (work instanceof Pull)  return lookup(work.lookup);
    if (work instanceof Split) return Promise.all(work.items.map(walk));
    if (work instanceof Pipe)  return walk(work.receiver(await lookup(work.lookup)));
    return work;
  };
  const evaluator = {
    evaluations: 0,
    pipe1: ([ lookup, receiver ]: [ Record<string, unknown>, (value: any) => unknown ]) => new Pipe(lookup, receiver),
    pull1: (lookup: Record<string, unknown>) => new Pull(lookup),
    split: (items: unknown[]) => new Split(items),
    value: (value: unknown) => new Value(value),
    evaluate: async (work: unknown) => {
      evaluator.evaluations++;
      return walk(work);
    },
  };
  return evaluator;
}

/*
 * The answers of a network where the calls of `reverting` Comets revert.
 */
function answers(reverting: string[]) {
  return (name: string, context: any) => {
    if (name === 'ethGetBlock') {
      return LATEST;
    }
    if (name === 'getRewardConfigsSleuth') {
      return context.cometMarkets.map(() => ({ rewardConfig: { rewardToken: COMP } }));
    }
    const address = context.contract.address.toLowerCase();
    if (reverting.includes(address)) {
      throw reverted(context.network, context.contract.address);
    }
    const comet = { address: context.contract.address };
    switch (name) {
      // a summary reports its own status, which the route passes on
      case 'marketMinutelySummary':
        return { chainId: 1, comet, status: 'partially' };
      case 'historicalMarketDaySummaries':
        return [ { chainId: 1, comet, status: 'success', timestamp: LATEST.timestamp } ];
      case 'accountRewards':
        return { chainId: 1, comet, amountOwed: 1, walletBalance: 0, supplyBalance: 0, borrowBalance: 0 };
      default:
        return { chainId: 1, comet };
    }
  };
}

function routeData(network: MarketRouteData['network'], contract: MarketRouteData['contract']): MarketRouteData {
  return { apiHost: '', nodeHost: '', nodeKey: '', network, contract, catalog, queryParams: new URLSearchParams() };
}

function uninstantiated(evaluator: ReturnType<typeof stubEvaluator>): UninstantiatedContext {
  return { flags: {}, instantiateEvaluator: () => evaluator } as unknown as UninstantiatedContext;
}

function instantiated(evaluator: ReturnType<typeof stubEvaluator>): Context {
  return { flags: { environment: 'local' }, evaluator } as unknown as Context;
}

type Entry = { chain_id: number, comet: { address: string }, status: string, message?: string };

/*
 * The status each market of a response reports, by lowercased Comet address.
 */
function statuses(body: unknown): Record<string, string> {
  return Object.fromEntries((body as Entry[]).map(entry => [ entry.comet.address.toLowerCase(), entry.status ]));
}

function errorOf(address: string) {
  return {
    chain_id: 1,
    comet:    { address: comet(MAINNET, address).address },
    status:   'error',
    message:  'execution reverted',
  };
}

t.test('one market reports its result, or its error when a call of it reverts', async t => {
  const usdc = comet(MAINNET, USDC);

  t.same(await orMarketError(MAINNET, usdc, async () => 'summary'), 'summary', 'a market that reads answers');
  t.strictSame(
    await orMarketError(MAINNET, usdc, async () => { throw reverted(MAINNET, usdc.address); }),
    { chainId: 1, comet: { address: usdc.address }, status: 'error', message: 'execution reverted' },
    'one that reverts is what identifies it and why',
  );
  t.match(logged, [ /^market call reverted: 1\/usdc on ethereum-mainnet .* reverted at block 50000000: execution reverted$/ ]);

  await t.rejects(
    orMarketError(MAINNET, usdc, async () => { throw new Error('bad vibes'); }),
    /bad vibes/,
    'a node that fails still fails the request',
  );
});

t.test('markets are read together, and only a revert splits them', async t => {
  const markets = catalog.marketsOn(MAINNET).map(entry => entry.comet);
  const calls: string[][] = [];
  const evaluate = async (some: typeof markets) => {
    const addresses = some.map(market => market.address.toLowerCase());
    calls.push(addresses);
    if (addresses.includes(WBTC)) {
      throw reverted(MAINNET, comet(MAINNET, WBTC).address);
    }
    return addresses;
  };

  const healthy = markets.filter(market => market.address.toLowerCase() !== WBTC);
  t.strictSame(await eachOrMarketError(MAINNET, healthy, evaluate), healthy.map(market => market.address.toLowerCase()));
  t.equal(calls.length, 1, 'markets that all read are read in one evaluation');

  calls.length = 0;
  const results = await eachOrMarketError(MAINNET, markets, evaluate);
  t.equal(results.length, markets.length, 'every market is answered');
  results.forEach((result, index) => {
    const address = markets[index]!.address.toLowerCase();
    if (address === WBTC) {
      t.match(result, { status: 'error', comet: { address: markets[index]!.address } }, 'the one that reverts in its place');
    } else {
      t.equal(result, address, 'and every other with its result, in order');
    }
  });
  t.equal(calls.length, 1 + markets.length, 'the revert is found by reading each market on its own');

  await t.rejects(
    eachOrMarketError(MAINNET, markets, async () => { throw new Error('bad vibes'); }),
    /bad vibes/,
    'a node that fails still fails the request',
  );
});

t.test('the summary of every market reports the one that reverts', async t => {
  const response = await marketHandlers.latestSummary(
    routeData(AllNetworks, AllContracts),
    uninstantiated(stubEvaluator(answers([ WBTC ]))),
  );

  t.equal(response.status, 200);
  const body = await response.json() as Entry[];
  t.equal(body.length, catalog.markets().length, 'no market is left out');
  t.strictSame(body.find(entry => entry.comet.address.toLowerCase() === WBTC), errorOf(WBTC));
  t.equal(statuses(body)[USDC], 'partially', 'a summary keeps the status it computed');
});

t.test('the summary of the market that reverts is its error', async t => {
  const evaluator = stubEvaluator(answers([ WBTC ]));

  const reverting = await marketHandlers.latestSummary(routeData(MAINNET, comet(MAINNET, WBTC)), uninstantiated(evaluator));
  t.equal(reverting.status, 200);
  t.strictSame(await reverting.json(), errorOf(WBTC), 'one market is still answered as an object');
});

t.test('history reports the market that reverts', async t => {
  const evaluator = stubEvaluator(answers([ WBTC ]));

  const all = await marketHandlers.historicalSummary(routeData(MAINNET, AllContracts), instantiated(evaluator));
  t.equal(all.status, 200);
  const body = await all.json() as Entry[];
  t.strictSame(body.filter(entry => entry.comet.address.toLowerCase() === WBTC), [ errorOf(WBTC) ], 'as its one error');
  t.equal(statuses(body)[USDC], 'success');
});

t.test('the rewards of every market report the one that reverts', async t => {
  const response = await marketHandlers.rewardsDappData(
    routeData(MAINNET, AllContracts),
    uninstantiated(stubEvaluator(answers([ WBTC ]))),
  );

  t.equal(response.status, 200);
  const body = await response.json() as Entry[];
  t.strictSame(body.find(entry => entry.comet.address.toLowerCase() === WBTC), errorOf(WBTC));
  t.strictSame(
    Object.values(statuses(body)).sort(),
    [ 'error', 'success', 'success', 'success' ],
    'and the rest as read in full',
  );

  const healthy = stubEvaluator(answers([]));
  await marketHandlers.rewardsDappData(routeData(MAINNET, AllContracts), uninstantiated(healthy));
  t.equal(healthy.evaluations, 1, 'markets that all read still share one evaluation');
});

t.test('the rewards summary of one market says whether it was read', async t => {
  const evaluator = stubEvaluator(answers([ WBTC ]));

  const reverting = await marketHandlers.latestRewardsSummary(routeData(MAINNET, comet(MAINNET, WBTC)), uninstantiated(evaluator));
  t.equal(reverting.status, 200);
  t.strictSame(await reverting.json(), errorOf(WBTC));

  const read = await marketHandlers.latestRewardsSummary(routeData(MAINNET, comet(MAINNET, USDC)), uninstantiated(evaluator));
  t.match(await read.json(), { status: 'success' });
});

t.test('the rewards of an account report the market that reverts', async t => {
  const response = await accountRewardsSummary(
    { apiHost: '', nodeHost: '', nodeKey: '', account: ACCOUNT, testnets: 'exclude', catalog },
    instantiated(stubEvaluator(answers([ WBTC ]))),
  );

  t.equal(response.status, 200);
  const body = await response.json() as Array<Entry & { amount_owed?: string }>;
  t.strictSame(body.find(entry => entry.comet.address.toLowerCase() === WBTC), errorOf(WBTC));
  t.match(body.find(entry => entry.comet.address.toLowerCase() === AERO), { status: 'success', amount_owed: '1' });
  t.equal(body.length, 5, 'every market with claimable rewards is answered');
});

t.test('a node that fails still fails the list', async t => {
  const evaluator = stubEvaluator(() => { throw new Error('bad vibes'); });
  await t.rejects(
    marketHandlers.latestSummary(routeData(MAINNET, AllContracts), uninstantiated(evaluator)),
    /bad vibes/,
  );
});
