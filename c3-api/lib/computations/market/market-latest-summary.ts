import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import * as Fallible     from '../../fallible/fallible.js';

import type { BigFixnum } from '../../bigfixnum.js';

import type {
  BasePrice,
  BaseUsdPrice,
  PriceError,
  TotalBorrow,
  TotalSupply,
  Utilization,
} from '../comet.js';
import { convertsToUsd } from '../comet/base-usd-price.js';

import type { BorrowApr } from './borrow-apr.js';
import type { SupplyApr } from './supply-apr.js';
import { type Collaterals, collateralValue } from './collaterals.js';
import { collateralStatusOf, type CollateralStatus, type MarketIdentity, type MarketSummary } from './market-summary.js';

/*
 * The summary of a market at the latest block, as the summary route answers
 * it: what marketSummary reports, and the base price its totals are valued
 * at.
 *
 * It is a computation of its own because a day of the history is the whole
 * of a marketSummary (market-day-summary.ts): a field, a read or a status
 * added there would be in every day of the history, and read for each one.
 *
 * Each field is reported where the reads it is made of were, and left out
 * where they were not. A market whose base asset could not be priced is an
 * error, as in marketSummary, but reports everything that does not need the
 * price that failed, where marketSummary reports only what identifies it: it
 * leaves out its base price and its totals where the base price could not be
 * read, its base asset's USD price where that could not, and a total in USD
 * where the total could not, or, on a market quoted in its base asset, the
 * USD price that converts it.
 */

// what the summary reports of a market however its base asset was priced
type Reported = {
  borrowApr:              string,
  supplyApr:              string,
  totalCollateralValue:   string,
  utilization:            string,
  collateralAssetSymbols: string[],
  collaterals:            CollateralStatus[],
};

// what is made of the prices of the base asset
type Priced = {
  totalBorrowValue:        string,
  totalSupplyValue:        string,
  totalBorrowValueUsd:     string,
  totalSupplyValueUsd:     string,
  totalCollateralValueUsd: string,
  baseUsdPrice:            string,
  basePrice:               string,
};

type MarketLatestSummary = Compute.Spec<{
  name: 'marketLatestSummary',
  depends: [
    BasePrice,
    BaseUsdPrice,
    BorrowApr,
    SupplyApr,
    TotalBorrow,
    TotalSupply,
    Utilization,
    Collaterals,
  ],
  expects: MarketSummary['expects'],
  returns: (
    | MarketIdentity & { status: 'success' | 'partially' } & Reported & Priced
    | MarketIdentity & PriceError & Reported & Partial<Priced>
  ),
}>;

const { implement, pipe } = Compute.Functor<MarketLatestSummary>({});
const marketLatestSummary = implement({
  // 5: with base_price and the totals in USD, and without reserves, the rate model or each collateral's price and parameters
  version: 5,
  compute({ apiHost, nodeHost, nodeKey, network, contract, block }) {
    const { chainId } = Fallible.must(
      KnownNetwork.lookup({ name: network })
    );
    const read = { apiHost, nodeHost, nodeKey, blockNumber: block.number, contract, network };

    return pipe([
      {
        basePrice:    read,
        baseUsdPrice: read,
        borrowApr:    read,
        supplyApr:    read,
        totalBorrow:  read,
        totalSupply:  read,
        utilization:  read,
        collaterals:  read,
      },
      ({
        basePrice,
        baseUsdPrice,
        borrowApr,
        supplyApr,
        totalBorrow,
        totalSupply,
        utilization,
        collaterals: held,
      }): MarketLatestSummary['returns'] => {
        const totals = basePrice.status === 'success'
          ? { borrow: totalBorrow.mul(basePrice.price), supply: totalSupply.mul(basePrice.price) }
          : null;
        const totalCollateral = collateralValue(held);
        // what converts a total to USD, as marketSummary converts it (inUsd), or null where that could not be read
        const inUsd = !convertsToUsd(contract.registry.market)
          ? (total: BigFixnum) => total
          : baseUsdPrice.status === 'success' ? (total: BigFixnum) => total.mul(baseUsdPrice.price) : null;
        const identity = {
          chainId,
          comet: {
            address: contract.address,
          },
        };
        const collaterals = held.map(collateralStatusOf);
        const fields: Reported & Partial<Priced> = {
          borrowApr: borrowApr.toString(),
          supplyApr: supplyApr.toString(),
          ...(totals === null ? {} : {
            totalBorrowValue: totals.borrow.toString(),
            totalSupplyValue: totals.supply.toString(),
          }),
          totalCollateralValue: totalCollateral.toString(),
          ...(totals === null || inUsd === null ? {} : {
            totalBorrowValueUsd: inUsd(totals.borrow).toString(),
            totalSupplyValueUsd: inUsd(totals.supply).toString(),
          }),
          ...(inUsd === null ? {} : { totalCollateralValueUsd: inUsd(totalCollateral).toString() }),
          utilization: utilization.toString(),
          ...(baseUsdPrice.status === 'success' ? { baseUsdPrice: baseUsdPrice.price.toString() } : {}),
          /*
           * What the totals are valued at, which marketSummary keeps to itself.
           * Only it turns any total back into an amount of the base asset: the
           * USD price is the same number only on a market quoted in USD, while
           * both are read through one feed, and on the WBTC market, whose feeds
           * answer in BTC, it is the price of BTC.
           */
          ...(basePrice.status === 'success' ? { basePrice: basePrice.price.toString() } : {}),
          collateralAssetSymbols: held.map(({ symbol }) => symbol),
          collaterals,
        };
        if (basePrice.status === 'error') {
          return { ...identity, status: 'error', message: basePrice.message, ...fields };
        }
        if (baseUsdPrice.status === 'error') {
          return { ...identity, status: 'error', message: baseUsdPrice.message, ...fields };
        }
        return {
          ...identity,
          status: collaterals.some(collateral => collateral.status === 'error') ? 'partially' : 'success',
          // both prices were read, so the fields carry the totals, in the market's unit and in USD, and both prices
          ...(fields as Reported & Priced),
        };
      },
    ]);
  },
});

export {
  MarketLatestSummary,
  marketLatestSummary,
};
