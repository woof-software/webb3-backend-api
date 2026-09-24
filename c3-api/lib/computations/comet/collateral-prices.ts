import * as Eth     from '../../eth-constants.js';
import * as Compute from '../../symbolic/computation.js';

import type { AssetInfo  } from './asset-info.js';
import type { AssetPrice } from './asset-price.js';
import type { NumAssets  } from './num-assets.js';
import type { PriceRead  } from './read-price.js';

/*
 * The price read of every collateral asset of a market, in the order the
 * Comet numbers them, so a summary can say which of them could not be read.
 */
type CollateralPrices = Compute.Spec<{
  name: 'collateralPrices',
  depends: [ NumAssets, AssetInfo, AssetPrice ],
  expects: NumAssets['expects'],
  returns: Array<{ asset: Eth.Address, read: PriceRead }>,
}>;

const { implement, join, pipe1, pull } = Compute.Functor<CollateralPrices>({});
const collateralPrices = implement({
  version: 1,
  compute({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) {
    return pipe1([
      { numAssets: { apiHost, nodeHost, nodeKey, blockNumber, contract, network } },
      numAssets => join([
        Array.from({ length: numAssets }, (_, assetNumber) => pull({
          assetInfo:  { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network },
          assetPrice: { apiHost, nodeHost, nodeKey, assetNumber, blockNumber, contract, network },
        })),
        results => results.map(({ assetInfo, assetPrice }) => ({ asset: assetInfo.asset, read: assetPrice })),
      ]),
    ]);
  },
});

export { CollateralPrices, collateralPrices };
