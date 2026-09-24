import * as Eth      from '../lib/eth-constants.js';
import * as Fallible from '../lib/fallible/fallible.js';

import * as KnownNetwork from '../lib/well-known/networks/network.js';

import { type CallReverted, isCallReverted } from '../lib/computations/evm.js';
import type { MarketIdentity } from '../lib/computations/market/market-summary.js';

import { registryOf } from '../lib/model/comet-registry.js';

/*
 * The status a route reports for each market it answers.
 *
 * A Comet that reads a price feed Chainlink retired reverts on every read of
 * that price. One such market used to fail the whole response it was listed
 * in, every other network's markets with it. A market summary now reads its
 * prices as values and reports `success`, `partially` or `error` itself (see
 * market-summary.ts); what is left to a route is a revert the computation
 * could not answer — a reward feed, or any call other than a price — which
 * reports that market as `error` and only what identifies it.
 *
 * Only a revert does this. A node that does not answer says nothing about the
 * market, and reporting every market as broken during an outage would be
 * reporting something untrue, so that still fails the request.
 */
type MarketError = MarketIdentity & {
  status:  'error',
  message: string,
};

/*
 * One market's result, or its error when a call of it reverted.
 */
async function orMarketError<R>(
  network:  KnownNetwork.Name,
  market:   Eth.Contract,
  evaluate: () => Promise<R>,
): Promise<R | MarketError> {
  try {
    return await evaluate();
  } catch (error) {
    if (!isCallReverted(error)) {
      throw error;
    }
    report(network, market, error);
    const { chainId } = Fallible.must(KnownNetwork.lookup({ name: network }));
    return { chainId, comet: { address: market.address }, status: 'error', message: error.error.message };
  }
}

/*
 * The results of markets evaluated together, in their order, each one's
 * error in place of its result when a call of it reverted.
 *
 * Together, their calls share one batch per step, so that stays the first
 * attempt. A revert fails the whole batch and names only the contract it
 * called, which several markets can share; only then is each market
 * evaluated on its own, to find which of them it was.
 */
async function eachOrMarketError<M extends Eth.Contract, R>(
  network:  KnownNetwork.Name,
  markets:  M[],
  evaluate: (markets: M[]) => Promise<R[]>,
): Promise<Array<R | MarketError>> {
  try {
    return await evaluate(markets);
  } catch (error) {
    if (!isCallReverted(error)) {
      throw error;
    }
  }
  return Promise.all(markets.map(async market => (
    orMarketError(network, market, async () => (await evaluate([ market ]))[0]!)
  )));
}

function isMarketError(value: unknown): value is MarketError {
  return typeof(value) === 'object' && value !== null && (value as { status?: unknown }).status === 'error';
}

/*
 * A result a route read in full, marked as such.
 */
function succeeded<R extends object>(result: R): R & { status: 'success' } {
  return { ...result, status: 'success' };
}

/*
 * One line an operator can find the market by, and the call that failed:
 * its selector and first argument, which for `getPrice` is the feed.
 */
function report(network: KnownNetwork.Name, market: Eth.Contract, error: CallReverted) {
  const annotation = registryOf(market);
  const name = annotation === null ? market.address : `${annotation.chainId}/${annotation.deploymentKey}`;
  const { to, data, block } = error.call;
  console.error(
    `market call reverted: ${name} on ${network} (${market.address}):`
    + ` call to ${to} with ${data.slice(0, 74)} reverted at block ${block}: ${error.error.message}`
  );
}

export type { MarketError };
export { eachOrMarketError, isMarketError, orMarketError, succeeded };
