import { BigNumber } from '@ethersproject/bignumber';

import * as Eth         from '../../eth-constants.js';
import * as abiFunction from '../abi-function.js';

import { AssetInfoStructAbi } from './asset-info.js';

/*
 * What a Comet says about one of its collateral assets: the token, the feed
 * that prices it, and its scale.
 *
 * Unlike assetInfo, a revert is an answer rather than a failure. The collateral
 * value of a chain reads every collateral of every market in one evaluation,
 * and an index a Comet does not have is a fact about that market at that
 * block: it must not fail the read of every other market with it.
 */
type CollateralAssetInfoRead = (
  | { status: 'success', asset: Eth.Address, priceFeed: Eth.Address, scale: BigNumber }
  | { status: 'reverted', message: string }
);

type CollateralAssetInfo = abiFunction.Spec<{
  name: 'collateralAssetInfo',
  expects: { assetIndex: number },
  returns: CollateralAssetInfoRead,
}>;

const { implement } = abiFunction.Functor<CollateralAssetInfo>({});
const collateralAssetInfo = implement<CollateralAssetInfoRead>({
  version: 1,
  signature: `function getAssetInfo(uint8) view returns (${AssetInfoStructAbi} memory)`,
  parameters: ({ assetIndex }) => [ assetIndex ],
  parser: ([{ asset, priceFeed, scale }]) => ({ status: 'success', asset, priceFeed, scale }),
  reverted: ({ message }) => ({ status: 'reverted', message }),
});

export { CollateralAssetInfo, CollateralAssetInfoRead, collateralAssetInfo };
