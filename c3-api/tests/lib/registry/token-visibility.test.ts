import t from 'tap';

import { BigFixnum } from '../../../lib/bigfixnum.js';

import type { Address } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import { visibleOnlyOf } from '../../../src/registry/token-handlers.js';
import { positionsOf } from '../../../src/registry/token-collateral.js';
import type { TokenValue } from '../../../src/registry/token-collateral.js';
import {
  THRESHOLD_USD,
  decimalString,
  tokenList,
  tokensOf,
  visibilityOf,
} from '../../../src/registry/token-visibility.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * The visibility rule and the shape of the token list, without a node: what
 * a token is in its markets, how a value decides whether discovery shows it,
 * and how a value is written.
 */
const NOW      = new Date('2026-10-05T12:00:30.000Z');
const snapshot = loadRegistrySnapshotFixture();
const catalog  = catalogOf(snapshot, NOW);

const value = (status: TokenValue['status'], usd: string | null): TokenValue => ({
  status,
  valueUsd:        usd === null ? null : BigFixnum.from({ value: usd.replace('.', ''), decimals: usd.split('.')[1]?.length ?? 0 }),
  block:           usd === null ? null : { number: 1, timestamp: 60 },
  staleAgeSeconds: usd === null ? null : 0,
  exceptions:      [],
});

t.test('a token is listed once per chain, with every role it plays there', async t => {
  const mainnet = new Map(tokensOf(catalog, 'ethereum-mainnet').map(({ token, roles }) => [ token.symbol, roles ]));
  t.same(mainnet.get('COMP'), [ 'reward', 'collateral' ], 'COMP is both a reward and a collateral on mainnet');
  t.same(mainnet.get('USDC'), [ 'base', 'collateral' ]);
  t.same(mainnet.get('XAUt'), [ 'collateral' ]);

  const scroll = new Map(tokensOf(catalog, 'scroll-mainnet').map(({ token, roles }) => [ token.symbol, roles ]));
  t.same(scroll.get('COMP'), [ 'reward' ], 'a reward-only token is listed');
  t.same(scroll.get('USDC'), [ 'base' ], 'and so is a base-only one');

  const cbBtc = (network: 'ethereum-mainnet' | 'base-mainnet') =>
    tokensOf(catalog, network).filter(({ token }) => token.symbol === 'cbBTC').map(({ token }) => token.address);
  t.equal(cbBtc('ethereum-mainnet').length, 1);
  t.equal(cbBtc('base-mainnet').length, 1, 'a token of the same symbol on another chain is that chain\'s own');
});

t.test('a disabled market contributes nothing, a deprecated one is still listed but holds no position', async t => {
  const changed = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets.map(entry =>
          entry.deploymentKey === 'wbtc' ? { ...entry, status: 'disabled' as const }
        : entry.deploymentKey === 'usdt' ? { ...entry, status: 'deprecated' as const }
        : entry),
    }),
  }, NOW);
  const symbols = tokensOf(changed, 'ethereum-mainnet').map(({ token }) => token.symbol);
  t.notOk(symbols.includes('pumpBTC'), 'a token only a disabled market holds is not listed');
  t.ok(symbols.includes('XAUt'), 'one only a deprecated market holds is');
  const positions = positionsOf(changed, 'ethereum-mainnet');
  t.notOk(positions.some(position => position.deploymentKey === 'usdt'), 'but the deprecated market holds no position');
});

t.test('the rule: strategic, then unknown, then the threshold', async t => {
  const cases: Array<[ string, boolean, TokenValue, boolean, string ]> = [
    [ 'strategic below the threshold',        true,  value('fresh', '1'),           true,  'strategic' ],
    [ 'strategic and unreadable',             true,  value('unavailable', null),    true,  'strategic' ],
    [ 'unreadable',                           false, value('unavailable', null),    true,  'data_unavailable' ],
    [ 'exactly the threshold',                false, value('fresh', '250000'),      true,  'collateral_threshold' ],
    [ 'a hair below it',                      false, value('fresh', '249999.9999'), false, 'below_threshold' ],
    [ 'above it, from an earlier minute',     false, value('stale', '300000'),      true,  'collateral_threshold' ],
    [ 'a partial value reaching it (D7)',     false, value('partial', '250000.5'),  true,  'collateral_threshold' ],
  ];
  for (const [ name, isStrategic, tokenValue, isVisible, reason ] of cases) {
    t.same(visibilityOf(isStrategic, tokenValue), { isVisible, visibilityReason: reason }, name);
  }
  t.ok(THRESHOLD_USD.eq(BigFixnum.from({ value: 250000 })));
});

t.test('a value is written with every digit and nothing more', async t => {
  const cases: Array<[ string, number, string ]> = [
    [ '250000',          0,  '250000' ],
    [ '25000000000000',  8,  '250000' ],
    [ '24999999990000',  8,  '249999.9999' ],
    [ '5',               3,  '0.005' ],
    [ '0',               26, '0' ],
    [ (2n ** 128n - 1n).toString(), 14, '3402823669209384634633746.07431768211455' ],
  ];
  for (const [ raw, decimals, written ] of cases) {
    t.equal(decimalString(BigFixnum.from({ value: raw, decimals })), written, `${raw} at ${decimals} decimals`);
  }
});

t.test('the list is ordered by symbol and names when each value was read', async t => {
  const view = { block: { number: 100, timestamp: 1_791_204_000 }, current: null, earlier: [] };
  const input = {
    registryVersion: { id: 'v', checksum: 'c' },
    chainId:   534352,
    catalog,
    network:   'scroll-mainnet' as const,
    positions: positionsOf(catalog, 'scroll-mainnet'),
    view,
    strategic: new Set<Address>(),
    now:       NOW,
  };
  const list = tokenList(input);
  t.same(list.tokens.map(token => token.symbol), [ 'COMP', 'USDC', 'WETH', 'wstETH' ], 'by symbol');
  const mainnet = tokenList({ ...input, chainId: 1, network: 'ethereum-mainnet', positions: positionsOf(catalog, 'ethereum-mainnet') });
  t.same(mainnet.tokens.slice(0, 5).map(token => token.symbol), [ 'cbBTC', 'cbETH', 'COMP', 'deUSD', 'ETHx' ],
    'ignoring case: a lowercase symbol is not put after every uppercase one');
  t.same(
    list.tokens.map(token => [ token.symbol, token.collateralValueStatus, token.collateralValueUsd, token.isVisible, token.visibilityReason ]),
    [
      [ 'COMP',   'fresh',       '0',  false, 'below_threshold' ],
      [ 'USDC',   'fresh',       '0',  false, 'below_threshold' ],
      [ 'WETH',   'unavailable', null, true,  'data_unavailable' ],
      [ 'wstETH', 'unavailable', null, true,  'data_unavailable' ],
    ],
    'a token without a collateral position is worth nothing; one that could not be read is shown',
  );
  t.same(list.tokens[0]!.valueAt, new Date(1_791_204_000 * 1000).toISOString(), 'a zero is as of the latest block');
  t.same({ threshold: list.thresholdUsd, rule: list.ruleVersion, computedAt: list.computedAt }, { threshold: '250000', rule: 1, computedAt: NOW.toISOString() });
});

t.test('visibleOnly is true or false, once, or absent', async t => {
  t.equal(visibleOnlyOf(new URLSearchParams('')), false);
  t.equal(visibleOnlyOf(new URLSearchParams('visibleOnly=false')), false);
  t.equal(visibleOnlyOf(new URLSearchParams('visibleOnly=true')), true);
  for (const query of [ 'visibleOnly=', 'visibleOnly=TRUE', 'visibleOnly=1', 'visibleOnly=true&visibleOnly=true' ]) {
    t.throws(() => visibleOnlyOf(new URLSearchParams(query)), { code: 'BAD_REQUEST' }, `${query} is refused`);
  }
});
