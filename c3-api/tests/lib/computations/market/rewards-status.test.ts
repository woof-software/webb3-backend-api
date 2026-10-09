import t from 'tap';

import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Compute    from '../../../../lib/symbolic/computation.js';
import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as market  from '../../../../lib/computations/market.js';
import * as rewards from '../../../../lib/computations/rewards.js';
import * as account from '../../../../lib/computations/account.js';

import { fixtureCatalog } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * What the rewards of a market report when a price they are valued in
 * reverts: the market, and only what identifies it, with the node's message.
 * The computations run on the real evaluator, over dependencies that answer
 * from a table instead of a node.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network = 'ethereum-mainnet' as const;
const usdt    = fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === 'usdt')!.comet;
const block   = { number: 50_000_000, timestamp: 1_790_000_000 };
const context = { apiHost: '', nodeHost: '', nodeKey: '', network, contract: usdt };

// the COMP / USD feed the fixture's USDT market values its rewards in
const REWARD_FEED = '0xdbd020caef83efd542f4de03e3cf0c28a4428bd5';

const read     = (value: number) => ({ status: 'success' as const, price: BigFixnum.from({ value }) });
const reverted = { status: 'error' as const, message: 'execution reverted' };
const apr      = (value: number) => ({ status: 'success' as const, apr: BigFixnum.from({ decimals: 2, value }) });
const failed   = { chainId: 1, comet: { address: usdt.address }, ...reverted };

function stub(answer: (context: any) => unknown) {
  return Compute.Functor<any>({}).implement({ version: 0, compute: context => answer(context) });
}

function evaluator(computations: Record<string, unknown>) {
  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  return Evaluator.instantiate<any>(computations as any, { cache, debug, flags });
}

t.test('a rewards rate reports a price it could not read', async t => {
  const rateOf = (prices: { reward: unknown, base: unknown }) => {
    const { evaluate, pull1 } = evaluator({
      supplyRewardsApr:           rewards.supplyRewardsApr,
      totalsBasic:                stub(() => ({ totalSupplyBase: BigFixnum.from({ value: 100 }) })),
      baseMinForRewards:          stub(() => BigFixnum.from({ value: 1 })),
      totalSupply:                stub(() => BigFixnum.from({ value: 100 })),
      supplyRewardsRatePerSecond: stub(() => BigFixnum.from({ value: 0 })),
      getPrice:                   stub(() => prices.reward),
      basePrice:                  stub(() => prices.base),
    });
    return evaluate(pull1({
      supplyRewardsApr: {
        ...context,
        blockNumber: block.number,
        rewardsTokenPriceFeed: { address: REWARD_FEED, decimals: 8 },
      },
    }));
  };

  t.strictSame(await rateOf({ reward: reverted, base: read(1) }), reverted, 'the reward price');
  t.strictSame(await rateOf({ reward: read(50), base: reverted }), reverted, 'the base price');
  t.match(await rateOf({ reward: read(50), base: read(1) }), { status: 'success' });
});

function marketRewardsOf(answers: { rewardPrice: unknown, supplyRewardsApr: unknown }) {
  const { evaluate, pull1 } = evaluator({
    marketRewards:    market.marketRewards,
    baseBorrowMin:    stub(() => BigFixnum.from({ value: 100 })),
    supplyRewardsApr: stub(() => answers.supplyRewardsApr),
    borrowRewardsApr: stub(() => apr(2)),
    getPrice:         stub(() => answers.rewardPrice),
  });
  return evaluate(pull1({ marketRewards: { ...context, block } }));
}

t.test('the rewards of a market whose reward feed reverts are its error', async t => {
  t.strictSame(await marketRewardsOf({ rewardPrice: reverted, supplyRewardsApr: apr(1) }), failed);
  t.strictSame(await marketRewardsOf({ rewardPrice: read(50), supplyRewardsApr: reverted }), failed,
    'as are those whose rates could not be measured');

  t.match(await marketRewardsOf({ rewardPrice: read(50), supplyRewardsApr: apr(1) }), {
    status:         'success',
    chainId:        1,
    rewardAsset:    { price: '50' },
    earnRewardsApr: '0.01',
  });
});

t.test('a rewards summary reports a rate it could not measure', async t => {
  const summaryOf = (supply: unknown) => {
    const { evaluate, pull1 } = evaluator({
      rewardsSummary:             rewards.rewardsSummary,
      supplyRewardsApr:           stub(() => supply),
      borrowRewardsApr:           stub(() => apr(2)),
      supplyRewardsRatePerSecond: stub(() => BigFixnum.from({ value: 0 })),
      borrowRewardsRatePerSecond: stub(() => BigFixnum.from({ value: 0 })),
    });
    return evaluate(pull1({
      rewardsSummary: { ...context, block, rewardsTokenPriceFeed: { address: REWARD_FEED, decimals: 8 } },
    }));
  };

  t.strictSame(await summaryOf(reverted), reverted);
  t.match(await summaryOf(apr(1)), { status: 'success', supplyRewardsApr: '0.01' });
});

t.test('the rewards of an account report the market that cannot be valued', async t => {
  const rewardsOf = (marketRewards: unknown) => {
    const { evaluate, pull1 } = evaluator({
      accountRewards:  account.accountRewards,
      marketRewards:   stub(() => marketRewards),
      balanceOf:       stub(() => BigFixnum.from({ value: 1 })),
      borrowBalanceOf: stub(() => BigFixnum.from({ value: 2 })),
      erc20Balance:    stub(() => BigFixnum.from({ value: 3 })),
      getRewardOwed:   stub(() => BigFixnum.from({ value: 4 })),
    });
    return evaluate(pull1({
      accountRewards: { ...context, block, account: '0x1111111111111111111111111111111111111111' },
    }));
  };

  t.strictSame(await rewardsOf(failed), failed, 'with no amounts');
  const read = await rewardsOf({ status: 'success', chainId: 1, comet: { address: usdt.address } });
  t.match(read, { status: 'success', chainId: 1 });
  t.equal((read as any).amountOwed.toString(), '4');
});
