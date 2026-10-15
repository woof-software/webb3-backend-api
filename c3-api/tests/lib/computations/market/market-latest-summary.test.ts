import t from 'tap';

import * as Eth      from '../../../../lib/eth-constants.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as comet  from '../../../../lib/computations/comet.js';
import * as market from '../../../../lib/computations/market.js';

import type { PriceRead } from '../../../../lib/computations/comet.js';
import type { Collateral } from '../../../../lib/computations/market/collaterals.js';

import type { RegistryComet } from '../../../../lib/model/comet-registry.js';
import { checksumAddress } from '../../../../lib/model/comet-registry.js';

import { consoleLines } from '../../../util/console.js';
import { evaluatorOver, stub } from '../../../util/evaluator.js';
import { COMET } from '../../../util/fake-node.js';
import { fixtureCatalog } from '../../../util/registry-fixture.js';

import '../../../../shim/node-self.js';

/*
 * The summary of a market at the latest block, as the summary route answers
 * it: the computation runs on the real evaluator, over reads that answer
 * from a table instead of a node.
 */
const network = 'ethereum-mainnet' as const;
const block   = { number: 50_000_000, timestamp: 1_790_000_000 };

const marketOf = (deploymentKey: string) => fixtureCatalog().marketsOn(network).find(entry => entry.deploymentKey === deploymentKey)!.comet;
const usdt = marketOf('usdt');
const weth = marketOf('weth');

const COMP = '0xc00e94Cb662C3520282E6f5717214004A7f26888';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// a price as a feed of eight decimals answers it: 4217000000 is 42.17
const at8      = (value: number | string) => BigFixnum.from({ decimals: 8, value });
const read     = (price: BigFixnum) => ({ status: 'success' as const, price });
const reverted = (message = 'execution reverted') => ({ status: 'error' as const, message });

/*
 * What the summary of USDT's market reads but its collateral, as the Comet
 * and the feeds answer it: its base asset at 0.99890608 USD, through the
 * one feed that prices it both ways on a market quoted in USD.
 */
const READS = {
  basePrice:    read(at8(99_890_608)),
  baseUsdPrice: read(at8(99_890_608)),
  borrowApr:    BigFixnum.from({ decimals: 2, value: 5 }),
  supplyApr:    BigFixnum.from({ decimals: 2, value: 3 }),
  totalBorrow:  BigFixnum.from({ decimals: 6, value: 1_000_000_000 }),
  totalSupply:  BigFixnum.from({ decimals: 6, value: 2_000_000_000 }),
  utilization:  BigNumber.from('500000000000000000'),
};

type Reads = { [Name in keyof typeof READS]?: unknown } & { contract?: RegistryComet, collaterals: Collateral[] };

// the stubbed reads of the summary of one market: those `reads` names, and the rest as READS has them
function readsOf(reads: Reads) {
  const answers: Record<string, unknown> = { ...READS, ...reads };
  return Object.fromEntries(Object.keys(READS).map(name => [ name, stub(() => answers[name]) ]));
}

function contextOf(contract: RegistryComet) {
  return { apiHost: '', nodeHost: '', nodeKey: '', network: contract.network, contract, block };
}

function summaryOf(reads: Reads): Promise<any> {
  const { evaluate, pull1 } = evaluatorOver({
    marketLatestSummary: market.marketLatestSummary,
    ...readsOf(reads),
    collaterals:         stub(() => reads.collaterals),
  });
  return evaluate(pull1({ marketLatestSummary: contextOf(reads.contract ?? usdt) }));
}

// a collateral of the summary's market as collaterals reports it: `held` whole tokens of eighteen decimals at `price`
function collateral(asset: string, symbol: string, held: number, price: PriceRead): Collateral {
  return {
    asset:           asset as Eth.Address,
    symbol,
    totalCollateral: BigFixnum.from({ multiplier: BigNumber.from(10).pow(18), value: BigNumber.from(10).pow(18).mul(held) }),
    price,
  };
}

// USDT's market holds three COMP at 42.17 USD and two WETH at 2514.24289343 USD
const usdtComp = (price: PriceRead = read(at8(4_217_000_000)))   => collateral(COMP, 'COMP', 3, price);
const usdtWeth = (price: PriceRead = read(at8(251_424_289_343))) => collateral(WETH, 'WETH', 2, price);

t.test('a market whose every price reads reports every field, in the order the API writes them', async t => {
  const summary = await summaryOf({ collaterals: [ usdtComp(), usdtWeth() ] });
  const expected = {
    chainId: 1,
    comet:   { address: usdt.address },
    status:  'success',
    borrowApr:               '0.05',
    supplyApr:               '0.03',
    totalBorrowValue:        '998.90608',
    totalSupplyValue:        '1997.81216',
    totalCollateralValue:    '5154.99578686',
    // USDT's market is quoted in USD, so its totals in USD are the quoted ones
    totalBorrowValueUsd:     '998.90608',
    totalSupplyValueUsd:     '1997.81216',
    totalCollateralValueUsd: '5154.99578686',
    utilization:             '500000000000000000',
    baseUsdPrice:            '0.99890608',
    basePrice:               '0.99890608',
    collateralAssetSymbols:  [ 'COMP', 'WETH' ],
    collaterals: [
      { address: COMP, symbol: 'COMP', status: 'success' },
      { address: WETH, symbol: 'WETH', status: 'success' },
    ],
  };
  t.strictSame(summary, expected, 'each total at the base price, and each collateral with its status');
  t.equal(JSON.stringify(summary), JSON.stringify(expected), 'in the order the API writes them');
});

t.test('a market reports what marketSummary reports of it, as it reports it', async t => {
  const answers = [
    { status: 'success', contract: usdt, collaterals: [ usdtComp(), usdtWeth() ] },
    {
      status:       'partially',
      contract:     weth,
      basePrice:    read(at8(100_000_000)),
      baseUsdPrice: read(at8(250_000_000_000)),
      collaterals:  [
        collateral(checksumAddress(weth.registry.market.collateralAssets[0]!.token.address), 'cbETH',  4, read(at8(105_000_000))),
        collateral(checksumAddress(weth.registry.market.collateralAssets[1]!.token.address), 'wstETH', 5, reverted()),
      ],
    },
  ];
  for (const { status, ...reads } of answers) {
    const { evaluate, pull1, split } = evaluatorOver({
      marketSummary:       market.marketSummary,
      marketLatestSummary: market.marketLatestSummary,
      ...readsOf(reads),
      collaterals:         stub(() => reads.collaterals),
    });
    const context = contextOf(reads.contract);
    const [ before, { basePrice, ...latest } ] = await evaluate(split([
      pull1({ marketSummary: context }),
      pull1({ marketLatestSummary: context }),
    ])) as [ any, any ];
    // which marketSummary keeps to itself
    t.equal(basePrice, (reads.basePrice ?? READS.basePrice).price.toString(), `${status}: the base price its totals are valued at`);

    t.equal(before.status, status, `marketSummary reports the market as ${status}`);
    t.strictSame(latest, before, `${status}: every field as marketSummary reports it`);
    t.equal(JSON.stringify(latest), JSON.stringify(before), `${status}: in its order`);
  }
});

/*
 * On a market quoted in USD, the base price and the base asset's USD price
 * are one read, with one fallback: of the base feed the version names, or,
 * where that reverts, of the feed the Comet names. They fail together, where
 * neither answers (the next test). Where one fails alone below, it shows
 * only that each field needs its own reads: a total in USD is the total
 * itself there, and needs what the total needs.
 */
t.test('a market quoted in USD whose base price reverts reports every field it can', async t => {
  const BASE = reverted('execution reverted: read as the base price');
  const USD  = reverted('execution reverted: read as the USD price');
  // the fields up to the utilization, without the totals of the base price and with them
  const unpriced = [ 'totalCollateralValue', 'totalCollateralValueUsd', 'utilization' ];
  const priced   = [ 'totalBorrowValue', 'totalSupplyValue', 'totalCollateralValue', 'totalBorrowValueUsd', 'totalSupplyValueUsd', 'totalCollateralValueUsd', 'utilization' ];
  const after    = [ 'collateralAssetSymbols', 'collaterals' ];
  const cases = [
    { reads: { basePrice: BASE, baseUsdPrice: USD }, message: BASE.message, keys: [ ...unpriced, ...after ], name: 'both revert' },
    { reads: { baseUsdPrice: USD },                  message: USD.message,  keys: [ ...priced, 'basePrice', ...after ], name: 'its USD price reverts' },
    { reads: { basePrice: BASE },                    message: BASE.message, keys: [ ...unpriced, 'baseUsdPrice', ...after ], name: 'its base price reverts' },
  ];
  for (const { reads, message, keys, name } of cases) {
    const summary = await summaryOf({ basePrice: READS.basePrice, baseUsdPrice: READS.baseUsdPrice, ...reads, collaterals: [ usdtComp(), usdtWeth() ] });
    t.match(summary, { status: 'error', message }, `${name}: an error, with the message of ${message === BASE.message ? 'the base price' : 'the USD price'}`);
    t.strictSame(Object.keys(summary), [ 'chainId', 'comet', 'status', 'message', 'borrowApr', 'supplyApr', ...keys ], `${name}: every field it can report`);
  }
  const totals = await summaryOf({ baseUsdPrice: USD, collaterals: [ usdtComp(), usdtWeth() ] });
  t.match(totals, { totalBorrowValue: '998.90608', totalSupplyValue: '1997.81216', totalCollateralValue: '5154.99578686' },
    'the totals at the base price that was read');
  const usd = await summaryOf({ basePrice: BASE, collaterals: [ usdtComp(), usdtWeth() ] });
  t.equal(usd.baseUsdPrice, '0.99890608', 'and the USD price that was read');
});

/*
 * The same market over the real base prices, where the base feed the version
 * names reverts: both prices are read through the feed the Comet names at
 * the block, and where the Comet names the very feed that reverts, both are
 * missing together.
 */
t.test('a market quoted in USD whose base feed reverts is priced through the feed its Comet names', async t => {
  consoleLines(t, [ 'warn' ]);
  const own   = usdt.base.priceFeed.address;
  const OTHER = '0x2222222222222222222222222222222222222222';
  const summaryNaming = (named: string): Promise<any> => {
    const { evaluate, pull1 } = evaluatorOver({
      marketLatestSummary: market.marketLatestSummary,
      ...readsOf({ collaterals: [] }),
      basePrice:           comet.basePrice,
      baseUsdPrice:        comet.baseUsdPrice,
      cometBasePrice:      comet.cometBasePrice,
      collaterals:         stub(() => [ usdtComp(), usdtWeth() ]),
      // the base feed the version names reverts, and any other answers 0.9999
      getPrice:            stub(({ priceFeed }) => priceFeed.address === own ? reverted() : read(at8(99_990_000))),
      // the Comet's one call, baseTokenPriceFeed(), answers `named`
      ethCall:             stub(() => COMET.encodeFunctionResult('baseTokenPriceFeed', [ named ])),
    });
    return evaluate(pull1({ marketLatestSummary: contextOf(usdt) }));
  };

  t.match(await summaryNaming(OTHER), {
    status:                  'success',
    totalBorrowValue:        '999.9',
    totalSupplyValue:        '1999.8',
    totalBorrowValueUsd:     '999.9',
    totalSupplyValueUsd:     '1999.8',
    totalCollateralValueUsd: '5154.99578686',
    baseUsdPrice:            '0.9999',
    basePrice:               '0.9999',
  }, 'another feed: a success, its totals and both prices at 0.9999');

  const same = await summaryNaming(own);
  t.match(same, { status: 'error', message: 'execution reverted' }, 'the feed that reverts: an error');
  t.strictSame(Object.keys(same), [
    'chainId', 'comet', 'status', 'message', 'borrowApr', 'supplyApr', 'totalCollateralValue', 'totalCollateralValueUsd',
    'utilization', 'collateralAssetSymbols', 'collaterals',
  ], 'without the totals of the base price and without its USD price, both missing together');
});

/*
 * On a market quoted in its base asset, the totals and the collateral are in
 * that asset, ETH for a WETH market, and only the base asset's USD price
 * turns them into USD.
 */
t.test('a market quoted in its base asset whose base prices revert reports every field it can', async t => {
  const BASE = reverted('execution reverted: WETH / ETH');
  const USD  = reverted('execution reverted: ETH / USD');
  const [ cbETH, wstETH, rETH ] = weth.registry.market.collateralAssets.map(asset => checksumAddress(asset.token.address));
  const collaterals = [
    collateral(cbETH!,  'cbETH',  4, read(at8(105_000_000))),
    collateral(wstETH!, 'wstETH', 5, read(at8(0))),
    collateral(rETH!,   'rETH',   6, reverted()),
  ];

  const unconverted = await summaryOf({ contract: weth, basePrice: read(at8(100_000_000)), baseUsdPrice: USD, collaterals });
  t.match(unconverted, {
    status:               'error',
    message:              USD.message,
    totalBorrowValue:     '1000.0',
    totalSupplyValue:     '2000.0',
    totalCollateralValue: '4.2',
    basePrice:            '1.0',
  }, 'its USD price reverts: an error with its message, the totals in ETH, and the base price');
  t.notOk('baseUsdPrice' in unconverted, 'without the USD price that reverted');
  t.strictSame(unconverted.collaterals.map((each: any) => each.status), [ 'success', 'success', 'error' ], 'each collateral as its price read');

  const unpriced = await summaryOf({ contract: weth, basePrice: BASE, baseUsdPrice: USD, collaterals });
  t.match(unpriced, { status: 'error', message: BASE.message, totalCollateralValue: '4.2' }, 'both revert: the message of the base price');
  t.notOk('totalBorrowValue' in unpriced || 'totalSupplyValue' in unpriced || 'basePrice' in unpriced || 'baseUsdPrice' in unpriced, 'and no totals of the base asset, nor either price');
});

/*
 * The WBTC market's feeds answer in BTC: its base price is WBTC in BTC, and
 * its USD price that of BTC, so only the base price turns a total back into
 * WBTC. Each is written with every digit its feed gives, and not rounded.
 */
t.test('the WBTC market\'s base price is WBTC in BTC, which values its total', async t => {
  // the frontend's example: 29.05271362 WBTC supplied, at 0.9984988 BTC each, and 82731.39 USD per BTC
  const wbtc = await summaryOf({
    contract:     marketOf('wbtc'),
    basePrice:    read(at8(99_849_880)),
    baseUsdPrice: read(at8(8_273_139_000_000)),
    totalSupply:  BigFixnum.from({ decimals: 8, value: 2_905_271_362 }),
    collaterals:  [],
  });
  t.match(wbtc, { status: 'success', totalSupplyValue: '29.009099686313656', baseUsdPrice: '82731.39', basePrice: '0.9984988' },
    'its total in BTC, the price of BTC in USD, and the price of WBTC in BTC its total is valued at');
});

/*
 * While a registry version no longer describes its market — the Comet listed
 * a collateral after the import, and holds another asset at an index the
 * version describes — the summary of the latest block and the history both
 * list the collateral of the version, by the same rules (collaterals.ts). The
 * chain drift check raises the difference, and a
 * new import ends it.
 */
t.test('while the version and the chain differ, the summary and the history both follow the version', async t => {
  const STRANGER  = '0x1111111111111111111111111111111111111111';
  const NEWCOMER  = '0x2222222222222222222222222222222222222222';
  const versioned = usdt.registry.market.collateralAssets;
  t.equal(versioned.length, 16, 'the version describes sixteen collaterals of USDT\'s market');

  // the asset the Comet holds at each of its seventeen indices
  const assetAt = (assetNumber: number) => assetNumber === 3 ? STRANGER : assetNumber === 16 ? NEWCOMER : versioned[assetNumber]!.token.address;
  const { evaluate, pull1, split } = evaluatorOver({
    marketSummary:        market.marketSummary,
    marketLatestSummary:  market.marketLatestSummary,
    collaterals:          market.collaterals,
    ...readsOf({ collaterals: [] }),
    numAssets:            stub(() => 17),
    assetInfo:            stub(({ assetNumber }) => ({
      asset:     checksumAddress(assetAt(assetNumber)),
      priceFeed: checksumAddress(`0x${'f'.repeat(38)}${assetNumber.toString(16).padStart(2, '0')}`),
      scale:     BigNumber.from(10).pow(18),
    })),
    assetTotalCollateral: stub(({ assetNumber }) => BigFixnum.from({ value: assetNumber + 1 })),
    assetPrice:           stub(() => read(BigFixnum.from({ value: 2 }))),
  });
  const context = contextOf(usdt);
  const [ history, latest ] = await evaluate(split([
    pull1({ marketSummary: context }),
    pull1({ marketLatestSummary: context }),
  ])) as [ any, any ];

  for (const [ name, summary ] of [ [ 'the summary', latest ], [ 'the history', history ] ]) {
    t.equal(summary.status, 'partially', `${name}: partial`);
    t.strictSame(summary.collateralAssetSymbols, versioned.map(asset => asset.token.symbol), `${name}: with the sixteen collaterals of the version`);
    t.strictSame(summary.collaterals.map((each: any) => each.status), versioned.map((_, assetNumber) => assetNumber === 3 ? 'error' : 'success'),
      `${name}: each priced but one`);
    t.strictSame(summary.collaterals[3], {
      address: checksumAddress(versioned[3]!.token.address),
      symbol:  'UNI',
      status:  'error',
      message: `asset 3 of the Comet is ${STRANGER}, not the UNI the registry version describes`,
    }, `${name}: the one at whose index the Comet holds another asset as an error`);
    t.equal(summary.totalCollateralValue, String(2 * (136 - 4)),
      `${name}: and the total leaves it and the seventeenth out: indices 1 to 16 but 4, at two each`);
  }
});

/*
 * Each total is given in USD beside it, as marketSummary gives it: the same
 * total on a market quoted in USD, and converted at the base asset's USD
 * price on one quoted in its base asset. A total in USD is there where the
 * total is and what converts it was read, in an error as anywhere else.
 */
t.test('a total in USD is reported where the total and what converts it were read', async t => {
  // the totals in USD a summary reports
  const inUsdOf = (summary: any) => Object.fromEntries(Object.entries(summary).filter(([ key ]) => /^total\w+Usd$/.test(key)));

  const usdQuoted = await summaryOf({ collaterals: [ usdtComp(), usdtWeth(reverted()) ] });
  t.match(usdQuoted, { status: 'partially', totalBorrowValue: '998.90608', totalSupplyValue: '1997.81216', totalCollateralValue: '126.51' });
  t.strictSame(inUsdOf(usdQuoted), { totalBorrowValueUsd: '998.90608', totalSupplyValueUsd: '1997.81216', totalCollateralValueUsd: '126.51' },
    'a market quoted in USD: the same totals, leaving out the collateral that could not be priced');
  const unpriced = await summaryOf({ basePrice: reverted(), baseUsdPrice: reverted(), collaterals: [ usdtComp(), usdtWeth(reverted()) ] });
  t.strictSame(inUsdOf(unpriced), { totalCollateralValueUsd: '126.51' }, 'and without its base price, the total of its collateral, which needs none');

  // WETH's market is quoted in ETH: its base asset at 1.0 ETH, and 2500 USD per ETH
  const [ cbETH, wstETH ] = weth.registry.market.collateralAssets.map(asset => checksumAddress(asset.token.address));
  const collaterals = [
    collateral(cbETH!,  'cbETH',  4, read(at8(105_000_000))),
    collateral(wstETH!, 'wstETH', 5, reverted()),
  ];
  const ETH     = read(at8(100_000_000));
  const ETH_USD = read(at8(250_000_000_000));
  const inEth   = (basePrice: PriceRead, baseUsdPrice: PriceRead) => summaryOf({ contract: weth, basePrice, baseUsdPrice, collaterals });

  const converted = await inEth(ETH, ETH_USD);
  t.match(converted, { status: 'partially', totalBorrowValue: '1000.0', totalSupplyValue: '2000.0', totalCollateralValue: '4.2' });
  t.strictSame(inUsdOf(converted), { totalBorrowValueUsd: '2500000.0', totalSupplyValueUsd: '5000000.0', totalCollateralValueUsd: '10500.0' },
    'a market quoted in ETH: each total at 2500 USD per ETH');
  t.strictSame(inUsdOf(await inEth(reverted(), ETH_USD)), { totalCollateralValueUsd: '10500.0' },
    'its base price reverts: the total of its collateral alone, which needs no base price');
  t.strictSame(inUsdOf(await inEth(ETH, reverted())), {}, 'its USD price reverts: none, since nothing converts them');
  t.strictSame(inUsdOf(await inEth(reverted(), reverted())), {}, 'both revert: none');
});
