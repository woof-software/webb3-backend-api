import { BigFixnum } from '../../bigfixnum.js';
import * as Compute  from '../../symbolic/computation.js';

import type { Address, PriceExceptionV1, RegistryAnnotation } from '../../model/comet-registry.js';
import { registryOf } from '../../model/comet-registry.js';

import type { AssetInfo } from './asset-info.js';
import type { PriceRead, ReadPrice } from './read-price.js';

/*
 * The price of a collateral asset, or why it could not be read: one
 * collateral whose feed reverts leaves the rest of its market readable.
 */
type AssetPrice = Compute.Spec<{
  name: 'assetPrice',
  depends: [ AssetInfo, ReadPrice ],
  expects: AssetInfo['expects'],
  returns: PriceRead,
}>;

/*
 * What the version says about the feed a Comet reports for this asset.
 *
 * A feed that reverts, or that was retired with a last known answer, is an
 * exception the registry carries for its network: the operator reviewed it,
 * recorded why, and the version states it. Before the registry these were
 * branches on network and feed address compiled into this computation, which
 * meant a deprecated feed could only be handled by shipping a new Worker.
 */
function exceptionFor(annotation: RegistryAnnotation | null, priceFeed: Address): PriceExceptionV1 | null {
  const address = priceFeed.toLowerCase();
  return annotation?.priceExceptions.find(exception => exception.priceFeedAddress === address) ?? null;
}

/*
 * The scale of that feed, as the registry read it on chain. A feed this
 * version does not describe falls back to eight decimals, which is what every
 * caller assumed before the registry existed.
 */
const ASSUMED_DECIMALS = 8;

function decimalsOf(annotation: RegistryAnnotation | null, priceFeed: Address): number {
  const address = priceFeed.toLowerCase();
  const market  = annotation?.market;
  if (market === undefined) {
    return ASSUMED_DECIMALS;
  }
  const feeds = [
    market.baseAsset.priceFeed,
    ...(market.baseAsset.usdPriceFeed === null ? [] : [ market.baseAsset.usdPriceFeed ]),
    ...market.collateralAssets.map(asset => asset.priceFeed),
  ];
  return feeds.find(feed => feed.address === address)?.decimals ?? ASSUMED_DECIMALS;
}

const { implement, pipe1, pull1 } = Compute.Functor<AssetPrice>({});
const assetPrice = implement({
  // 1: a price that reverts is answered, not thrown
  version: 1,
  compute: ({ apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network }) => pipe1([
    { assetInfo: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network } },
    ({ priceFeed }) => {
      const annotation = registryOf(contract);
      const exception  = exceptionFor(annotation, priceFeed);

      if (exception !== null) {
        switch (exception.kind) {
          case 'zero_price':
            return { status: 'success', price: BigFixnum.from({ decimals: decimalsOf(annotation, priceFeed), value: 0 }) };
          case 'fixed_price':
            return { status: 'success', price: BigFixnum.from({ decimals: exception.price.decimals, value: exception.price.value }) };
          case 'deprecated_price_remap':
            return pull1({
              readPrice: {
                apiHost,
                nodeHost,
                nodeKey,
                network,
                contract,
                blockNumber,
                priceFeed: exception.replacementPriceFeed,
              },
            });
        }
      }

      return pull1({
        readPrice: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          contract,
          blockNumber,
          priceFeed: {
            address:  priceFeed,
            decimals: decimalsOf(annotation, priceFeed),
          },
        },
      });
    },
  ]),
});

export { AssetPrice, assetPrice };
