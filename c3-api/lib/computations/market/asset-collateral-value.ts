import { BigNumber } from '@ethersproject/bignumber';

import { BigFixnum } from '../../bigfixnum.js';
import * as Eth      from '../../eth-constants.js';
import * as Compute  from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type {
  CollateralAssetV1,
  PriceExceptionV1,
  PriceFeedV1,
  RegistryAnnotation,
  RegistryComet,
} from '../../model/comet-registry.js';
import { normalizeAddress } from '../../model/comet-registry.js';

import { exceptionFor } from '../comet/asset-price.js';
import type { CollateralAssetInfo, CollateralAssetInfoRead } from '../comet/collateral-asset-info.js';
import type { CollateralTotal, CollateralTotalRead } from '../comet/collateral-total.js';
import type { GetPrice, PriceRead } from '../comet/get-price.js';

/*
 * The USD value of one collateral position: what one Comet holds of one of its
 * collateral assets at one block, priced as the registry says to price it.
 *
 * Everything is read in one round: the asset's info, to check it is the asset
 * and feed the registry describes; the amount the Comet holds; the price; and,
 * for a market whose prices are quoted in its base asset, the base asset's USD
 * price. A revert of any of them is an answer about this position, never a
 * failure of the evaluation, so one market cannot take the rest of a chain
 * with it. A node that does not answer still fails, because that says nothing
 * about the position and must not be remembered as if it did.
 *
 * The arithmetic is exact: amounts and prices are multiplied as fixed-point
 * integers and never divided, so the value has every digit and a comparison
 * with a threshold never rounds.
 */
type PositionFailure = (
  | 'asset_info_reverted'
  // the Comet holds another asset, or prices it with another feed, than the registry says
  | 'asset_mismatch'
  | 'feed_mismatch'
  | 'scale_mismatch'
  | 'total_reverted'
  | 'price_reverted'
  // a market quoted in its base asset without a USD price for the base, which validation refuses
  | 'usd_feed_missing'
  | 'usd_price_reverted'
);

type PositionValue = (
  | { status: 'success',   valueUsd: BigFixnum }
  // a price the registry states rather than reads, or reads from a feed it substitutes
  | { status: 'exception', valueUsd: BigFixnum, exceptions: PriceExceptionV1[] }
  | { status: 'error',     reason: PositionFailure }
);

type AssetCollateralValue = Compute.Spec<{
  name: 'assetCollateralValue',
  depends: [ CollateralAssetInfo, CollateralTotal, GetPrice ],
  expects: {
    apiHost:     string,
    nodeHost:    string,
    nodeKey:     string,
    network:     KnownNetwork.Name,
    // a Comet the registry materialized, which carries its market and the exceptions of its network
    contract:    RegistryComet,
    assetIndex:  number,
    blockNumber: Eth.BlockNumber,
  },
  returns: PositionValue,
}>;

/*
 * How one feed is priced. Decision D1 of the TOK-0 audit: a zero or fixed
 * price stated by the registry replaces the read altogether, since the feed it
 * describes is known not to answer; a remap reads the feed it names instead.
 */
type Price = (
  | { read: PriceFeedV1, exception: PriceExceptionV1 | null }
  | { fixed: BigFixnum, exception: PriceExceptionV1 }
);

function priceOf(annotation: RegistryAnnotation, feed: PriceFeedV1): Price {
  const exception = exceptionFor(annotation, feed.address);
  switch (exception?.kind) {
    case 'zero_price':
      return { fixed: BigFixnum.from({ value: 0, decimals: feed.decimals }), exception };
    case 'fixed_price':
      return { fixed: BigFixnum.from({ value: exception.price.value, decimals: exception.price.decimals }), exception };
    case 'deprecated_price_remap':
      return { read: exception.replacementPriceFeed, exception };
    default:
      return { read: feed, exception: null };
  }
}

const failed = (reason: PositionFailure): PositionValue => ({ status: 'error', reason });

/*
 * One position's value from what was read about it. `usd` is the feed that
 * converts the quote to USD: null for a market quoted in USD, or one whose
 * collateral price is zero, and 'missing' for a base-quoted market without a
 * USD price for its base.
 */
function positionValue(
  position: CollateralAssetV1,
  plans: { price: Price, usd: PriceFeedV1 | null | 'missing' },
  reads: { info: CollateralAssetInfoRead, total: CollateralTotalRead, price: PriceRead, usd: PriceRead | null },
): PositionValue {
  const { info, total, price, usd } = reads;
  if (info.status === 'reverted') {
    return failed('asset_info_reverted');
  }
  if (normalizeAddress(info.asset) !== position.token.address) {
    return failed('asset_mismatch');
  }
  if (normalizeAddress(info.priceFeed) !== position.priceFeed.address) {
    return failed('feed_mismatch');
  }
  if (!BigNumber.from(info.scale).eq(BigNumber.from(10).pow(position.token.decimals))) {
    return failed('scale_mismatch');
  }
  if (total.status === 'reverted') {
    return failed('total_reverted');
  }
  // nothing held is worth nothing, whatever its price says or fails to say
  if (BigNumber.from(total.total).isZero()) {
    return { status: 'success', valueUsd: BigFixnum.from({ value: 0 }) };
  }
  if (price.status === 'error') {
    return failed('price_reverted');
  }
  if (plans.usd === 'missing') {
    return failed('usd_feed_missing');
  }
  if (usd !== null && usd.status === 'error') {
    return failed('usd_price_reverted');
  }

  const amount = BigFixnum.from({ value: total.total, decimals: position.token.decimals });
  const quoted = amount.mul(price.price);
  const valueUsd = usd === null ? quoted : quoted.mul(usd.price);

  return plans.price.exception === null
    ? { status: 'success', valueUsd }
    : { status: 'exception', valueUsd, exceptions: [ plans.price.exception ] };
}

const { implement, join, pull1, value } = Compute.Functor<AssetCollateralValue>({});
const assetCollateralValue = implement({
  version: 1,
  compute({ apiHost, nodeHost, nodeKey, network, contract, assetIndex, blockNumber }) {
    const annotation = contract.registry;
    // the token list values the positions its market's collateral names, and no other
    const position   = annotation.market.collateralAssets.find(asset => asset.assetIndex === assetIndex);
    if (position === undefined) {
      throw new Error(`invariant violated: ${contract.address} has no collateral at index ${assetIndex}`);
    }

    const market = annotation.market;
    const price  = priceOf(annotation, position.priceFeed);
    /*
     * The quote decides whether a conversion is read, never the presence of a
     * USD feed: a USD-quoted market's base may carry one for other uses.
     *
     * The conversion is read as it is. A price exception describes a
     * collateral feed; a base asset's USD feed is changed in its market's
     * overlay instead, and every other reader of it reads it as it is, so an
     * exception written for a collateral that shares the feed must not reprice
     * the whole market here.
     */
    const usd = market.collateralValueQuote === 'usd' || price.exception?.kind === 'zero_price'
      ? null
      : market.baseAsset.usdPriceFeed === null
        ? 'missing' as const
        : market.baseAsset.usdPriceFeed;

    const frame = { apiHost, nodeHost, nodeKey, network, contract, blockNumber };
    const read  = (plan: Price) => 'fixed' in plan
      ? value<PriceRead>({ status: 'success', price: plan.fixed })
      : pull1({ getPrice: { ...frame, priceFeed: plan.read } });

    return join([
      [
        pull1({ collateralAssetInfo: { ...frame, assetIndex } }),
        pull1({ collateralTotal: { ...frame, token: position.token.address } }),
        read(price),
        usd === null || usd === 'missing' ? value<PriceRead | null>(null) : pull1({ getPrice: { ...frame, priceFeed: usd } }),
      ] as const,
      ([ info, total, collateralPrice, usdPrice ]) => positionValue(
        position,
        { price, usd },
        {
          info:  info as CollateralAssetInfoRead,
          total: total as CollateralTotalRead,
          price: collateralPrice as PriceRead,
          usd:   usdPrice as PriceRead | null,
        },
      ),
    ]);
  },
});

export type { PositionFailure, PositionValue };
export { AssetCollateralValue, assetCollateralValue, positionValue, priceOf };
