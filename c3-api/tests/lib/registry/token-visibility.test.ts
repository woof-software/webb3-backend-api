import t from 'tap';

import { BigFixnum } from '../../../lib/bigfixnum.js';

import type { Address, TokenVisibilityV1, VisibilityV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import type { Catalog } from '../../../src/registry/catalog.js';
import { collateralDecisionsOf } from '../../../src/registry/collateral-decisions.js';
import { positionsOf, recordKey } from '../../../src/registry/token-collateral.js';
import type { TokenValue } from '../../../src/registry/token-value.js';
import {
  decimalString,
  listedTokens,
  tokenList,
  tokensOf,
  visibilityHere,
  visibilityOf,
} from '../../../src/registry/token-visibility.js';
import type { Exclusion } from '../../../src/registry/token-visibility.js';

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

type Collateral = { chainId: number, cometAddress: Address, tokenAddress: Address };

// mainnet's list as `within` serves it, with no value read, under the decisions given
const mainnetList = (within: Catalog, { strategic, deprecated, hidden }: { strategic: Address[], deprecated: Collateral[], hidden: Collateral[] }) => tokenList({
  registryVersion: { id: 'v', checksum: 'c' },
  chainId:    1,
  catalog:    within,
  network:    'ethereum-mainnet',
  positions:  positionsOf(within, 'ethereum-mainnet'),
  view:       { block: { number: 100, timestamp: 1_791_204_000 }, current: null, earlier: [] },
  strategic:  new Set(strategic),
  deprecated: collateralDecisionsOf(deprecated),
  hidden:     collateralDecisionsOf(hidden),
  now:        NOW,
});

// what the list decides of a token: where it is deprecated and hidden, and whether discovery shows it
const decisionOf = ({ isDeprecated, deprecatedIn, hiddenIn, isVisible, visibilityReason }: TokenVisibilityV1) => (
  { isDeprecated, deprecatedIn, hiddenIn, isVisible, visibilityReason }
);

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

t.test('the rule: what keeps a token out of discovery, then strategic, then unknown, then the threshold', async t => {
  const cases: Array<[ string, Exclusion, boolean, TokenValue, boolean, string ]> = [
    [ 'hidden everywhere it is taken',             'hidden',     false, value('fresh', '1'),                            false, 'hidden' ],
    [ 'hidden and worth the threshold',            'hidden',     false, value('fresh', '300000'),                       false, 'hidden' ],
    [ 'hidden and unreadable',                     'hidden',     false, value('unavailable', null),                     false, 'hidden' ],
    [ 'hidden and strategic',                      'hidden',     true,  value('fresh', '300000'),                       false, 'hidden' ],
    [ 'deprecated everywhere it is taken',         'deprecated', false, value('fresh', '1'),                            false, 'deprecated' ],
    [ 'deprecated and worth the threshold',        'deprecated', false, value('fresh', '300000'),                       false, 'deprecated' ],
    [ 'deprecated and unreadable',                 'deprecated', false, value('unavailable', null),                     false, 'deprecated' ],
    [ 'deprecated and strategic',                  'deprecated', true,  value('fresh', '300000'),                       false, 'deprecated' ],
    [ 'strategic below the threshold',             'none',       true,  value('fresh', '1'),                            true,  'strategic' ],
    [ 'strategic and unreadable',                  'none',       true,  value('unavailable', null),                     true,  'strategic' ],
    [ 'unreadable',                                'none',       false, value('unavailable', null),                     true,  'data_unavailable' ],
    [ 'exactly the threshold',                     'none',       false, value('fresh', '250000'),                       true,  'collateral_threshold' ],
    [ 'a hair below it',                           'none',       false, value('fresh', '249999.9999'),                  false, 'below_threshold' ],
    [ 'past it by less than a float can tell',     'none',       false, value('fresh', '250000.000000000000000000001'), true,  'collateral_threshold' ],
    [ 'short of it by less than a float can tell', 'none',       false, value('fresh', '249999.999999999999999999999'), false, 'below_threshold' ],
    [ 'above it, from an earlier minute',          'none',       false, value('stale', '300000'),                       true,  'collateral_threshold' ],
    [ 'a partial value reaching it (D7)',          'none',       false, value('partial', '250000.5'),                   true,  'collateral_threshold' ],
  ];
  for (const [ name, exclusion, isStrategic, tokenValue, isVisible, reason ] of cases) {
    t.same(visibilityOf(exclusion, isStrategic, tokenValue), { isVisible, visibilityReason: reason }, name);
  }
});

/*
 * A record of a minute's values is keyed by the rule it was valued by. Not
 * showing a deprecated token moved the rule the list decides by to 2, and not
 * showing a hidden one to 3, and left that one as it was, so the records
 * written before keep serving.
 */
t.test('a record is keyed by the rule it was valued by, not by the rule of the list', async t => {
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
    deprecated: collateralDecisionsOf([]),
    hidden:     collateralDecisionsOf([]),
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
  t.same({ threshold: list.thresholdUsd, rule: list.ruleVersion, computedAt: list.computedAt }, { threshold: '250000', rule: 3, computedAt: NOW.toISOString() });
});

/*
 * Deprecated collateral (migrations 0006 and 0007): a decision is about one
 * collateral of one Comet, and the list says where a token is one, and
 * whether it is one in every enabled market that takes it. Mainnet's weETH is
 * a collateral of the USDC, WETH and USDT markets of the fixture; mETH of the
 * USDT market alone. Each token is strategic here, so that it is shown
 * wherever no decision keeps it out.
 */
t.test('a token is deprecated only where every enabled market that takes it marks it so', async t => {
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const comet   = (key: string) => mainnet.markets.find(entry => entry.deploymentKey === key)!.contracts.comet!;
  const token   = (symbol: string) => mainnet.markets.flatMap(entry => entry.collateralAssets)
    .find(asset => asset.token.symbol === symbol)!.token.address;
  const [ WEETH, METH, XAUT ] = [ token('weETH'), token('mETH'), token('XAUt') ];
  const decided = (...pairs: Array<[ string, Address ]>) => pairs.map(([ key, tokenAddress ]) => ({ chainId: 1, cometAddress: comet(key), tokenAddress }));
  // what the list of `within` decides of a token under the deprecated decisions given, and no hidden one
  const listed  = (address: Address, deprecated: Collateral[], within = catalog) => decisionOf(
    mainnetList(within, { strategic: [ address ], deprecated, hidden: [] }).tokens.find(entry => entry.address === address)!,
  );
  const shown   = { isVisible: true, visibilityReason: 'strategic' } as const;
  const kept    = { isVisible: false, visibilityReason: 'deprecated' } as const;
  const sorted  = (...keys: string[]) => keys.map(comet).sort();

  t.same(listed(WEETH, decided([ 'usdc', WEETH ], [ 'usdt', WEETH ])),
    { isDeprecated: false, deprecatedIn: sorted('usdc', 'usdt'), hiddenIn: [], ...shown },
    'deprecated in two of the three enabled markets that take it is not deprecated, and names the two');
  t.same(listed(WEETH, decided([ 'usdc', WEETH ], [ 'usdt', WEETH ], [ 'weth', WEETH ])),
    { isDeprecated: true, deprecatedIn: sorted('usdc', 'usdt', 'weth'), hiddenIn: [], ...kept }, 'deprecated in all three is');
  t.same(listed(METH, decided([ 'usdt', METH ])), { isDeprecated: true, deprecatedIn: sorted('usdt'), hiddenIn: [], ...kept },
    'as is a token deprecated in the one market that takes it');

  t.same(listed(METH, decided([ 'usdc', METH ])), { isDeprecated: false, deprecatedIn: [], hiddenIn: [], ...shown },
    'a decision about a Comet that does not take the token as collateral marks nothing');
  t.same(listed(METH, [ { chainId: 8453, cometAddress: comet('usdt'), tokenAddress: METH } ]),
    { isDeprecated: false, deprecatedIn: [], hiddenIn: [], ...shown },
    'and a decision belongs to its chain: one about the same Comet and token on another chain marks nothing');
  t.same(listed(token('WETH'), decided()), { isDeprecated: false, deprecatedIn: [], hiddenIn: [], ...shown },
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
  }, NOW);
  t.same(listed(WEETH, decided([ 'usdc', WEETH ], [ 'usdt', WEETH ]), changed),
    { isDeprecated: true, deprecatedIn: sorted('usdc', 'usdt'), hiddenIn: [], ...kept },
    'a market whose status is deprecated does not keep a token current where it does not mark it');
  t.same(listed(XAUT, decided([ 'usdt', XAUT ]), changed), { isDeprecated: false, deprecatedIn: sorted('usdt'), hiddenIn: [], ...shown },
    'and a token only such a market takes is named there, but no enabled market makes it deprecated');
});

/*
 * With every collateral of the USDT market deprecated, the tokens no other
 * market takes are deprecated in every enabled market that takes them, and
 * not shown whatever else holds: XAUt is strategic as well, and the others
 * are shown while their value is unknown. A token another enabled market
 * still takes is named where it is deprecated, and shown or not as before.
 */
t.test('a token deprecated in every enabled market that takes it is not shown, and nothing else changes', async t => {
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
    hidden:    collateralDecisionsOf([]),
    now:       NOW,
  };
  const deprecated = collateralDecisionsOf(usdt.collateralAssets.map(asset => (
    { chainId: 1, cometAddress: usdt.contracts.comet!, tokenAddress: asset.token.address }
  )));
  const before = tokenList({ ...input, deprecated: collateralDecisionsOf([]) });
  const after  = tokenList({ ...input, deprecated });

  const DEPRECATED = [ 'mETH', 'sFRAX', 'wUSDM', 'XAUt' ];
  const decision = (list: typeof before, among: (symbol: string) => boolean) => list.tokens
    .filter(entry => among(entry.symbol))
    .map(entry => [ entry.symbol, entry.isVisible, entry.visibilityReason ]);
  t.same(after.tokens.filter(entry => entry.isDeprecated).map(entry => entry.symbol), DEPRECATED,
    'the tokens no other market takes are deprecated');
  t.same(decision(before, symbol => DEPRECATED.includes(symbol)), [
    [ 'mETH', true, 'data_unavailable' ], [ 'sFRAX', true, 'data_unavailable' ], [ 'wUSDM', true, 'data_unavailable' ], [ 'XAUt', true, 'strategic' ],
  ], 'which discovery showed before');
  t.same(decision(after, symbol => DEPRECATED.includes(symbol)), DEPRECATED.map(symbol => [ symbol, false, 'deprecated' ]),
    'and does not show now, strategic or not');
  t.same(decision(after, symbol => !DEPRECATED.includes(symbol)), decision(before, symbol => !DEPRECATED.includes(symbol)),
    'while every other token is shown or not as it was');

  const rest = (list: typeof before) => list.tokens.map(({
    isDeprecated: _isDeprecated, deprecatedIn: _deprecatedIn, isVisible: _isVisible, visibilityReason: _visibilityReason, ...token
  }) => token);
  t.same(rest(after), rest(before), 'and every other field of every token is what it was, its value included');
  t.ok(after.tokens.some(entry => !entry.isDeprecated && entry.deprecatedIn.length > 0),
    'a token deprecated in the USDT market alone is named there');
  t.ok(after.tokens.filter(entry => entry.deprecatedIn.length > 0).every(entry => entry.roles.includes('collateral')),
    'and only a collateral is ever named deprecated');
});

/*
 * Hidden collateral (migration 0008): a decision is about one collateral of
 * one Comet, as a deprecated one is, and the list says where a token is
 * hidden, as it says where it is deprecated, and whether it is hidden across
 * the chain: an enabled market that takes it hides it, and every other one
 * hides it or has it deprecated. Mainnet's weETH is a collateral of the USDC,
 * WETH and USDT markets of the fixture; mETH and XAUt of the USDT market
 * alone. Each token is strategic here, so that it is shown wherever no
 * decision keeps it out.
 */
t.test('a token is hidden only where an enabled market that takes it hides it, and every other one hides it or has it deprecated', async t => {
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const comet   = (key: string) => mainnet.markets.find(entry => entry.deploymentKey === key)!.contracts.comet!;
  const token   = (symbol: string) => mainnet.markets.flatMap(entry => entry.collateralAssets)
    .find(asset => asset.token.symbol === symbol)!.token.address;
  const [ WEETH, METH, XAUT ] = [ token('weETH'), token('mETH'), token('XAUt') ];
  const of      = (pairs: Array<[ string, Address ]>) => pairs.map(([ key, tokenAddress ]) => ({ chainId: 1, cometAddress: comet(key), tokenAddress }));
  // the decisions of both kinds, each by the market's deployment key and the token
  const decided = (hidden: Array<[ string, Address ]>, deprecated: Array<[ string, Address ]>) => ({ hidden: of(hidden), deprecated: of(deprecated) });
  const hid     = (...pairs: Array<[ string, Address ]>) => decided(pairs, []);
  // what the list of `within` decides of a token under the decisions given
  const listed  = (address: Address, { hidden, deprecated }: { hidden: Collateral[], deprecated: Collateral[] }, within = catalog) => decisionOf(
    mainnetList(within, { strategic: [ address ], deprecated, hidden }).tokens.find(entry => entry.address === address)!,
  );
  const shown   = { isVisible: true, visibilityReason: 'strategic' } as const;
  const kept    = { isVisible: false, visibilityReason: 'hidden' } as const;
  const sorted  = (...keys: string[]) => keys.map(comet).sort();

  t.same(listed(WEETH, hid([ 'usdc', WEETH ], [ 'usdt', WEETH ])),
    { isDeprecated: false, deprecatedIn: [], hiddenIn: sorted('usdc', 'usdt'), ...shown },
    'hidden in two of the three enabled markets that take it is not hidden, and names the two');
  t.same(listed(WEETH, hid([ 'usdc', WEETH ], [ 'usdt', WEETH ], [ 'weth', WEETH ])),
    { isDeprecated: false, deprecatedIn: [], hiddenIn: sorted('usdc', 'usdt', 'weth'), ...kept }, 'hidden in all three is');
  t.same(listed(METH, hid([ 'usdt', METH ])), { isDeprecated: false, deprecatedIn: [], hiddenIn: sorted('usdt'), ...kept },
    'as is a token hidden in the one market that takes it');

  t.same(listed(WEETH, decided([ [ 'usdc', WEETH ] ], [ [ 'usdt', WEETH ], [ 'weth', WEETH ] ])),
    { isDeprecated: false, deprecatedIn: sorted('usdt', 'weth'), hiddenIn: sorted('usdc'), ...kept },
    'and so is one hidden in one of the three and deprecated in the other two, which none of them offers and leaves to discovery');
  t.same(listed(WEETH, decided([ [ 'usdc', WEETH ] ], [ [ 'usdc', WEETH ], [ 'usdt', WEETH ], [ 'weth', WEETH ] ])),
    { isDeprecated: true, deprecatedIn: sorted('usdc', 'usdt', 'weth'), hiddenIn: sorted('usdc'), ...kept },
    'or deprecated in all three and hidden in one of them as well');
  t.same(listed(WEETH, decided([ [ 'usdc', WEETH ] ], [ [ 'usdt', WEETH ] ])),
    { isDeprecated: false, deprecatedIn: sorted('usdt'), hiddenIn: sorted('usdc'), ...shown },
    'while one the WETH market takes with neither decision is offered there, and is not hidden');
  t.same(listed(WEETH, decided([], [ [ 'usdc', WEETH ], [ 'usdt', WEETH ], [ 'weth', WEETH ] ])),
    { isDeprecated: true, deprecatedIn: sorted('usdc', 'usdt', 'weth'), hiddenIn: [], isVisible: false, visibilityReason: 'deprecated' },
    'nor is one deprecated in all three and hidden in none, which is deprecated instead');

  t.same(listed(METH, hid([ 'usdc', METH ])), { isDeprecated: false, deprecatedIn: [], hiddenIn: [], ...shown },
    'a decision about a Comet that does not take the token as collateral hides nothing');
  t.same(listed(METH, { ...hid(), hidden: [ { chainId: 8453, cometAddress: comet('usdt'), tokenAddress: METH } ] }),
    { isDeprecated: false, deprecatedIn: [], hiddenIn: [], ...shown },
    'and a decision belongs to its chain: one about the same Comet and token on another chain hides nothing');
  t.same(listed(token('WETH'), hid()), { isDeprecated: false, deprecatedIn: [], hiddenIn: [], ...shown }, 'nobody deciding is nothing hidden');

  const changed = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets.map(entry =>
          entry.deploymentKey === 'weth' ? { ...entry, status: 'deprecated' as const }
        : entry.deploymentKey === 'usdt' ? { ...entry, status: 'deprecated' as const }
        : entry),
    }),
  }, NOW);
  t.same(listed(WEETH, hid([ 'usdc', WEETH ], [ 'usdt', WEETH ]), changed),
    { isDeprecated: false, deprecatedIn: [], hiddenIn: sorted('usdc', 'usdt'), ...kept },
    'a market whose status is deprecated does not keep a token shown where it does not hide it');
  t.same(listed(WEETH, decided([ [ 'usdt', WEETH ] ], [ [ 'usdc', WEETH ] ]), changed),
    { isDeprecated: true, deprecatedIn: sorted('usdc'), hiddenIn: sorted('usdt'), isVisible: false, visibilityReason: 'deprecated' },
    'nor makes it hidden where it does: its decision is named, while the one enabled market that takes the token has it deprecated');
  t.same(listed(XAUT, hid([ 'usdt', XAUT ]), changed), { isDeprecated: false, deprecatedIn: [], hiddenIn: sorted('usdt'), ...shown },
    'and a token only such a market takes is named there, but no enabled market hides it');
});

/*
 * With every collateral of the USDT market hidden, the tokens no other market
 * takes are hidden in every enabled market that takes them, and not shown
 * whatever else holds: XAUt is strategic, mETH deprecated there as well, and
 * the others are shown while their value is unknown. A token another enabled
 * market still takes is named where it is hidden, and shown or not as before.
 */
t.test('a token hidden in every enabled market that takes it is not shown, whatever else holds, and nothing else changes', async t => {
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const usdt    = mainnet.markets.find(entry => entry.deploymentKey === 'usdt')!;
  const of      = (symbol: string) => usdt.collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address;
  const each    = usdt.collateralAssets.map(asset => ({ chainId: 1, cometAddress: usdt.contracts.comet!, tokenAddress: asset.token.address }));
  const input = {
    registryVersion: { id: 'v', checksum: 'c' },
    chainId:    1,
    catalog,
    network:    'ethereum-mainnet' as const,
    positions:  positionsOf(catalog, 'ethereum-mainnet'),
    view:       { block: { number: 100, timestamp: 1_791_204_000 }, current: null, earlier: [] },
    strategic:  new Set<Address>([ of('XAUt') ]),
    deprecated: collateralDecisionsOf([ { chainId: 1, cometAddress: usdt.contracts.comet!, tokenAddress: of('mETH') } ]),
    now:        NOW,
  };
  const before = tokenList({ ...input, hidden: collateralDecisionsOf([]) });
  const after  = tokenList({ ...input, hidden: collateralDecisionsOf(each) });

  const HIDDEN = [ 'mETH', 'sFRAX', 'wUSDM', 'XAUt' ];
  const decision = (list: typeof before, among: (symbol: string) => boolean) => list.tokens
    .filter(entry => among(entry.symbol))
    .map(entry => [ entry.symbol, entry.isVisible, entry.visibilityReason ]);
  t.same(after.tokens.filter(entry => entry.visibilityReason === 'hidden').map(entry => entry.symbol), HIDDEN,
    'the tokens no other market takes are hidden');
  t.same(decision(before, symbol => HIDDEN.includes(symbol)), [
    [ 'mETH', false, 'deprecated' ], [ 'sFRAX', true, 'data_unavailable' ], [ 'wUSDM', true, 'data_unavailable' ], [ 'XAUt', true, 'strategic' ],
  ], 'which discovery decided before by the deprecated decisions, the strategic mark and the value');
  t.same(decision(after, symbol => HIDDEN.includes(symbol)), HIDDEN.map(symbol => [ symbol, false, 'hidden' ]),
    'and does not show now, strategic, deprecated or neither, which the reason says first');
  t.same(decision(after, symbol => !HIDDEN.includes(symbol)), decision(before, symbol => !HIDDEN.includes(symbol)),
    'while every other token is shown or not as it was');

  const rest = (list: typeof before) => list.tokens.map(({
    hiddenIn: _hiddenIn, isVisible: _isVisible, visibilityReason: _visibilityReason, ...token
  }) => token);
  t.same(rest(after), rest(before), 'and every other field of every token is what it was, its value and its deprecated decisions included');
  t.ok(after.tokens.some(entry => entry.visibilityReason !== 'hidden' && entry.hiddenIn.length > 0),
    'a token hidden in the USDT market alone is named there');
  t.ok(after.tokens.filter(entry => entry.hiddenIn.length > 0).every(entry => entry.roles.includes('collateral')),
    'and only a collateral is ever named hidden');
  t.ok(after.tokens.every(entry => !('isHidden' in entry)), 'which the list says by its reason and its Comets, with no flag of its own');
});

/*
 * Hidden in one enabled market that takes it and deprecated in the others, a
 * token is offered by none of them and left to discovery by none: the list
 * does not show it, for the hiding, though it is not deprecated in every one.
 * weETH is strategic here, so that it is shown wherever no decision keeps it
 * out. In one market, the rule asks that market's decisions in place of the
 * chain's: a market that has the token deprecated, and does not hide it, does
 * not show it either, for the deprecating.
 */
t.test('a token hidden in an enabled market that takes it and deprecated in the others is not shown, for the hiding', async t => {
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const comet   = (key: string) => mainnet.markets.find(entry => entry.deploymentKey === key)!.contracts.comet!;
  const weEth   = mainnet.markets.find(entry => entry.deploymentKey === 'usdt')!.collateralAssets
    .find(asset => asset.token.symbol === 'weETH')!.token.address;
  const of      = (keys: string[]) => keys.map(key => ({ chainId: 1, cometAddress: comet(key), tokenAddress: weEth }));
  const sorted  = (...keys: string[]) => keys.map(comet).sort();
  // weETH as the list of `within` says it, hidden in the markets of the deployment keys `hidden` names, deprecated in those of `deprecated`
  const listed  = (hidden: string[], deprecated: string[], within = catalog) => mainnetList(within, {
    strategic:  [ weEth ],
    deprecated: of(deprecated),
    hidden:     of(hidden),
  }).tokens.find(entry => entry.address === weEth)!;

  const mixed = listed([ 'usdc' ], [ 'weth', 'usdt' ]);
  t.same(decisionOf(mixed),
    { isDeprecated: false, deprecatedIn: sorted('usdt', 'weth'), hiddenIn: sorted('usdc'), isVisible: false, visibilityReason: 'hidden' },
    'hidden in one of the three enabled markets that take it and deprecated in the other two, it is not shown, though not deprecated in every one');
  t.same(decisionOf(listed([ 'usdc' ], [ 'usdc', 'weth', 'usdt' ])),
    { isDeprecated: true, deprecatedIn: sorted('usdc', 'usdt', 'weth'), hiddenIn: sorted('usdc'), isVisible: false, visibilityReason: 'hidden' },
    'deprecated in all three and hidden in one of them as well, it is deprecated, and not shown for the hiding, which is asked first');
  t.same(decisionOf(listed([], [ 'usdc', 'weth', 'usdt' ])),
    { isDeprecated: true, deprecatedIn: sorted('usdc', 'usdt', 'weth'), hiddenIn: [], isVisible: false, visibilityReason: 'deprecated' },
    'deprecated in all three and hidden in none, it is not shown for being deprecated, as before');
  t.same(decisionOf(listed([ 'usdc' ], [ 'weth' ])),
    { isDeprecated: false, deprecatedIn: sorted('weth'), hiddenIn: sorted('usdc'), isVisible: true, visibilityReason: 'strategic' },
    'and while the USDT market takes it with neither decision, it is offered there, and the rest of the rule shows it');

  const changed = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets.map(entry => entry.deploymentKey === 'usdt' ? { ...entry, status: 'deprecated' as const } : entry),
    }),
  }, NOW);
  t.same(decisionOf(listed([ 'usdt' ], [ 'usdc', 'weth' ], changed)),
    { isDeprecated: true, deprecatedIn: sorted('usdc', 'weth'), hiddenIn: sorted('usdt'), isVisible: false, visibilityReason: 'deprecated' },
    'a market whose status is deprecated is named where it hides the token, but its hiding takes no part: the enabled markets have it deprecated');
  t.same(decisionOf(listed([ 'usdc' ], [ 'usdt' ], changed)),
    { isDeprecated: false, deprecatedIn: sorted('usdt'), hiddenIn: sorted('usdc'), isVisible: true, visibilityReason: 'strategic' },
    'nor does its deprecating: the WETH market takes the token with neither decision');

  // in one market, by its own decisions, weETH's value unknown as the list has it
  const here = (isHidden: boolean, isDeprecated: boolean) => visibilityHere({ isHidden, isDeprecated, isStrategic: mixed.isStrategic }, { valueUsd: null });
  t.same(here(true, false), { isVisible: false, visibilityReason: 'hidden' }, 'in the USDC market, which hides it, it is not shown either');
  t.same(here(false, true), { isVisible: false, visibilityReason: 'deprecated' },
    'nor in the WETH and USDT markets, which have it deprecated and do not hide it');
});

/*
 * What /summary says of a collateral is the rule with the decisions of the
 * collateral's own Comet in place of what the chain decides of hiding and
 * deprecating the token, and the value the list decided by. Where the
 * market's status is deprecated, its decisions may differ from every enabled
 * market's: weETH is hidden, or deprecated, by the USDC and WETH markets, the
 * enabled ones that take it, and not by the USDT market, deprecated here,
 * where its strategic mark and its value decide it.
 */
t.test('in one market, the rule asks that market\'s decisions in place of what the chain decides of hiding and deprecating', async t => {
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const comet   = (key: string) => mainnet.markets.find(entry => entry.deploymentKey === key)!.contracts.comet!;
  const weEth   = mainnet.markets.find(entry => entry.deploymentKey === 'usdt')!.collateralAssets
    .find(asset => asset.token.symbol === 'weETH')!.token.address;
  const changed = catalogOf({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets.map(entry => entry.deploymentKey === 'usdt' ? { ...entry, status: 'deprecated' as const } : entry),
    }),
  }, NOW);
  const of      = (keys: string[]) => keys.map(key => ({ chainId: 1, cometAddress: comet(key), tokenAddress: weEth }));
  // weETH as the summary has it from the list: its entry, and the value the list decided by
  const listed  = ({ hidden, deprecated }: { hidden: string[], deprecated: string[] }) => listedTokens({
    chainId:    1,
    catalog:    changed,
    network:    'ethereum-mainnet',
    positions:  positionsOf(changed, 'ethereum-mainnet'),
    view:       { block: { number: 100, timestamp: 1_791_204_000 }, current: null, earlier: [] },
    strategic:  new Set<Address>(),
    deprecated: collateralDecisionsOf(of(deprecated)),
    hidden:     collateralDecisionsOf(of(hidden)),
    now:        NOW,
  }).find(entry => entry.token.address === weEth)!;
  const neither = { isHidden: false, isDeprecated: false, isStrategic: false };

  const hiding = listed({ hidden: [ 'usdc', 'weth' ], deprecated: [] });
  t.same([ hiding.token.isVisible, hiding.token.visibilityReason ], [ false, 'hidden' ], 'the list does not show weETH, which every enabled market hides');
  t.same(visibilityHere({ ...neither, isHidden: true }, hiding), { isVisible: false, visibilityReason: 'hidden' }, 'nor does a market that hides it');
  t.same(visibilityHere(neither, hiding), { isVisible: true, visibilityReason: 'data_unavailable' },
    'while in the USDT market, which does not, the rest of the rule shows it, its value unknown');

  const deprecating = listed({ hidden: [], deprecated: [ 'usdc', 'weth' ] });
  t.same([ deprecating.token.isDeprecated, deprecating.token.isVisible, deprecating.token.visibilityReason ], [ true, false, 'deprecated' ],
    'nor does the list show weETH where every enabled market has it deprecated');
  t.same(visibilityHere({ ...neither, isDeprecated: true }, deprecating), { isVisible: false, visibilityReason: 'deprecated' },
    'nor does a market that has it deprecated');
  t.same(visibilityHere(neither, deprecating), { isVisible: true, visibilityReason: 'data_unavailable' },
    'while the USDT market, which does not, decides it by its strategic mark and its value: what the chain decides of deprecating takes no part');
});

/*
 * The summary decides a collateral by the value the list read of its token,
 * of which the list writes every digit: a value past the threshold, or short
 * of it, by less than a float can tell decides the collateral in a market
 * that neither hides nor deprecates it as it decides the token.
 */
t.test('in one market, the rule reads the value the list decided by', async t => {
  const weEth     = tokensOf(catalog, 'ethereum-mainnet').find(({ token }) => token.symbol === 'weETH')!.token.address;
  const positions = positionsOf(catalog, 'ethereum-mainnet');
  const held      = positions.find(position => position.token === weEth)!;
  const block     = { number: 100, timestamp: 1_791_204_000 };
  // weETH as mainnet's list has it where its first position is worth `usd` and every other position nothing
  const listed = (usd: string) => listedTokens({
    chainId:    1,
    catalog,
    network:    'ethereum-mainnet',
    positions,
    view:       {
      block,
      current: {
        chainId:     1,
        minute:      Math.floor(block.timestamp / 60),
        positionSet: 'positions',
        block,
        positions:   positions.map(position => ({
          key:     position.key,
          token:   position.token,
          outcome: {
            status:   'success' as const,
            valueUsd: position === held ? { value: usd.replace('.', ''), decimals: usd.split('.')[1]?.length ?? 0 } : { value: '0', decimals: 0 },
          },
        })),
      },
      earlier: [],
    },
    strategic:  new Set<Address>(),
    deprecated: collateralDecisionsOf([]),
    hidden:     collateralDecisionsOf([]),
    now:        NOW,
  }).find(entry => entry.token.address === weEth)!;
  const neither = { isHidden: false, isDeprecated: false, isStrategic: false };

  for (const [ usd, reason ] of [ [ '250000.000000000000000000001', 'collateral_threshold' ], [ '249999.999999999999999999999', 'below_threshold' ] ] as const) {
    const entry = listed(usd);
    t.same([ entry.token.collateralValueUsd, entry.token.visibilityReason ], [ usd, reason ], `the list writes ${usd} and decides the token by it`);
    t.same(visibilityHere(neither, entry).visibilityReason, reason, `and a market that neither hides nor deprecates it decides by ${usd} as well`);
  }
});

/*
 * /summary answers each collateral with what discovery says of its token in
 * the collateral's market, from that market's Comet's decisions, where a kind
 * of decision may not have been read. It says why the token is shown or not
 * where the decisions read decide it whichever way the others went: the
 * hiding decides alone, the deprecating once the hiding is read, and the
 * strategic mark and the value once every kind is. It says whether the token
 * is shown wherever the decisions read decide that much, even without why: it
 * is not shown where this Comet has it deprecated, whatever its hiding, or
 * where it is not strategic and is worth less than the threshold, whatever its
 * hiding and its deprecating; and shown where this Comet neither hides nor
 * deprecates it and its value reaches the threshold or cannot be read,
 * whatever its strategic mark. Every combination is asked: each kind read
 * true, read false, or not read, and a value at the threshold, short of it, or
 * unknown.
 */
t.test('in one market, discovery is said to show a token or not only where the decisions read decide it', async t => {
  const kinds = [ true, false, null ] as const;
  const values: Array<[ string, TokenValue ]> = [
    [ 'exactly the threshold', value('fresh', '250000') ],
    [ 'a hair below it',       value('fresh', '249999.9999') ],
    [ 'unreadable',            value('unavailable', null) ],
  ];
  const named = (decision: boolean | null, yes: string, no: string, unread: string) => decision === null ? unread : decision ? yes : no;
  // what the summary says of a collateral, stated apart from the rule's code
  const said = (isHidden: boolean | null, isDeprecated: boolean | null, isStrategic: boolean | null, worth: string): Partial<VisibilityV1> => {
    // a token no hiding or deprecating could show
    const unwanted = isStrategic === false && worth === 'a hair below it';
    return (
        isHidden === true                  ? { isVisible: false, visibilityReason: 'hidden' }
      : isHidden === null                  ? (isDeprecated === true || unwanted ? { isVisible: false } : {})
      : isDeprecated === true              ? { isVisible: false, visibilityReason: 'deprecated' }
      : isDeprecated === null              ? (unwanted ? { isVisible: false } : {})
      : isStrategic === null               ? (worth === 'a hair below it' ? {} : { isVisible: true })
      : isStrategic                        ? { isVisible: true, visibilityReason: 'strategic' }
      : worth === 'unreadable'             ? { isVisible: true, visibilityReason: 'data_unavailable' }
      : worth === 'exactly the threshold'  ? { isVisible: true, visibilityReason: 'collateral_threshold' }
      : { isVisible: false, visibilityReason: 'below_threshold' }
    );
  };
  for (const isHidden of kinds) {
    for (const isDeprecated of kinds) {
      for (const isStrategic of kinds) {
        for (const [ worth, tokenValue ] of values) {
          const name = [
            named(isHidden, 'hidden here', 'not hidden here', 'its hiding unread'),
            named(isDeprecated, 'deprecated here', 'not deprecated here', 'its deprecating unread'),
            named(isStrategic, 'strategic', 'not strategic', 'its strategic mark unread'),
            worth,
          ].join(', ');
          t.same(visibilityHere({ isHidden, isDeprecated, isStrategic }, tokenValue), said(isHidden, isDeprecated, isStrategic, worth), name);
        }
      }
    }
  }
});
