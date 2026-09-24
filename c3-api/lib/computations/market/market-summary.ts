import * as Eth     from '../../eth-constants.js';
import * as Key     from '../../symbolic/key.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import * as Fallible from "../../fallible/fallible.js";

import {
  Utilization,
  type BasePriceRead,
  type TotalBorrow,
  type TotalSupply,
  type BaseUsdPrice,
  type CollateralPrices,
} from '../comet.js';

import type { BorrowApr } from './borrow-apr.js';
import type { SupplyApr } from './supply-apr.js';
import type { TotalCollateralValue } from './total-collateral-value.js';
import { Comet, StandaloneContract } from '../../well-known/contracts/types.js';
import { CollateralAssetSymbols } from '../comet/collateral-asset-symbols.js';

/*
 * How much of a market could be priced. Every read of a price goes through
 * the feed's latestRoundData, which reverts once Chainlink retires the feed:
 *
 * - success:   every price was read.
 * - partially: the base asset was priced, and at least one collateral was
 *              not; the totals leave that collateral out, and `collaterals`
 *              says which it was.
 * - error:     the base asset could not be priced, so nothing of the market
 *              can be valued; only what identifies it is reported.
 */
type MarketIdentity = {
  chainId: number,
  comet: {
    address: Eth.Address,
  },
};

type CollateralStatus = (
  & { address: Eth.Address, symbol: string }
  & ({ status: 'success' } | { status: 'error', message: string })
);

type MarketSummary = Compute.Spec<{
  name: 'marketSummary',
  depends: [
    BasePriceRead,
    BaseUsdPrice,
    BorrowApr,
    SupplyApr,
    TotalBorrow,
    TotalSupply,
    TotalCollateralValue,
    CollateralPrices,
    CollateralAssetSymbols,
    Utilization,
  ],
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    block:    Eth.Block,       // block at which to compute summary
    network:  KnownNetwork.Name, // network on which market is deployed
    contract: Eth.Contract<StandaloneContract<Comet>>,    // comet contract for the market
  },
  returns: (
    | MarketIdentity & {
        status:  'error',
        message: string,
      }
    | MarketIdentity & {
        status: 'success' | 'partially',
        supplyApr: string,
        borrowApr: string,
        totalBorrowValue: string,
        totalSupplyValue: string,
        totalCollateralValue: string,
        utilization: string,
        baseUsdPrice: string,
        collateralAssetSymbols: string[],
        collaterals: CollateralStatus[],
      }
  ),
}>;

const { implement, pipe } = Compute.Functor<MarketSummary>({});
const marketSummary = implement({
  // 6: every price read reports a status instead of failing the summary
  version: 6,
  /*
   * validate that the block requested does not predate the market
   * contract creation block.
   */
  index: Index.Make<MarketSummary['expects']>({
    project: context => context,
    includes(context) {
      return this.covers(context);
    },
    covers({ contract, block }) {
      return block.number >= contract.creation.block.number;
    },
  }),
  /*
   * Key the computation by just block number, omit the timestamp.
   */
  key(name, { block, ...context }) {
    return Key.toKey(name, { block: block.number, ...context });
  },
  /*
   * Compute a market summary at the requested sampleBlock.
   */
  compute({ apiHost, nodeHost, nodeKey, network, contract, block }) {
    const { chainId } = Fallible.must(
      KnownNetwork.lookup({ name: network })
    );

    /*
     * Aggregate and format summary data for display.
     */
    return pipe([
      {
        borrowApr: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        supplyApr: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        basePriceRead: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        baseUsdPrice: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        totalBorrow: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        totalSupply: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        totalCollateralValue: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        collateralPrices: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        collateralAssetSymbols: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
        utilization: { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network },
      },
      ({
        borrowApr,
        supplyApr,
        basePriceRead,
        baseUsdPrice,
        totalBorrow,
        totalSupply,
        totalCollateralValue,
        collateralPrices,
        collateralAssetSymbols,
        utilization,
      }): MarketSummary['returns'] => {
        const identity = {
          chainId,
          comet: {
            address: contract.address,
          },
        };
        if (basePriceRead.status === 'error') {
          return { ...identity, status: 'error', message: basePriceRead.message };
        }
        if (baseUsdPrice.status === 'error') {
          return { ...identity, status: 'error', message: baseUsdPrice.message };
        }
        const collaterals = collateralPrices.map(({ asset, read }, index): CollateralStatus => ({
          address: asset,
          symbol:  collateralAssetSymbols[index],
          ...(read.status === 'success'
            ? { status: 'success' as const }
            : { status: 'error' as const, message: read.message }),
        }));
        return {
          ...identity,
          status: collaterals.some(collateral => collateral.status === 'error') ? 'partially' : 'success',
          borrowApr: borrowApr.toString(),
          supplyApr: supplyApr.toString(),
          totalBorrowValue: totalBorrow.mul(basePriceRead.price).toString(),
          totalSupplyValue: totalSupply.mul(basePriceRead.price).toString(),
          totalCollateralValue: totalCollateralValue.toString(),
          utilization: utilization.toString(),
          baseUsdPrice: baseUsdPrice.price.toString(),
          collateralAssetSymbols: collateralAssetSymbols,
          collaterals,
        };
      },
    ]);
  },
});

export type {
  CollateralStatus,
  MarketIdentity,
};

export {
  MarketSummary,
  marketSummary,
};
