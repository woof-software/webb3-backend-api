import t from 'tap';

import * as Debug    from '../../../lib/debug-log.js';
import * as Flags    from '../../../lib/flags.js';
import { BigNumber } from '../../../lib/bignumber.js';
import { BigFixnum } from '../../../lib/bigfixnum.js';

import * as Compute    from '../../../lib/symbolic/computation.js';
import * as Evaluator  from '../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../lib/symbolic/cache.js';

import * as market from '../../../lib/computations/market.js';
import type { PositionValue } from '../../../lib/computations/market/asset-collateral-value.js';

import type { PriceExceptionV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

import '../../../shim/node-self.js';

/*
 * The value of one collateral position, on the real evaluator over reads that
 * answer from tables instead of a node: the position's info and amount as the
 * Comet reports them, and the prices of its feeds.
 */
const flags = { ...Flags.parseWithDefaults(process.env), evaluatorAlgorithm: 'workingset', batchingEnabled: true } as Flags.SomeFlags;
const debug = Debug.MakeLogger([]).configure(process.env);

const BLOCK = 23_500_000;

const units = (amount: string | number, decimals: number) => BigFixnum.from({ value: amount, decimals });
const price = (value: string | number, decimals = 8) => ({ status: 'success' as const, price: units(value, decimals) });
const reverted = { status: 'error' as const, message: 'execution reverted' };

type Chain = {
  // what getAssetInfo answers, by `comet#index`; the registry's own description unless overridden
  info?:   Record<string, unknown>,
  // what totalsCollateral answers, by `comet:token`, in the token's units
  totals:  Record<string, unknown>,
  // what getPrice answers, by feed address
  prices:  Record<string, unknown>,
};

function stub(answer: (context: any) => unknown) {
  return Compute.Functor<any>({}).implement({ version: 0, compute: context => answer(context) });
}

/*
 * The value of `symbol` in market `deploymentKey` on `network`, for a snapshot
 * and a chain, with every price read recorded.
 */
async function valueOf(
  snapshot: RegistrySnapshotV1,
  network: 'ethereum-mainnet' | 'base-mainnet',
  deploymentKey: string,
  symbol: string,
  chain: Chain,
  now: Date = new Date('2026-10-05T12:00:00.000Z'),
): Promise<{ value: PositionValue, feedsRead: string[] }> {
  const entry = catalogOf(snapshot, now).marketsOn(network).find(candidate => candidate.deploymentKey === deploymentKey)!;
  const asset = entry.market.collateralAssets.find(candidate => candidate.token.symbol === symbol)!;
  const feedsRead: string[] = [];

  const { evaluate, pull1 } = Evaluator.instantiate<any>({
    assetCollateralValue: market.assetCollateralValue,
    collateralAssetInfo: stub(({ contract, assetIndex }) => {
      const own = entry.market.collateralAssets.find(candidate => candidate.assetIndex === assetIndex)!;
      return chain.info?.[`${contract.address.toLowerCase()}#${assetIndex}`] ?? {
        status:    'success',
        asset:     own.token.address,
        priceFeed: own.priceFeed.address,
        scale:     BigNumber.from(10).pow(own.token.decimals),
      };
    }),
    collateralTotal: stub(({ contract, token }) => {
      const total = chain.totals[`${contract.address.toLowerCase()}:${token}`];
      return total === undefined ? { status: 'success', total: BigNumber.from(0) } : total;
    }),
    getPrice: stub(({ priceFeed }) => {
      feedsRead.push(`${priceFeed.address}/${priceFeed.decimals}`);
      return chain.prices[priceFeed.address] ?? price(1);
    }),
  } as any, { cache: new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]), debug, flags });

  const value = await evaluate(pull1({ assetCollateralValue: {
    apiHost: '', nodeHost: '', nodeKey: '', network, contract: entry.comet, assetIndex: asset.assetIndex, blockNumber: BLOCK,
  } })) as PositionValue;
  return { value, feedsRead };
}

const total = (amount: string) => ({ status: 'success', total: BigNumber.from(amount) });

function usdOf(value: PositionValue): BigFixnum {
  if (value.status === 'error') {
    throw new Error(`the position failed: ${value.reason}`);
  }
  return value.valueUsd;
}

const fixture = loadRegistrySnapshotFixture();

const marketOf = (chainId: number, deploymentKey: string) => fixture.networks
  .find(network => network.chainId === chainId)!.markets
  .find(entry => entry.deploymentKey === deploymentKey)!;

// the fixture's Comets and conversion feeds, lowercase as the registry stores them
const USDT_COMET = marketOf(1, 'usdt').contracts.comet!;
const WETH_COMET = marketOf(1, 'weth').contracts.comet!;
const WBTC_COMET = marketOf(1, 'wbtc').contracts.comet!;
const AERO_COMET = marketOf(8453, 'aero').contracts.comet!;
const ETH_USD    = marketOf(1, 'weth').baseAsset.usdPriceFeed!.address;
const BTC_USD    = marketOf(1, 'wbtc').baseAsset.usdPriceFeed!.address;

const XAUT    = '0x68749665ff8d2d112fa859aa293f07a622782f38';
const XAUT_FEED = '0x214ed9da11d2fbe465a6fc601a91e62ebec1a0d6';
const CBETH   = '0xbe9895146f7af43049ca1c1ae358b0541ea49704';
const CBETH_FEED = '0x23a982b74a3236a5f2297856d4391b2edbbb5549';
const LBTC    = '0x8236a87084f8b84306f72007f36f2618a5634494';
const LBTC_FEED = '0x5c29868c58b6e15e2b962943278969ab6a7d3212';
const WUSDM   = '0x57f5e098cad7a3d1eed53991d4d66c45c9af7812';
const PUMPBTC = '0xf469fbd2abcd6b9de8e169d128226c0fc90a012e';
const BASE_WETH = '0x4200000000000000000000000000000000000006';

// the fixture's network exceptions, which no collateral feed of the fixture names
const ZERO_PRICED = '0xe3a409ed15cd53afdefdd191ad945cec528a2496';
const FIXED_PRICED = '0x351a133fd850ea81ed8a782016e308acbaddec91';

/*
 * The fixture with one collateral's feed replaced, to put a position behind
 * one of the network's exceptions.
 */
function withFeed(snapshot: RegistrySnapshotV1, deploymentKey: string, symbol: string, address: string): RegistrySnapshotV1 {
  return {
    ...snapshot,
    networks: snapshot.networks.map(network => ({
      ...network,
      markets: network.markets.map(entry => entry.deploymentKey !== deploymentKey || network.chainId !== 1 ? entry : {
        ...entry,
        collateralAssets: entry.collateralAssets.map(asset => asset.token.symbol !== symbol ? asset : {
          ...asset,
          priceFeed: { address: address as `0x${string}`, decimals: asset.priceFeed.decimals },
        }),
      }),
    })),
  };
}

function withException(snapshot: RegistrySnapshotV1, exception: PriceExceptionV1): RegistrySnapshotV1 {
  return {
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      priceExceptions: [ ...network.priceExceptions, exception ],
    }),
  };
}

t.test('a USD-quoted position is its amount times its price, exactly', async t => {
  const cases: Array<[ string, string ]> = [
    [ '100000000', '250000' ],            // 100 XAUt at 2500
    [ '99999999',  '249999.9975' ],       // 99.999999 XAUt
    [ '100000001', '250000.0025' ],       // 100.000001 XAUt
  ];
  for (const [ amount, expected ] of cases) {
    const { value, feedsRead } = await valueOf(fixture, 'ethereum-mainnet', 'usdt', 'XAUt', {
      totals: { [`${USDT_COMET}:${XAUT}`]: total(amount) },
      prices: { [XAUT_FEED]: price('250000000000') },
    });
    t.equal(value.status, 'success');
    t.ok(usdOf(value).eq(BigFixnum.from({ value: expected.replace('.', ''), decimals: expected.split('.')[1]?.length ?? 0 })),
      `${amount} units of XAUt are worth exactly ${expected}`);
    t.same(feedsRead, [ `${XAUT_FEED}/8` ], 'only the collateral feed is read: the market is quoted in USD');
  }
});

t.test('a base-quoted position is converted through the base asset\'s USD price', async t => {
  const { value, feedsRead } = await valueOf(fixture, 'ethereum-mainnet', 'weth', 'cbETH', {
    totals: { [`${WETH_COMET}:${CBETH}`]: total('100000000000000000000') },
    prices: { [CBETH_FEED]: price('125000000'), [ETH_USD]: price('200000000000') },
  });
  t.ok(usdOf(value).eq(BigFixnum.from({ value: 250000 })), '100 cbETH at 1.25 ETH and 2000 USD per ETH is 250000');
  t.same(feedsRead.sort(), [ `${CBETH_FEED}/8`, `${ETH_USD}/8` ].sort(), 'the collateral feed and the base\'s USD feed');

  const btc = await valueOf(fixture, 'ethereum-mainnet', 'wbtc', 'LBTC', {
    totals: { [`${WBTC_COMET}:${LBTC}`]: total('100000000') },
    prices: { [LBTC_FEED]: price('100000000'), [BTC_USD]: price('10000000000000') },
  });
  t.ok(usdOf(btc.value).eq(BigFixnum.from({ value: 100000 })), '1 LBTC at 1 BTC and 100000 USD per BTC');
  t.ok(btc.feedsRead.includes(`${BTC_USD}/8`), 'the BTC market converts through BTC/USD');

  const aero = await valueOf(fixture, 'base-mainnet', 'aero', 'WETH', {
    totals: { [`${AERO_COMET}:${BASE_WETH}`]: total('1000000000000000000') },
    prices: {},
  });
  t.equal(aero.feedsRead.length, 1, 'a market quoted in USD reads no conversion, whatever its base is');
});

t.test('a conversion feed of another scale is read at its own decimals', async t => {
  const snapshot: RegistrySnapshotV1 = {
    ...fixture,
    networks: fixture.networks.map(network => ({
      ...network,
      markets: network.markets.map(entry => entry.deploymentKey !== 'weth' || network.chainId !== 1 ? entry : {
        ...entry,
        baseAsset: { ...entry.baseAsset, usdPriceFeed: { address: ETH_USD, decimals: 18 } },
      }),
    })),
  };
  const { value, feedsRead } = await valueOf(snapshot, 'ethereum-mainnet', 'weth', 'cbETH', {
    totals: { [`${WETH_COMET}:${CBETH}`]: total('100000000000000000000') },
    prices: { [CBETH_FEED]: price('125000000'), [ETH_USD]: price('2000000000000000000000', 18) },
  });
  t.ok(feedsRead.includes(`${ETH_USD}/18`), 'the feed is read with the decimals the registry states');
  t.ok(usdOf(value).eq(BigFixnum.from({ value: 250000 })), 'and the value is the same');
});

t.test('a price the registry states replaces the read of its feed', async t => {
  const zero = await valueOf(withFeed(fixture, 'usdt', 'wUSDM', ZERO_PRICED), 'ethereum-mainnet', 'usdt', 'wUSDM', {
    totals: { [`${USDT_COMET}:${WUSDM}`]: total('5000000000000000000000') },
    prices: {},
  });
  t.equal(zero.value.status, 'exception', 'a zero price is an exception');
  t.ok(usdOf(zero.value).eq(BigFixnum.from({ value: 0 })), 'worth nothing');
  t.same(zero.feedsRead, [], 'and its feed, known not to answer, is not read');
  t.match(zero.value, { exceptions: [ { kind: 'zero_price', priceFeedAddress: ZERO_PRICED } ] }, 'naming the exception it applied');

  const zeroInBtc = await valueOf(withFeed(fixture, 'wbtc', 'pumpBTC', ZERO_PRICED), 'ethereum-mainnet', 'wbtc', 'pumpBTC', {
    totals: { [`${WBTC_COMET}:${PUMPBTC}`]: total('100000000') },
    prices: {},
  });
  t.same(zeroInBtc.feedsRead, [], 'nothing priced at zero needs its conversion either');

  const fixed = await valueOf(withFeed(fixture, 'wbtc', 'pumpBTC', FIXED_PRICED), 'ethereum-mainnet', 'wbtc', 'pumpBTC', {
    totals: { [`${WBTC_COMET}:${PUMPBTC}`]: total('200000000') },
    prices: { [BTC_USD]: price('10000000000000') },
  });
  t.equal(fixed.value.status, 'exception');
  t.ok(usdOf(fixed.value).eq(BigFixnum.from({ value: '204894768', decimals: 3 })),
    '2 pumpBTC at the fixed 1.02447384 BTC, converted at 100000 USD per BTC');
  t.same(fixed.feedsRead, [ `${BTC_USD}/8` ], 'the fixed feed is not read; the conversion is');
});

t.test('a remapped feed is read in place of the one the Comet names', async t => {
  const REPLACEMENT = '0x1111111111111111111111111111111111111111';
  const snapshot = withException(fixture, {
    kind: 'deprecated_price_remap', priceFeedAddress: XAUT_FEED,
    replacementPriceFeed: { address: REPLACEMENT, decimals: 18 }, provenance: 'test', expiresAt: null,
  });
  const { value, feedsRead } = await valueOf(snapshot, 'ethereum-mainnet', 'usdt', 'XAUt', {
    totals: { [`${USDT_COMET}:${XAUT}`]: total('1000000') },
    prices: { [REPLACEMENT]: price('2500000000000000000000', 18) },
  });
  t.same(feedsRead, [ `${REPLACEMENT}/18` ], 'the replacement, at its own decimals');
  t.equal(value.status, 'exception');
  t.ok(usdOf(value).eq(BigFixnum.from({ value: 2500 })));
});

/*
 * An exception describes a collateral feed. A base asset's USD feed is changed
 * in its market's overlay instead, so an exception that names one — written
 * for a collateral that happens to share it — leaves the conversion alone.
 */
t.test('an exception on a conversion feed does not reprice its market', async t => {
  const exceptions: PriceExceptionV1[] = [
    { kind: 'zero_price', priceFeedAddress: ETH_USD, provenance: 'test', expiresAt: null },
    { kind: 'fixed_price', priceFeedAddress: ETH_USD, price: { value: '150000000000', decimals: 8 }, provenance: 'test', expiresAt: null },
  ];
  for (const exception of exceptions) {
    const { value, feedsRead } = await valueOf(withException(fixture, exception), 'ethereum-mainnet', 'weth', 'cbETH', {
      totals: { [`${WETH_COMET}:${CBETH}`]: total('100000000000000000000') },
      prices: { [CBETH_FEED]: price('125000000'), [ETH_USD]: price('200000000000') },
    });
    t.equal(value.status, 'success', `a ${exception.kind} on ETH/USD is not applied to cWETHv3's conversion`);
    t.ok(usdOf(value).eq(BigFixnum.from({ value: 250000 })), 'which is read at its live price');
    t.ok(feedsRead.includes(`${ETH_USD}/8`));
  }
});

t.test('an expired exception no longer applies', async t => {
  const snapshot = withException(fixture, {
    kind: 'zero_price', priceFeedAddress: XAUT_FEED, provenance: 'test', expiresAt: '2026-10-01T00:00:00.000Z',
  });
  const { value, feedsRead } = await valueOf(snapshot, 'ethereum-mainnet', 'usdt', 'XAUt', {
    totals: { [`${USDT_COMET}:${XAUT}`]: total('1000000') },
    prices: { [XAUT_FEED]: price('250000000000') },
  });
  t.equal(value.status, 'success', 'the feed is read again');
  t.same(feedsRead, [ `${XAUT_FEED}/8` ]);
});

t.test('a position the chain does not describe as the registry does fails alone', async t => {
  const own = (overrides: Record<string, unknown>) => ({
    [`${USDT_COMET}#14`]: {
      status: 'success', asset: XAUT, priceFeed: XAUT_FEED, scale: BigNumber.from(10).pow(6), ...overrides,
    },
  });
  const cases: Array<[ string, Chain, string ]> = [
    [ 'an index the Comet does not have', { info: { [`${USDT_COMET}#14`]: { status: 'reverted', message: 'x' } }, totals: {}, prices: {} }, 'asset_info_reverted' ],
    [ 'another asset at the index',       { info: own({ asset: CBETH }), totals: {}, prices: {} },                   'asset_mismatch' ],
    [ 'another feed for the asset',       { info: own({ priceFeed: CBETH_FEED }), totals: {}, prices: {} },          'feed_mismatch' ],
    [ 'another scale for the asset',      { info: own({ scale: BigNumber.from(10).pow(18) }), totals: {}, prices: {} }, 'scale_mismatch' ],
    [ 'an amount that reverts',           { totals: { [`${USDT_COMET}:${XAUT}`]: { status: 'reverted', message: 'x' } }, prices: {} }, 'total_reverted' ],
    [ 'a price that reverts',             { totals: { [`${USDT_COMET}:${XAUT}`]: total('1') }, prices: { [XAUT_FEED]: reverted } }, 'price_reverted' ],
  ];
  for (const [ name, chain, reason ] of cases) {
    const { value } = await valueOf(fixture, 'ethereum-mainnet', 'usdt', 'XAUt', chain);
    t.same(value, { status: 'error', reason }, `${name}: ${reason}`);
  }

  const usd = await valueOf(fixture, 'ethereum-mainnet', 'weth', 'cbETH', {
    totals: { [`${WETH_COMET}:${CBETH}`]: total('1') },
    prices: { [ETH_USD]: reverted },
  });
  t.same(usd.value, { status: 'error', reason: 'usd_price_reverted' }, 'a conversion that reverts');

  const empty = await valueOf(fixture, 'ethereum-mainnet', 'usdt', 'XAUt', {
    totals: { [`${USDT_COMET}:${XAUT}`]: total('0') },
    prices: { [XAUT_FEED]: reverted },
  });
  t.equal(empty.value.status, 'success', 'nothing held is worth nothing, whatever its price does');
  t.ok(usdOf(empty.value).eq(BigFixnum.from({ value: 0 })));
});

t.test('the largest amount a Comet can hold is valued without losing a digit', async t => {
  const max = (2n ** 128n - 1n).toString();
  const { value } = await valueOf(fixture, 'ethereum-mainnet', 'usdt', 'XAUt', {
    totals: { [`${USDT_COMET}:${XAUT}`]: total(max) },
    prices: { [XAUT_FEED]: price('1000000000000000') },    // 10 million USD
  });
  const usd = usdOf(value);
  t.equal(usd.value.toString(), (BigInt(max) * 1_000_000_000_000_000n).toString(), 'every digit of the product is kept');
  t.equal(usd.decimals, 6 + 8, 'at the decimals of the amount and the price together');
});
