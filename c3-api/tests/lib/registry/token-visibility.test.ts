import t from 'tap';

import { BigFixnum } from '../../../lib/bigfixnum.js';

import type { Address } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import { deprecatedDecisionsOf } from '../../../src/registry/deprecated-collaterals.js';
import { visibleOnlyOf } from '../../../src/registry/token-handlers.js';
import { positionsOf, recordKey } from '../../../src/registry/token-collateral.js';
import type { TokenValue } from '../../../src/registry/token-collateral.js';
import {
  RULE_VERSION,
  THRESHOLD_USD,
  decimalString,
  deprecatedOf,
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

t.test('the rule: deprecated, then strategic, then unknown, then the threshold', async t => {
  const cases: Array<[ string, boolean, boolean, TokenValue, boolean, string ]> = [
    [ 'deprecated everywhere it is taken',    true,  false, value('fresh', '1'),           false, 'deprecated' ],
    [ 'deprecated and worth the threshold',   true,  false, value('fresh', '300000'),      false, 'deprecated' ],
    [ 'deprecated and unreadable',            true,  false, value('unavailable', null),    false, 'deprecated' ],
    [ 'deprecated and strategic',             true,  true,  value('fresh', '300000'),      false, 'deprecated' ],
    [ 'strategic below the threshold',        false, true,  value('fresh', '1'),           true,  'strategic' ],
    [ 'strategic and unreadable',             false, true,  value('unavailable', null),    true,  'strategic' ],
    [ 'unreadable',                           false, false, value('unavailable', null),    true,  'data_unavailable' ],
    [ 'exactly the threshold',                false, false, value('fresh', '250000'),      true,  'collateral_threshold' ],
    [ 'a hair below it',                      false, false, value('fresh', '249999.9999'), false, 'below_threshold' ],
    [ 'above it, from an earlier minute',     false, false, value('stale', '300000'),      true,  'collateral_threshold' ],
    [ 'a partial value reaching it (D7)',     false, false, value('partial', '250000.5'),  true,  'collateral_threshold' ],
  ];
  for (const [ name, isDeprecated, isStrategic, tokenValue, isVisible, reason ] of cases) {
    t.same(visibilityOf({ isDeprecated, isStrategic }, tokenValue), { isVisible, visibilityReason: reason }, name);
  }
  t.ok(THRESHOLD_USD.eq(BigFixnum.from({ value: 250000 })));
});

/*
 * The list names the rule it decides by, which hiding a deprecated token moved
 * to 2. A record of a minute's values is keyed by the rule it was valued by,
 * which did not change, so the records written before keep serving.
 */
t.test('the list decides by rule 2, and the values it reads keep their records', async t => {
  t.equal(RULE_VERSION, 2);
  t.match(recordKey(1, 'positions', 29_853_416), /^token-collateral:v1:r1:1:positions:29853416$/,
    'a record is keyed by the rule of its values, which a change of what a list shows leaves as it was');
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
    chainId:    534352,
    catalog,
    network:    'scroll-mainnet' as const,
    positions:  positionsOf(catalog, 'scroll-mainnet'),
    view,
    strategic:  new Set<Address>(),
    deprecated: deprecatedDecisionsOf([]),
    now:        NOW,
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
  t.same({ threshold: list.thresholdUsd, rule: list.ruleVersion, computedAt: list.computedAt }, { threshold: '250000', rule: 2, computedAt: NOW.toISOString() });
});

/*
 * Deprecated collateral (migrations 0006 and 0007): a decision is about one
 * collateral of one Comet, and the list says where a token is one, and
 * whether it is one in every enabled market that takes it. Mainnet's weETH is
 * a collateral of the USDC, WETH and USDT markets of the fixture; mETH of the
 * USDT market alone.
 */
t.test('a token is deprecated only where every enabled market that takes it marks it so', async t => {
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const comet   = (key: string) => mainnet.markets.find(entry => entry.deploymentKey === key)!.contracts.comet!;
  const token   = (symbol: string) => mainnet.markets.flatMap(entry => entry.collateralAssets)
    .find(asset => asset.token.symbol === symbol)!.token.address;
  const [ WEETH, METH, XAUT ] = [ token('weETH'), token('mETH'), token('XAUt') ];
  const decided = (...pairs: Array<[ string, Address ]>) => deprecatedDecisionsOf(pairs.map(([ key, tokenAddress ]) => (
    { chainId: 1, cometAddress: comet(key), tokenAddress }
  )));
  const markets = catalog.marketsOn('ethereum-mainnet');
  const sorted  = (...keys: string[]) => keys.map(comet).sort();

  t.same(deprecatedOf(1, WEETH, markets, decided([ 'usdc', WEETH ], [ 'usdt', WEETH ])),
    { isDeprecated: false, deprecatedIn: sorted('usdc', 'usdt') },
    'deprecated in two of the three enabled markets that take it is not deprecated, and names the two');
  t.same(deprecatedOf(1, WEETH, markets, decided([ 'usdc', WEETH ], [ 'usdt', WEETH ], [ 'weth', WEETH ])),
    { isDeprecated: true, deprecatedIn: sorted('usdc', 'usdt', 'weth') }, 'deprecated in all three is');
  t.same(deprecatedOf(1, METH, markets, decided([ 'usdt', METH ])), { isDeprecated: true, deprecatedIn: sorted('usdt') },
    'as is a token deprecated in the one market that takes it');

  t.same(deprecatedOf(1, METH, markets, decided([ 'usdc', METH ])), { isDeprecated: false, deprecatedIn: [] },
    'a decision about a Comet that does not take the token as collateral marks nothing');
  t.same(deprecatedOf(8453, METH, catalog.marketsOn('base-mainnet'), decided([ 'usdt', METH ])), { isDeprecated: false, deprecatedIn: [] },
    'and a decision belongs to its chain');
  t.same(deprecatedOf(1, token('WETH'), markets, decided()), { isDeprecated: false, deprecatedIn: [] },
    'nobody deciding is nothing deprecated');

  const changed = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets.map(entry =>
          entry.deploymentKey === 'weth' ? { ...entry, status: 'deprecated' as const }
        : entry.deploymentKey === 'usdt' ? { ...entry, status: 'deprecated' as const }
        : entry),
    }),
  }, NOW).marketsOn('ethereum-mainnet');
  t.same(deprecatedOf(1, WEETH, changed, decided([ 'usdc', WEETH ], [ 'usdt', WEETH ])),
    { isDeprecated: true, deprecatedIn: sorted('usdc', 'usdt') },
    'a market whose status is deprecated does not keep a token current where it does not mark it');
  t.same(deprecatedOf(1, XAUT, changed, decided([ 'usdt', XAUT ])), { isDeprecated: false, deprecatedIn: sorted('usdt') },
    'and a token only such a market takes is named there, but no enabled market makes it deprecated');
});

/*
 * With every collateral of the USDT market deprecated, the tokens no other
 * market takes are deprecated in every enabled market that takes them, and
 * hidden whatever else holds: XAUt is strategic as well, and the others are
 * shown while their value is unknown. A token another enabled market still
 * takes is named where it is deprecated, and shown or hidden as before.
 */
t.test('a token deprecated in every enabled market that takes it is hidden, and nothing else changes', async t => {
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const usdt    = mainnet.markets.find(entry => entry.deploymentKey === 'usdt')!;
  const xaut    = usdt.collateralAssets.find(asset => asset.token.symbol === 'XAUt')!.token.address;
  const input = {
    registryVersion: { id: 'v', checksum: 'c' },
    chainId:   1,
    catalog,
    network:   'ethereum-mainnet' as const,
    positions: positionsOf(catalog, 'ethereum-mainnet'),
    view:      { block: { number: 100, timestamp: 1_791_204_000 }, current: null, earlier: [] },
    strategic: new Set<Address>([ xaut ]),
    now:       NOW,
  };
  const deprecated = deprecatedDecisionsOf(usdt.collateralAssets.map(asset => (
    { chainId: 1, cometAddress: usdt.contracts.comet!, tokenAddress: asset.token.address }
  )));
  const before = tokenList({ ...input, deprecated: deprecatedDecisionsOf([]) });
  const after  = tokenList({ ...input, deprecated });

  const HIDDEN = [ 'mETH', 'sFRAX', 'wUSDM', 'XAUt' ];
  const decision = (list: typeof before, among: (symbol: string) => boolean) => list.tokens
    .filter(entry => among(entry.symbol))
    .map(entry => [ entry.symbol, entry.isVisible, entry.visibilityReason ]);
  t.same(after.tokens.filter(entry => entry.isDeprecated).map(entry => entry.symbol), HIDDEN,
    'the tokens no other market takes are deprecated');
  t.same(decision(before, symbol => HIDDEN.includes(symbol)), [
    [ 'mETH', true, 'data_unavailable' ], [ 'sFRAX', true, 'data_unavailable' ], [ 'wUSDM', true, 'data_unavailable' ], [ 'XAUt', true, 'strategic' ],
  ], 'which discovery showed before');
  t.same(decision(after, symbol => HIDDEN.includes(symbol)), HIDDEN.map(symbol => [ symbol, false, 'deprecated' ]),
    'and hides now, strategic or not');
  t.same(decision(after, symbol => !HIDDEN.includes(symbol)), decision(before, symbol => !HIDDEN.includes(symbol)),
    'while every other token is shown or hidden as it was');

  const rest = (list: typeof before) => list.tokens.map(({
    isDeprecated: _isDeprecated, deprecatedIn: _deprecatedIn, isVisible: _isVisible, visibilityReason: _visibilityReason, ...token
  }) => token);
  t.same(rest(after), rest(before), 'and every other field of every token is what it was, its value included');
  t.ok(after.tokens.some(entry => !entry.isDeprecated && entry.deprecatedIn.length > 0),
    'a token deprecated in the USDT market alone is named there');
  t.ok(after.tokens.filter(entry => entry.deprecatedIn.length > 0).every(entry => entry.roles.includes('collateral')),
    'and only a collateral is ever named deprecated');
});

t.test('visibleOnly is true or false, once, or absent', async t => {
  t.equal(visibleOnlyOf(new URLSearchParams('')), false);
  t.equal(visibleOnlyOf(new URLSearchParams('visibleOnly=false')), false);
  t.equal(visibleOnlyOf(new URLSearchParams('visibleOnly=true')), true);
  for (const query of [ 'visibleOnly=', 'visibleOnly=TRUE', 'visibleOnly=1', 'visibleOnly=true&visibleOnly=true' ]) {
    t.throws(() => visibleOnlyOf(new URLSearchParams(query)), { code: 'BAD_REQUEST' }, `${query} is refused`);
  }
});
