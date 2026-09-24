import * as Eth                from '../../lib/eth-constants.js';
import * as Fallible           from '../../lib/fallible/fallible.js';
import { snakeifyCamelObject } from '../../lib/camel-snake.js';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import type { CatalogMarket } from '../registry/catalog.js';

import { eachOrMarketError, isMarketError, succeeded } from '../market-status.js';

import { AccountRouteData } from '../router.js';

import { Context } from './handlers.js';

import * as cometRewards        from '../../lib/computations/comet-rewards.js';
import * as accountComputations from '../../lib/computations/account.js';

/*
 * The markets whose account rewards the registry says are claimable, grouped
 * by the rewards contract that holds them.
 *
 * The grouping is not cosmetic: one Sleuth query reads the reward configs of
 * every market it is given from a single CometRewards, so markets that do not
 * share one must not be batched together. Networks without rewards used to be
 * excluded by name; the version now states it per market.
 */
function rewardGroups(
  catalog: AccountRouteData['catalog'],
  networks: KnownNetwork.Name[],
): Array<{ network: KnownNetwork.Name, contracts: CatalogMarket['comet'][] }> {
  return networks.flatMap(network => {
    const byRewards = new Map<string, CatalogMarket['comet'][]>();
    for (const entry of catalog.marketsOn(network)) {
      const rewards = entry.market.contracts.rewards;
      if (!entry.market.capabilities.accountRewards || rewards === null) {
        continue;
      }
      byRewards.set(rewards, [ ...(byRewards.get(rewards) ?? []), entry.comet ]);
    }
    return [ ...byRewards.values() ].map(contracts => ({ network, contracts }));
  });
}

async function rewardsSummary(
  { apiHost, nodeHost, nodeKey, account, testnets, catalog }: AccountRouteData,
  context: Context
): Promise<Response> {
  const allNetworks = KnownNetwork.getNames({
    includeTestnets: testnets === 'include',
  });

  const evaluator = context.evaluator;

  const groups = rewardGroups(catalog, allNetworks);

  const accountRewards = await Promise.all(groups.map(async ({ network, contracts: groupContracts }) => {
    const rewards = await eachOrMarketError(network, groupContracts, contracts => evaluator.evaluate(evaluator.pipe1([
      { ethGetBlock: { apiHost, nodeHost, nodeKey, blockReference: 'latest', network } },
      latestBlock => {

          const getRewardConfigsSleuth = Fallible.must(cometRewards.getRewardConfigsSleuth.index.project({
            apiHost,
            nodeHost,
            nodeKey, 
            network,            
            block: latestBlock,
            cometMarkets: contracts
          }));

          return evaluator.pipe1([
            { getRewardConfigsSleuth },
            rewardConfigs => {
              return evaluator.split(rewardConfigs.map((rewardConfig, index) =>{
                if (rewardConfig.rewardConfig.rewardToken === Eth.NullAddress) {
                  return evaluator.value('SKIP' as const);
                }
                const accountRewards = Fallible.must(accountComputations.accountRewards.index.project({
                  apiHost,
                  nodeHost,
                  nodeKey,
                  account,
                  network,
                  contract: contracts[index],
                  block: latestBlock,
                }));
                return evaluator.pull1({ accountRewards });
              }));
            }
          ]);
      },
    ])));

    type NotSkip = Exclude<(typeof rewards[number]), 'SKIP'>;

    return rewards
      .filter((r): r is NotSkip => r !== 'SKIP')
      .map((reward) => isMarketError(reward) ? reward : succeeded({
        ...reward,
        amountOwed: reward.amountOwed.toString(),
        walletBalance: reward.walletBalance.toString(),
        supplyBalance: reward.supplyBalance.toString(),
        borrowBalance: reward.borrowBalance.toString(),
      }))
      .map(snakeifyCamelObject);
  }));

  const flattedAccountRewards = accountRewards.flat();
  return new Response(JSON.stringify(flattedAccountRewards));
}

export { rewardGroups, rewardsSummary };
