import t from 'tap';

import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Compute    from '../../../../lib/symbolic/computation.js';
import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as comet  from '../../../../lib/computations/comet.js';
import * as market from '../../../../lib/computations/market.js';

import { catalogOf } from '../../../../src/registry/catalog.js';

import { fixtureCatalog, loadRegistrySnapshotFixture } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * What a market summary reports when the price feeds it reads revert: the
 * summary computations run on the real evaluator, over dependencies that
 * answer from a table instead of a node.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network = 'ethereum-mainnet' as const;
const usdt    = fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === 'usdt')!.comet;
const block   = { number: 50_000_000, timestamp: 1_790_000_000 };

const COMP  = '0xc00e94Cb662C3520282E6f5717214004A7f26888';
const WUSDM = '0x57F5E098CaD7A3D1Eed53991D4d66C45C9AF7812';
// the retired wUSDM / USD feed the fixture's network prices at zero
const ZERO_PRICED_FEED = '0xe3a409ed15cd53afdefdd191ad945cec528a2496';

const one = (decimals = 8) => BigFixnum.from({ decimals, value: BigNumber.from(10).pow(decimals) });
const read     = (price: BigFixnum) => ({ status: 'success' as const, price });
const reverted = { status: 'error' as const, message: 'execution reverted' };

/*
 * A computation that answers from `answer` without reading anything.
 */
function stub(answer: (context: any) => unknown) {
  return Compute.Functor<any>({}).implement({ version: 0, compute: context => answer(context) });
}

function evaluator(computations: Record<string, unknown>) {
  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  return Evaluator.instantiate<any>(computations as any, { cache, debug, flags });
}

function summaryOf(answers: { basePriceRead?: unknown, baseUsdPrice?: unknown, collateralPrices: unknown }) {
  const { evaluate, pull1 } = evaluator({
    marketSummary:          market.marketSummary,
    basePriceRead:          stub(() => answers.basePriceRead ?? read(one())),
    baseUsdPrice:           stub(() => answers.baseUsdPrice ?? read(one())),
    borrowApr:              stub(() => BigFixnum.from({ decimals: 2, value: 5 })),
    supplyApr:              stub(() => BigFixnum.from({ decimals: 2, value: 3 })),
    totalBorrow:            stub(() => BigFixnum.from({ value: 10 })),
    totalSupply:            stub(() => BigFixnum.from({ value: 20 })),
    totalCollateralValue:   stub(() => BigFixnum.from({ value: 30 })),
    collateralPrices:       stub(() => answers.collateralPrices),
    collateralAssetSymbols: stub(() => [ 'COMP', 'wUSDM' ]),
    utilization:            stub(() => BigFixnum.from({ decimals: 2, value: 50 })),
  });
  return evaluate(pull1({ marketSummary: { apiHost: '', nodeHost: '', nodeKey: '', network, contract: usdt, block } }));
}

t.test('a market whose every price reads is a success', async t => {
  const summary = await summaryOf({
    collateralPrices: [ { asset: COMP, read: read(one()) }, { asset: WUSDM, read: read(one()) } ],
  });
  t.match(summary, {
    chainId: 1,
    status:  'success',
    totalBorrowValue: '10.0',
    collaterals: [
      { address: COMP,  symbol: 'COMP',  status: 'success' },
      { address: WUSDM, symbol: 'wUSDM', status: 'success' },
    ],
  });
  t.notOk('message' in (summary as any).collaterals[1], 'a collateral that reads carries no message');
});

t.test('a collateral that reverts makes the market partial', async t => {
  const summary = await summaryOf({
    collateralPrices: [ { asset: COMP, read: read(one()) }, { asset: WUSDM, read: reverted } ],
  });
  t.match(summary, {
    status: 'partially',
    totalBorrowValue: '10.0',
    collaterals: [
      { address: COMP,  status: 'success' },
      { address: WUSDM, status: 'error', message: 'execution reverted' },
    ],
  }, 'the rest of the market is reported in full');
  t.notOk('message' in (summary as any), 'the market itself carries no message');
});

t.test('a base price that reverts makes the market an error', async t => {
  for (const answers of [ { basePriceRead: reverted }, { baseUsdPrice: reverted } ]) {
    const summary = await summaryOf({ ...answers, collateralPrices: [ { asset: COMP, read: read(one()) } ] });
    t.strictSame(summary, {
      chainId: 1,
      comet:   { address: usdt.address },
      status:  'error',
      message: 'execution reverted',
    }, 'nothing of the market can be valued, so only what identifies it is reported');
  }
});

t.test('the collateral value leaves out what could not be priced', async t => {
  const { evaluate, pull1 } = evaluator({
    totalCollateralValue: market.totalCollateralValue,
    numAssets:            stub(() => 2),
    assetTotalCollateral: stub(({ assetNumber }) => BigFixnum.from({ value: assetNumber === 0 ? 3 : 1_000 })),
    assetPrice:           stub(({ assetNumber }) => assetNumber === 0 ? read(BigFixnum.from({ value: 2 })) : reverted),
  });
  const total = await evaluate(pull1({
    totalCollateralValue: { apiHost: '', nodeHost: '', nodeKey: '', network, contract: usdt, blockNumber: block.number },
  }));
  t.equal(total.toString(), '6', 'three of the first at two, and none of the second');
});

t.test('a collateral the registry prices is never read', async t => {
  const reads: string[] = [];
  const { evaluate, pull1 } = evaluator({
    assetPrice: comet.assetPrice,
    assetInfo:  stub(({ assetNumber }) => ({ asset: COMP, scale: 1, priceFeed: assetNumber === 0 ? ZERO_PRICED_FEED : COMP })),
    readPrice:  stub(({ priceFeed }) => { reads.push(priceFeed.address); return reverted; }),
  });
  const context = { apiHost: '', nodeHost: '', nodeKey: '', network, contract: usdt, blockNumber: block.number };

  const priced = await evaluate(pull1({ assetPrice: { ...context, assetNumber: 0 } }));
  t.match(priced, { status: 'success' }, 'its exception answers for it');
  t.equal((priced as any).price.toString(), '0.0');

  t.strictSame(await evaluate(pull1({ assetPrice: { ...context, assetNumber: 1 } })), reverted, 'any other feed is read');
  t.strictSame(reads, [ COMP ]);
});

/*
 * A summary that could not read a price is cached like any other, since the
 * revert is a fact about that block. What makes it read again is the price
 * exception an operator adds: it changes the key every summary of the network
 * is cached under.
 */
t.test('a price exception retires the summaries cached before it', async t => {
  const snapshot = loadRegistrySnapshotFixture();
  const excepted = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(entry => entry.chainId !== 1 ? entry : {
      ...entry,
      priceExceptions: [ ...entry.priceExceptions, {
        kind:             'zero_price',
        priceFeedAddress: '0x4444444444444444444444444444444444444444',
        provenance:       'a feed that reverts',
        expiresAt:        null,
      } ],
    }),
  }).marketsOn(network).find(entry => entry.deploymentKey === 'usdt')!.comet;

  const keyOf = (contract: typeof usdt) => market.marketSummary.key(
    'marketSummary',
    { apiHost: '', nodeHost: '', nodeKey: '', network, contract, block },
  );
  t.not(await keyOf(excepted), await keyOf(usdt));
});
