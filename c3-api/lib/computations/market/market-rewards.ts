import * as Eth      from '../../eth-constants.js';
import * as Fallible from '../../fallible/fallible.js';

import { BigFixnum }  from '../../bigfixnum.js';
import { registryOf } from '../../model/comet-registry.js';

import * as Key     from '../../symbolic/key.js';
import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';
import {
  Comet,
  StandaloneContract,
} from '../../well-known/contracts/types.js';

import {
  GetPrice,
  BaseBorrowMin,
  type PriceError,
  type PriceRead,
} from '../comet.js';

import type { MarketIdentity } from './market-summary.js';

import {
  BorrowRewardsApr,
  SupplyRewardsApr,
} from '../rewards.js';

type MarketRewards = Compute.Spec<{
  name: 'marketRewards';
  depends: [BaseBorrowMin, SupplyRewardsApr, BorrowRewardsApr, GetPrice];
  expects: {
    apiHost: string;
    nodeHost: string;
    nodeKey: string;
    block: Eth.Block;
    network: KnownNetwork.Name; // network on which market is deployed
    contract: Eth.Contract<StandaloneContract<Comet>>; // comet contract for the market
  };
  // a price the rewards are valued in that reverts leaves only what identifies the market
  returns: MarketIdentity & PriceError | {
    status: 'success';
    chainId: number;
    comet: {
      address: Eth.Address;
    };
    cometRewards: {
      address: Eth.Address;
    };
    baseAsset: {
      address: string;
      decimals: number;
      description: string | null;
      symbol: string;
      minBorrow: string;
      priceFeed: string;
    };
    rewardAsset: {
      address: string;
      decimals: number;
      description: string | null;
      price: string;
      symbol: string;
    };
    earnRewardsApr: string;
    borrowRewardsApr: string;
  };
}>;

/*
 * The base asset of a market as its reviewed decisions name it, not as its
 * token reports itself on chain. Tokens get renamed — Tether's USDT is USD₮0
 * on Arbitrum and USDT0 on Polygon — and bridged USDC calls itself plain USDC
 * beside the native market of the same network, so the on-chain symbol would
 * give two markets of one network the same label. A contract that did not
 * come from the registry has no decisions and keeps what it carries.
 */
function baseAssetLabel(contract: Eth.Contract<StandaloneContract<Comet>>): { symbol: string, description: string | null } {
  const market = registryOf(contract)?.market;
  return {
    symbol:      market?.displayName ?? contract.base.asset.symbol,
    description: market?.baseAsset.displayName ?? (contract.base.asset.description as string | undefined) ?? null,
  };
}

const { implement, pipe, pipe1 } = Compute.Functor<MarketRewards>({});
const marketRewards = implement({
  // 5: a price that reverts is reported as the market's status
  version: 5,
  index: Index.MinutelyBlockIndex,
  key(name, { block, ...context }) {
    const { block: projected } = Fallible.must(this.index.project({ block, ...context }));
    // the summary reports the market's labels, which its contract's key leaves out
    const { symbol, description } = baseAssetLabel(context.contract);
    return Key.toKey(name, { block: projected.number, label: `${symbol}|${description ?? ''}`, ...context });
  },
  compute({ apiHost, nodeHost, nodeKey, contract, network, block }) {
    const projected = Fallible.must(this.index.project({
        apiHost, nodeHost, nodeKey, contract, network, block
      }));
    const blockNumber = projected.block.number;
    const { chainId } = Fallible.must(
      KnownNetwork.lookup({ name: network })
    );

    const annotation  = registryOf(contract);
    const rewardAsset = annotation?.market.rewardAsset ?? null;

    /*
     * The feed that prices the reward token, as the registry states it. A
     * market without one — Scroll, which has no COMP feed — is reported with
     * no reward price and no reward rate rather than by name, and a market
     * whose reward feed quotes the base asset is converted to USD with the
     * market's USD feed, so every market reports its reward price in the same
     * unit.
     */
    const rewardPriceFeed = annotation === null
      ? contract.rewards.priceFeed
      : rewardAsset?.priceFeed ?? null;
    const usdConversionFeed = rewardAsset?.priceFeedQuote === 'base'
      ? annotation?.market.baseAsset.usdPriceFeed ?? null
      : null;

    const rewards = {
      baseBorrowMin: { apiHost, nodeHost, nodeKey, contract, network, blockNumber },
      supplyRewardsApr: {
        apiHost,
        nodeHost,
        nodeKey,
        contract,
        network,
        blockNumber,
        rewardsTokenPriceFeed: contract.rewards.priceFeed,
      },
      borrowRewardsApr: {
        apiHost,
        nodeHost,
        nodeKey,
        contract,
        network,
        blockNumber,
        rewardsTokenPriceFeed: contract.rewards.priceFeed,
      },
    };

    /*
     * Aggregate and format summary data for display.
     */
    const summary = (
      { baseBorrowMin, supplyRewardsApr, borrowRewardsApr }: {
        baseBorrowMin:    BigFixnum,
        supplyRewardsApr: BigFixnum,
        borrowRewardsApr: BigFixnum,
      },
      rewardAssetPrice: string,
    ): MarketRewards['returns'] => {
      const baseAsset = baseAssetLabel(contract);
      const rewardAssetDescription =
        (contract.rewards.asset.description as string | undefined) ?? null;

      return {
        status: 'success',
        chainId,
        comet: {
          address: contract.address,
        },
        cometRewards: {
          address: contract.rewards.contract.address,
        },
        baseAsset: {
          address: contract.base.asset.address,
          decimals: contract.base.asset.decimals,
          description: baseAsset.description,
          symbol: baseAsset.symbol,
          minBorrow: baseBorrowMin.toString(),
          priceFeed: contract.base.priceFeed.address,
        },
        rewardAsset: {
          address: contract.rewards.asset.address,
          decimals: contract.rewards.asset.decimals,
          description: rewardAssetDescription,
          price: rewardAssetPrice,
          symbol: contract.rewards.asset.symbol,
        },
        earnRewardsApr: supplyRewardsApr.toString(),
        borrowRewardsApr: borrowRewardsApr.toString(),
      };
    };

    /*
     * Without a feed there is nothing to value the rewards in, and the APR
     * computations would read the placeholder feed at the zero address, which
     * reverts. Only the minimum borrow is read; the rates are zero.
     */
    if (rewardPriceFeed === null) {
      const none = BigFixnum.from({ value: 0 });
      return pipe([
        { baseBorrowMin: rewards.baseBorrowMin },
        ({ baseBorrowMin }) => summary({ baseBorrowMin, supplyRewardsApr: none, borrowRewardsApr: none }, '0.0'),
      ]);
    }

    return pipe([
      {
        ...rewards,
        getPrice: {
          apiHost,
          nodeHost,
          nodeKey,
          contract,
          network,
          priceFeed: rewardPriceFeed,
          blockNumber,
        },
      },
      ({ getPrice: rewardAssetPrice, baseBorrowMin, supplyRewardsApr, borrowRewardsApr }) => {
        const failure = ({ status, message }: PriceError): MarketRewards['returns'] => (
          { chainId, comet: { address: contract.address }, status, message }
        );
        if (rewardAssetPrice.status === 'error') {
          return failure(rewardAssetPrice);
        }
        if (supplyRewardsApr.status === 'error') {
          return failure(supplyRewardsApr);
        }
        if (borrowRewardsApr.status === 'error') {
          return failure(borrowRewardsApr);
        }
        const results = { baseBorrowMin, supplyRewardsApr: supplyRewardsApr.apr, borrowRewardsApr: borrowRewardsApr.apr };
        if (usdConversionFeed === null) {
          return summary(results, rewardAssetPrice.price.toString());
        }
        return pipe1([
          {
            getPrice: {
              apiHost,
              nodeHost,
              nodeKey,
              contract,
              network,
              priceFeed: usdConversionFeed,
              blockNumber,
            },
          },
          (baseAssetUsdPrice: PriceRead) => baseAssetUsdPrice.status === 'error'
            ? failure(baseAssetUsdPrice)
            : summary(results, rewardAssetPrice.price.mul(baseAssetUsdPrice.price).toString()),
        ]);
      },
    ]);
  },
});

export { MarketRewards, baseAssetLabel, marketRewards };
