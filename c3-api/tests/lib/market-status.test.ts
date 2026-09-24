import t from 'tap';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';

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
 * The routes answer every market with the status its computation reports —
 * a Comet reading a price feed Chainlink retired is `error` and only what
 * identifies it — and a node that fails still fails the request.
 */
const catalog = fixtureCatalog();

const MAINNET = 'ethereum-mainnet' as const;
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const WBTC    = '0xe85dc543813b8c2cfeaac371517b925a166a9293';
const AERO    = '0x784efeb622244d2348d4f2522f8860b96fbece89';
const COMP    = '0xc00e94cb662c3520282e6f5717214004a7f26888';
const WETH    = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
const ACCOUNT = '0x1111111111111111111111111111111111111111';

const LATEST = { number: 50_000_000, timestamp: 1_790_000_000 };

function comet(network: KnownNetwork.Name, address: string) {
  return catalog.marketsOn(network).find(entry => entry.comet.address.toLowerCase() === address)!.comet;
}

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
 * The answers of a network where the price feeds of `reverting` Comets
 * revert, as their computations report it.
 */
function answers(reverting: string[]) {
  return (name: string, context: any) => {
    if (name === 'ethGetBlock') {
      return LATEST;
    }
    if (name === 'getRewardConfigsSleuth') {
      return context.cometMarkets.map(() => ({ rewardConfig: { rewardToken: COMP } }));
    }
    const comet = { address: context.contract.address };
    if (reverting.includes(comet.address.toLowerCase())) {
      const error = { chainId: 1, comet, status: 'error', message: 'execution reverted' };
      return name === 'historicalMarketDaySummaries' ? [ { ...error, timestamp: LATEST.timestamp } ] : error;
    }
    switch (name) {
      case 'marketMinutelySummary':
        return { chainId: 1, comet, status: comet.address.toLowerCase() === WETH ? 'partially' : 'success' };
      case 'historicalMarketDaySummaries':
        return [ { chainId: 1, comet, status: 'success', timestamp: LATEST.timestamp } ];
      case 'accountRewards':
        return { status: 'success', chainId: 1, comet, amountOwed: 1, walletBalance: 0, supplyBalance: 0, borrowBalance: 0 };
      default:
        return { status: 'success', chainId: 1, comet };
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

t.test('the summary of every market passes on the status of each', async t => {
  const response = await marketHandlers.latestSummary(
    routeData(AllNetworks, AllContracts),
    uninstantiated(stubEvaluator(answers([ WBTC ]))),
  );

  t.equal(response.status, 200);
  const body = await response.json() as Entry[];
  t.equal(body.length, catalog.markets().length, 'no market is left out');
  t.strictSame(body.find(entry => entry.comet.address.toLowerCase() === WBTC), errorOf(WBTC));
  t.equal(statuses(body)[WETH], 'partially');
  t.equal(statuses(body)[USDC], 'success');
});

t.test('the summary of one market is its status', async t => {
  const response = await marketHandlers.latestSummary(
    routeData(MAINNET, comet(MAINNET, WBTC)),
    uninstantiated(stubEvaluator(answers([ WBTC ]))),
  );
  t.equal(response.status, 200);
  t.strictSame(await response.json(), errorOf(WBTC), 'answered as an object, as one market always was');
});

t.test('history passes on the status of each day', async t => {
  const response = await marketHandlers.historicalSummary(
    routeData(MAINNET, AllContracts),
    instantiated(stubEvaluator(answers([ WBTC ]))),
  );
  t.equal(response.status, 200);
  const body = await response.json() as Array<Entry & { timestamp: number }>;
  t.match(body.find(entry => entry.comet.address.toLowerCase() === WBTC), { ...errorOf(WBTC), timestamp: LATEST.timestamp });
  t.equal(statuses(body)[USDC], 'success');
});

t.test('the rewards of every market pass on the status of each', async t => {
  const evaluator = stubEvaluator(answers([ WBTC ]));
  const response = await marketHandlers.rewardsDappData(routeData(MAINNET, AllContracts), uninstantiated(evaluator));

  t.equal(response.status, 200);
  const body = await response.json() as Entry[];
  t.strictSame(body.find(entry => entry.comet.address.toLowerCase() === WBTC), errorOf(WBTC));
  t.equal(statuses(body)[USDC], 'success');
  t.equal(evaluator.evaluations, 1, 'the markets of a network still share one evaluation');
});

t.test('the rewards of an account format only the markets that were valued', async t => {
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
