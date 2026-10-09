import type { PriceFeedV1, RegistryComet } from '../../model/comet-registry.js';

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
function usdBasePriceFeedFor(contract: RegistryComet): PriceFeedV1 | null {
  const market = contract.registry.market;
  return market.rewardAsset?.priceFeedQuote === 'usd' && market.collateralValueQuote === 'base'
    ? market.baseAsset.usdPriceFeed
    : null;
}

export { usdBasePriceFeedFor };
