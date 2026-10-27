import t from 'tap';

import { BigFixnum } from '../../../lib/bigfixnum.js';

import type { Address, VisibilityV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import type { Catalog } from '../../../src/registry/catalog.js';
import { collateralDecisionsOf } from '../../../src/registry/collateral-decisions.js';
import {
  THRESHOLD_USD,
  chainTokensOf,
  decimalString,
  tokensOf,
  visibilityHere,
  visibilityOf,
} from '../../../src/registry/token-visibility.js';
import type { ChainToken, Exclusion, Worth } from '../../../src/registry/token-visibility.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * The visibility rule, and what holds of a token across its chain, without a
 * node: what a token is in its chain's markets, what the decisions about it
 * say there, how a collateral's value in its market decides whether
 * discovery shows the token there, and how a value is written.
 */
const NOW      = new Date('2026-10-05T12:00:30.000Z');
const snapshot = loadRegistrySnapshotFixture();
const catalog  = catalogOf(snapshot, NOW);

// a collateral worth `usd` in its market, every digit of it, or one whose value could not be read
const worth = (usd: string | null): Worth => ({
  valueUsd: usd === null ? null : BigFixnum.from({ value: usd.replace('.', ''), decimals: usd.split('.')[1]?.length ?? 0 }),
});

type Collateral = { chainId: number, cometAddress: Address, tokenAddress: Address };

// mainnet's tokens as `within` serves them, under the decisions given
const mainnetTokens = (within: Catalog, { strategic = [], deprecated = [], hidden = [] }: { strategic?: Address[], deprecated?: Collateral[], hidden?: Collateral[] }) => chainTokensOf({
  chainId:    1,
  catalog:    within,
  network:    'ethereum-mainnet',
  strategic:  new Set(strategic),
  deprecated: collateralDecisionsOf(deprecated),
  hidden:     collateralDecisionsOf(hidden),
});

// what the decisions say of a token across its chain: where it is deprecated and hidden, and whether it is deprecated in every enabled market
const decisionOf = ({ isDeprecated, deprecatedIn, hiddenIn }: ChainToken) => ({ isDeprecated, deprecatedIn, hiddenIn });

const MAINNET = snapshot.networks.find(network => network.chainId === 1)!;
const comet   = (key: string) => MAINNET.markets.find(entry => entry.deploymentKey === key)!.contracts.comet!;
const token   = (symbol: string) => MAINNET.markets.flatMap(entry => entry.collateralAssets)
  .find(asset => asset.token.symbol === symbol)!.token.address;
const sorted  = (...keys: string[]) => keys.map(comet).sort();

// the fixture with the markets of the deployment keys given deprecated, a status of the market, not a decision about a collateral
const deprecatedMarkets = (...keys: string[]) => catalogOf({
  ...snapshot,
  networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
    ...network,
    markets: network.markets.map(entry => keys.includes(entry.deploymentKey) ? { ...entry, status: 'deprecated' as const } : entry),
  }),
}, NOW);

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

t.test('a disabled market contributes nothing, and a deprecated one is still listed', async t => {
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
});

t.test('the rule: what keeps a token out of discovery, then strategic, then unknown, then the threshold', async t => {
  const cases: Array<[ string, Exclusion, boolean, Worth, boolean, string ]> = [
    [ 'hidden here',                               'hidden',     false, worth('1'),                            false, 'hidden' ],
    [ 'hidden and worth the threshold',            'hidden',     false, worth('300000'),                       false, 'hidden' ],
    [ 'hidden and unreadable',                     'hidden',     false, worth(null),                           false, 'hidden' ],
    [ 'hidden and strategic',                      'hidden',     true,  worth('300000'),                       false, 'hidden' ],
    [ 'deprecated here',                           'deprecated', false, worth('1'),                            false, 'deprecated' ],
    [ 'deprecated and worth the threshold',        'deprecated', false, worth('300000'),                       false, 'deprecated' ],
    [ 'deprecated and unreadable',                 'deprecated', false, worth(null),                           false, 'deprecated' ],
    [ 'deprecated and strategic',                  'deprecated', true,  worth('300000'),                       false, 'deprecated' ],
    [ 'strategic below the threshold',             'none',       true,  worth('1'),                            true,  'strategic' ],
    [ 'strategic and unreadable',                  'none',       true,  worth(null),                           true,  'strategic' ],
    [ 'strategic and held nowhere here',           'none',       true,  worth('0'),                            true,  'strategic' ],
    [ 'unreadable',                                'none',       false, worth(null),                           true,  'data_unavailable' ],
    [ 'exactly the threshold',                     'none',       false, worth('250000'),                       true,  'collateral_threshold' ],
    [ 'a hair below it',                           'none',       false, worth('249999.9999'),                  false, 'below_threshold' ],
    [ 'past it by less than a float can tell',     'none',       false, worth('250000.000000000000000000001'), true,  'collateral_threshold' ],
    [ 'short of it by less than a float can tell', 'none',       false, worth('249999.999999999999999999999'), false, 'below_threshold' ],
    [ 'held nowhere here',                         'none',       false, worth('0'),                            false, 'below_threshold' ],
  ];
  for (const [ name, exclusion, isStrategic, value, isVisible, reason ] of cases) {
    t.same(visibilityOf(exclusion, isStrategic, value), { isVisible, visibilityReason: reason }, name);
  }
  t.equal(decimalString(THRESHOLD_USD), '250000', 'the threshold is USD 250,000, which a value is held to at least, exactly');
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

/*
 * What holds of a token across its chain: its roles there, whether an
 * administrator marked it strategic on the chain, and what the collateral
 * decisions of its markets say of it. Nothing about it is a value: what the
 * chain holds of a token decides nothing, and nothing says it.
 */
t.test('a token of a chain says its roles, its strategic mark and the decisions about it, and no value', async t => {
  const [ WEETH, XAUT ] = [ token('weETH'), token('XAUt') ];
  const tokens = new Map(mainnetTokens(catalog, {
    strategic:  [ XAUT ],
    deprecated: [ { chainId: 1, cometAddress: comet('usdt'), tokenAddress: WEETH } ],
    hidden:     [ { chainId: 1, cometAddress: comet('usdc'), tokenAddress: WEETH } ],
  }).map(entry => [ entry.symbol, entry ]));
  const weEth = MAINNET.markets.flatMap(entry => entry.collateralAssets).find(asset => asset.token.address === WEETH)!.token;
  t.strictSame(tokens.get('weETH'), {
    ...weEth,
    roles:        [ 'collateral' ],
    isStrategic:  false,
    isDeprecated: false,
    deprecatedIn: sorted('usdt'),
    hiddenIn:     sorted('usdc'),
  }, 'weETH: what the version says of it, then its roles, its strategic mark and where it is deprecated and hidden');
  t.strictSame([ tokens.get('XAUt')!.isStrategic, tokens.get('COMP')!.roles ], [ true, [ 'reward', 'collateral' ] ],
    'XAUt strategic, and COMP both a reward and a collateral');
  t.equal(tokens.size, tokensOf(catalog, 'ethereum-mainnet').length, 'every token of the chain, once');
});

/*
 * Deprecated collateral (migrations 0006 and 0007): a decision is about one
 * collateral of one Comet, and a token of a chain says where it is one, and
 * whether it is one in every enabled market that takes it. Mainnet's weETH is
 * a collateral of the USDC, WETH and USDT markets of the fixture; mETH of the
 * USDT market alone.
 */
t.test('a token is deprecated across its chain only where every enabled market that takes it marks it so', async t => {
  const [ WEETH, METH, XAUT ] = [ token('weETH'), token('mETH'), token('XAUt') ];
  const decided = (...pairs: Array<[ string, Address ]>) => pairs.map(([ key, tokenAddress ]) => ({ chainId: 1, cometAddress: comet(key), tokenAddress }));
  // what the decisions of `within` say of a token under the deprecated decisions given, and no hidden one
  const onChain = (address: Address, deprecated: Collateral[], within = catalog) => decisionOf(
    mainnetTokens(within, { deprecated }).find(entry => entry.address === address)!,
  );

  t.same(onChain(WEETH, decided([ 'usdc', WEETH ], [ 'usdt', WEETH ])), { isDeprecated: false, deprecatedIn: sorted('usdc', 'usdt'), hiddenIn: [] },
    'deprecated in two of the three enabled markets that take it is not deprecated, and names the two');
  t.same(onChain(WEETH, decided([ 'usdc', WEETH ], [ 'usdt', WEETH ], [ 'weth', WEETH ])),
    { isDeprecated: true, deprecatedIn: sorted('usdc', 'usdt', 'weth'), hiddenIn: [] }, 'deprecated in all three is');
  t.same(onChain(METH, decided([ 'usdt', METH ])), { isDeprecated: true, deprecatedIn: sorted('usdt'), hiddenIn: [] },
    'as is a token deprecated in the one market that takes it');

  t.same(onChain(METH, decided([ 'usdc', METH ])), { isDeprecated: false, deprecatedIn: [], hiddenIn: [] },
    'a decision about a Comet that does not take the token as collateral marks nothing');
  t.same(onChain(METH, [ { chainId: 8453, cometAddress: comet('usdt'), tokenAddress: METH } ]), { isDeprecated: false, deprecatedIn: [], hiddenIn: [] },
    'and a decision belongs to its chain: one about the same Comet and token on another chain marks nothing');
  t.same(onChain(token('WETH'), decided()), { isDeprecated: false, deprecatedIn: [], hiddenIn: [] }, 'nobody deciding is nothing deprecated');

  const changed = deprecatedMarkets('weth', 'usdt');
  t.same(onChain(WEETH, decided([ 'usdc', WEETH ], [ 'usdt', WEETH ]), changed), { isDeprecated: true, deprecatedIn: sorted('usdc', 'usdt'), hiddenIn: [] },
    'a market whose status is deprecated does not keep a token current where it does not mark it');
  t.same(onChain(XAUT, decided([ 'usdt', XAUT ]), changed), { isDeprecated: false, deprecatedIn: sorted('usdt'), hiddenIn: [] },
    'and a token only such a market takes is named there, but no enabled market makes it deprecated');

  const deprecating = mainnetTokens(catalog, { deprecated: decided(...MAINNET.markets.find(entry => entry.deploymentKey === 'usdt')!.collateralAssets
    .map((asset): [ string, Address ] => [ 'usdt', asset.token.address ])) });
  t.same(deprecating.filter(entry => entry.isDeprecated).map(entry => entry.symbol).sort(), [ 'XAUt', 'mETH', 'sFRAX', 'wUSDM' ],
    'with every collateral of the USDT market deprecated, the tokens no other market takes are deprecated across the chain');
  t.ok(deprecating.filter(entry => entry.deprecatedIn.length > 0).every(entry => entry.roles.includes('collateral')),
    'and only a collateral is ever named deprecated');
});

/*
 * Hidden collateral (migration 0008): a decision is about one collateral of
 * one Comet, as a deprecated one is, and a token of a chain says where it is
 * hidden. It has no flag of its own across the chain: whether discovery shows
 * the token is each market's to say, by its own decisions.
 */
t.test('a token of a chain names the Comets that hide it, and is not hidden across the chain', async t => {
  const [ WEETH, METH ] = [ token('weETH'), token('mETH') ];
  const of = (pairs: Array<[ string, Address ]>) => pairs.map(([ key, tokenAddress ]) => ({ chainId: 1, cometAddress: comet(key), tokenAddress }));
  const onChain = (address: Address, hidden: Array<[ string, Address ]>, deprecated: Array<[ string, Address ]> = [], within = catalog) => decisionOf(
    mainnetTokens(within, { hidden: of(hidden), deprecated: of(deprecated) }).find(entry => entry.address === address)!,
  );

  t.same(onChain(WEETH, [ [ 'usdc', WEETH ], [ 'usdt', WEETH ], [ 'weth', WEETH ] ]),
    { isDeprecated: false, deprecatedIn: [], hiddenIn: sorted('usdc', 'usdt', 'weth') }, 'hidden in all three markets that take it, it is named in each');
  t.same(onChain(WEETH, [ [ 'usdc', WEETH ] ], [ [ 'usdc', WEETH ], [ 'usdt', WEETH ], [ 'weth', WEETH ] ]),
    { isDeprecated: true, deprecatedIn: sorted('usdc', 'usdt', 'weth'), hiddenIn: sorted('usdc') }, 'and hiding it does not stop it being deprecated');
  t.same(onChain(METH, [ [ 'usdc', METH ] ]), { isDeprecated: false, deprecatedIn: [], hiddenIn: [] },
    'a decision about a Comet that does not take the token as collateral hides nothing');
  t.same(decisionOf(mainnetTokens(catalog, { hidden: [ { chainId: 8453, cometAddress: comet('usdt'), tokenAddress: METH } ] }).find(entry => entry.address === METH)!),
    { isDeprecated: false, deprecatedIn: [], hiddenIn: [] }, 'and a decision belongs to its chain: one about the same Comet and token on another chain hides nothing');
  t.same(onChain(WEETH, [ [ 'usdt', WEETH ] ], [], deprecatedMarkets('usdt')), { isDeprecated: false, deprecatedIn: [], hiddenIn: sorted('usdt') },
    'a market whose status is deprecated is named where it hides the token');
  t.ok(mainnetTokens(catalog, { hidden: of([ [ 'usdt', METH ] ]) }).every(entry => !('isHidden' in entry)), 'which no flag across the chain says');
});

/*
 * In one market, the rule asks that market's own decisions about the
 * collateral, and its own value, whatever every other market decides or
 * holds: weETH, hidden in USDC's market and deprecated in WETH's and USDT's,
 * is not shown in any of them, for its own reason in each; and in a market
 * that neither hides nor deprecates it, which here is USDT's, deprecated as a
 * market, the rest of the rule decides it by its value there.
 */
t.test('in one market, the rule asks that market\'s decisions and its value alone', async t => {
  const neither = { isHidden: false, isDeprecated: false, isStrategic: false };
  t.same(visibilityHere({ ...neither, isHidden: true }, worth('300000')), { isVisible: false, visibilityReason: 'hidden' },
    'in the USDC market, which hides it, it is not shown, worth the threshold there or not');
  t.same(visibilityHere({ ...neither, isDeprecated: true }, worth('300000')), { isVisible: false, visibilityReason: 'deprecated' },
    'nor in a market that has it deprecated and does not hide it');
  t.same(visibilityHere({ ...neither, isHidden: true, isDeprecated: true }, worth('300000')), { isVisible: false, visibilityReason: 'hidden' },
    'and in one that does both, for the hiding, which is asked first');
  for (const [ usd, said ] of [
    [ '250000.000000000000000000001', { isVisible: true,  visibilityReason: 'collateral_threshold' } ],
    [ '249999.999999999999999999999', { isVisible: false, visibilityReason: 'below_threshold' } ],
    [ null,                           { isVisible: true,  visibilityReason: 'data_unavailable' } ],
    [ '0',                            { isVisible: false, visibilityReason: 'below_threshold' } ],
  ] as const) {
    t.same(visibilityHere(neither, worth(usd)), said, `a market that neither hides nor deprecates it decides it by its own value there: ${usd}`);
  }
  t.same(visibilityHere({ ...neither, isStrategic: true }, worth('0')), { isVisible: true, visibilityReason: 'strategic' },
    'and shows a strategic token whatever it holds of it');
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
  const values: Array<[ string, Worth ]> = [
    [ 'exactly the threshold', worth('250000') ],
    [ 'a hair below it',       worth('249999.9999') ],
    [ 'unreadable',            worth(null) ],
  ];
  const named = (decision: boolean | null, yes: string, no: string, unread: string) => decision === null ? unread : decision ? yes : no;
  // what the summary says of a collateral, stated apart from the rule's code
  const said = (isHidden: boolean | null, isDeprecated: boolean | null, isStrategic: boolean | null, value: string): Partial<VisibilityV1> => {
    // a token no hiding or deprecating could show
    const unwanted = isStrategic === false && value === 'a hair below it';
    return (
        isHidden === true                  ? { isVisible: false, visibilityReason: 'hidden' }
      : isHidden === null                  ? (isDeprecated === true || unwanted ? { isVisible: false } : {})
      : isDeprecated === true              ? { isVisible: false, visibilityReason: 'deprecated' }
      : isDeprecated === null              ? (unwanted ? { isVisible: false } : {})
      : isStrategic === null               ? (value === 'a hair below it' ? {} : { isVisible: true })
      : isStrategic                        ? { isVisible: true, visibilityReason: 'strategic' }
      : value === 'unreadable'             ? { isVisible: true, visibilityReason: 'data_unavailable' }
      : value === 'exactly the threshold'  ? { isVisible: true, visibilityReason: 'collateral_threshold' }
      : { isVisible: false, visibilityReason: 'below_threshold' }
    );
  };
  for (const isHidden of kinds) {
    for (const isDeprecated of kinds) {
      for (const isStrategic of kinds) {
        for (const [ value, held ] of values) {
          const name = [
            named(isHidden, 'hidden here', 'not hidden here', 'its hiding unread'),
            named(isDeprecated, 'deprecated here', 'not deprecated here', 'its deprecating unread'),
            named(isStrategic, 'strategic', 'not strategic', 'its strategic mark unread'),
            value,
          ].join(', ');
          t.same(visibilityHere({ isHidden, isDeprecated, isStrategic }, held), said(isHidden, isDeprecated, isStrategic, value), name);
        }
      }
    }
  }
});

/*
 * Whether discovery shows a token follows from its reason, and its type says
 * so: each pairing below is a type error the build expects.
 */
t.test('a visibility whose isVisible and visibilityReason disagree does not compile', async () => {
  (visibility: VisibilityV1) => [
    // @ts-expect-error discovery does not show a token for being hidden, deprecated or short of the threshold
    { ...visibility, isVisible: true,  visibilityReason: 'hidden' } satisfies VisibilityV1,
    // @ts-expect-error
    { ...visibility, isVisible: true,  visibilityReason: 'deprecated' } satisfies VisibilityV1,
    // @ts-expect-error
    { ...visibility, isVisible: true,  visibilityReason: 'below_threshold' } satisfies VisibilityV1,
    // @ts-expect-error and shows one for being strategic, worth the threshold, or of a value that could not be read
    { ...visibility, isVisible: false, visibilityReason: 'strategic' } satisfies VisibilityV1,
    // @ts-expect-error
    { ...visibility, isVisible: false, visibilityReason: 'collateral_threshold' } satisfies VisibilityV1,
    // @ts-expect-error
    { ...visibility, isVisible: false, visibilityReason: 'data_unavailable' } satisfies VisibilityV1,
  ];
});
