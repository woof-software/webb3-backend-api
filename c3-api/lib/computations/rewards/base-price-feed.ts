import type { PriceFeedV1 } from '../../model/comet-registry.js';
import { registryOf } from '../../model/comet-registry.js';

import type { Contract } from '../../well-known/contracts/utils.js';

/*
 * A rewards APR divides the annual value of the rewards by the value of the
 * market, so both have to be measured in the same unit.
 *
 * The reward feed decides that unit. Where it quotes USD and the market
 * quotes its own base asset — a WETH or WBTC market, whose own feed answers
 * in ETH or BTC — the base price has to come from the market's USD feed
 * instead. Where the two already agree, the market's own base price is right,
 * and this returns null.
 *
 * The registry states both units and the USD feed, so this replaces the
 * branches on network and display name that used to encode the same four
 * markets by hand.
 */
function usdBasePriceFeedFor(contract: Contract): PriceFeedV1 | null {
  const annotation = registryOf(contract);
  if (annotation === null) {
    // a contract that did not come from the registry says nothing about units
    return null;
  }
  const market = annotation.market;
  return market.rewardAsset?.priceFeedQuote === 'usd' && market.collateralValueQuote === 'base'
    ? market.baseAsset.usdPriceFeed
    : null;
}

export { usdBasePriceFeedFor };
