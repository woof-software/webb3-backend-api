import { BigFixnum } from '../../bigfixnum.js';
import * as Eth      from '../../eth-constants.js';
import * as Compute  from '../../symbolic/computation.js';
import * as Constant from '../../constants.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { GetPrice     } from '../comet/get-price.js';
import type { BasePrice    } from '../comet/base-price.js';
import type { TotalSupply  } from '../comet/total-supply.js';

import type { TotalsBasic                } from './totals-basic.js';
import type { BaseMinForRewards          } from './base-min-for-rewards.js';
import type { SupplyRewardsRatePerSecond } from './supply-rewards-rate-per-second.js';
import { Contract } from '../../well-known/contracts/utils.js';
import { usdBasePriceFeedFor } from './base-price-feed.js';

type SupplyRewardsApr = Compute.Spec<{
  name: 'supplyRewardsApr',
  depends: [
    // comet
    GetPrice,
    BasePrice,
    TotalSupply,
    // rewards
    TotalsBasic,
    BaseMinForRewards,
    SupplyRewardsRatePerSecond,
  ],
  expects: {
    apiHost: string,
    nodeHost: string,
    nodeKey: string,
    network: KnownNetwork.Name,
    contract: Contract, // comet contract
    blockNumber: Eth.BlockNumber,
    rewardsTokenPriceFeed: {
      address:  Eth.Address,
      decimals: number,
    },
  },
  returns: BigFixnum;
}>;

const { implement, pipe, pipe1 } = Compute.Functor<SupplyRewardsApr>({});
const supplyRewardsApr = implement({
  version: 1,
  compute({ apiHost, nodeHost, nodeKey, rewardsTokenPriceFeed, blockNumber, contract, network }) {
    /*
     * The base price in the unit the reward feed answers in: the market's own
     * base price, or its USD feed where the reward price is in USD and the
     * market quotes its base asset.
     */
    const usdBasePriceFeed = usdBasePriceFeedFor(contract);
    const basePriceComputation: { basePrice?: any, getPrice?: any } = usdBasePriceFeed === null
      ? { basePrice: { apiHost, nodeHost, nodeKey, blockNumber, contract, network } }
      : { getPrice:  { apiHost, nodeHost, nodeKey, priceFeed: usdBasePriceFeed, blockNumber, contract, network } };

    return pipe([
      {
        totalsBasic: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
        baseMinForRewards: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
        getPrice: { apiHost, nodeHost, nodeKey, priceFeed: rewardsTokenPriceFeed, blockNumber, contract, network },
        totalSupply: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
        supplyRewardsRatePerSecond: { apiHost, nodeHost, nodeKey, blockNumber, contract, network },
      },
      ({
        totalSupply,
        baseMinForRewards,
        supplyRewardsRatePerSecond,
        //
        getPrice: rewardsTokenPrice,
        totalsBasic: { totalSupplyBase },
      }) => pipe1([
        basePriceComputation,
        basePrice => {
          if (totalSupplyBase.lte(baseMinForRewards)) {
            return BigFixnum.from({ value: 0 });
          }

          const supplyValue = basePrice.mul(totalSupply);
          const rewardsValueAnnual = rewardsTokenPrice
            .mul(supplyRewardsRatePerSecond)
            .mul(Constant.secondsPerYear);

          return rewardsValueAnnual.div(supplyValue);
        },
      ])
    ]);
  }
});

export { SupplyRewardsApr, supplyRewardsApr };
