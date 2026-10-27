import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import * as Fallible     from '../../fallible/fallible.js';

import { BigFixnum } from '../../bigfixnum.js';

import type { BlockRefV1, PriceExceptionV1 } from '../../model/comet-registry.js';

import type {
  BasePrice,
  BaseUsdPrice,
  PriceError,
  TotalBorrow,
  TotalSupply,
  Utilization,
} from '../comet.js';
import { convertsToUsd } from '../comet/base-usd-price.js';
import { reportRevert } from '../comet/get-price.js';
import type { EthGetBlockHeader } from '../evm/eth-get-block-header.js';

import type { BorrowApr } from './borrow-apr.js';
import type { SupplyApr } from './supply-apr.js';
import { type Collateral, type Collaterals, collateralValue } from './collaterals.js';
import { collateralStatusOf, type CollateralStatus, type MarketIdentity, type MarketSummary } from './market-summary.js';

/*
 * The summary of a market at the latest block, as the summary route answers
 * it: what marketSummary reports, and the base price its totals are valued
 * at; and, for discovery, what the market holds of each collateral in USD and
 * the block it read that at (summary-tokens.ts), which the route answers in
 * fields of its own.
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
 *
 * A collateral's value is what the market holds of it, at its price, converted
 * to USD as the totals are: so the values that are known add up to
 * totalCollateralValueUsd, where that is reported. What the market holds none
 * of is worth nothing, whatever its price says or fails to say, and a price of
 * zero is nothing in USD whatever converts it. A value is null where the
 * Comet holds another asset at the collateral's index, where its price could
 * not be read, or where what converts it to USD could not.
 *
 * A remap whose replacement reverts at the block while the feed it replaces
 * answers values its collateral at that feed's price, as the totals are, and
 * names no exception (asset-price.ts). The block is within a minute of the
 * latest, after the replacement was deployed — the registry read its decimals
 * on chain when an overlay named it — so the replacement has stopped
 * answering, and this summary reports its revert as a feed that reverts is
 * reported (get-price.ts): naming the replacement and the Comet, at the
 * block, with the replacement's own message, once a minute per network and
 * feed, whatever the market holds of the collateral. Where neither answers,
 * the price read has reported the replacement already, and its price carries
 * nothing to report. marketSummary reads the same prices and reports nothing
 * of them: the history it makes reads days older than the replacement too,
 * where its revert is expected. The report is made as the summary is
 * computed, so a minute already cached (market-minutely-summary.ts) reports
 * nothing, as it reads no feed.
 */

// a price exception of the registry as a summary names it, whatever the version that answers says of it besides
type AppliedException = Pick<PriceExceptionV1, 'kind' | 'priceFeedAddress'>;

/*
 * A collateral as the latest summary reports it: its status, its value in USD
 * or null, and the exception that priced it, which a value that is nothing
 * held or not known has none of.
 */
type ValuedCollateral = CollateralStatus & {
  valueUsd:  BigFixnum | null,
  exception: AppliedException | null,
};

// what the summary reports of a market however its base asset was priced
type Reported = {
  borrowApr:              string,
  supplyApr:              string,
  totalCollateralValue:   string,
  utilization:            string,
  collateralAssetSymbols: string[],
  collaterals:            ValuedCollateral[],
  // the block the market was read at, or null where the node did not give its header
  marketBlock:            BlockRefV1 | null,
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
    EthGetBlockHeader,
  ],
  expects: MarketSummary['expects'],
  returns: (
    | MarketIdentity & { status: 'success' | 'partially' } & Reported & Priced
    | MarketIdentity & PriceError & Reported & Partial<Priced>
  ),
}>;

// what a collateral is worth in USD, by the rules above, given what converts a total to USD, or null where that could not be read
function valueUsdOf({ totalCollateral, price }: Collateral, inUsd: ((total: BigFixnum) => BigFixnum) | null): BigFixnum | null {
  if (totalCollateral === null) {
    return null;
  }
  if (totalCollateral.value.isZero()) {
    return BigFixnum.from({ value: 0 });
  }
  if (price.status === 'error') {
    return null;
  }
  const quoted = totalCollateral.mul(price.price);
  return quoted.value.isZero() ? quoted : inUsd === null ? null : inUsd(quoted);
}

function valuedOf(collateral: Collateral, inUsd: ((total: BigFixnum) => BigFixnum) | null): ValuedCollateral {
  const { totalCollateral, price } = collateral;
  const valueUsd = valueUsdOf(collateral, inUsd);
  const held     = totalCollateral !== null && !totalCollateral.value.isZero();
  const priced   = held && valueUsd !== null ? price.exception : null;
  return {
    ...collateralStatusOf(collateral),
    valueUsd,
    exception: priced === null ? null : { kind: priced.kind, priceFeedAddress: priced.priceFeedAddress },
  };
}

const { implement, pipe } = Compute.Functor<MarketLatestSummary>({});
const marketLatestSummary = implement({
  // 6: with each collateral's value in USD and the exception that priced it, and the block the market was read at
  version: 6,
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
        // beside the reads of the first round, and once for every market read at the same block
        ethGetBlockHeader: { apiHost, nodeHost, nodeKey, network, blockNumber: block.number },
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
        ethGetBlockHeader: header,
      }): MarketLatestSummary['returns'] => {
        // a remap's replacement that has stopped answering is reported, and answered in nothing (above)
        for (const { price: { replacementRevert } } of held) {
          if (replacementRevert !== undefined) {
            reportRevert(replacementRevert.message, replacementRevert.feed, contract.address, network, block.number);
          }
        }
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
        const collaterals = held.map(collateral => valuedOf(collateral, inUsd));
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
          marketBlock: header,
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

export type {
  AppliedException,
  ValuedCollateral,
};

export {
  MarketLatestSummary,
  marketLatestSummary,
};
