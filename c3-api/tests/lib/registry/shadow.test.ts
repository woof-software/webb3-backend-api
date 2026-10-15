import t from 'tap';

import * as KnownNetwork from '../../../lib/well-known/networks/network.js';
import type { MarketV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { COMPARED_NETWORKS, compareWithStatic, staticComets } from '../../../src/registry/shadow.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * The shadow comparison against the static constants this API still serves
 * from. Its job is to make a disagreement between the two sources visible
 * while both exist, so these tests are about what it reports and how it
 * classifies it, and about the differences the fixture actually has.
 */
const snapshot = loadRegistrySnapshotFixture();
const MAINNET  = 'ethereum-mainnet';
const WETH     = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';

function report(source: RegistrySnapshotV1 = snapshot) {
  return compareWithStatic(source);
}

function withMarket(key: string, change: (market: MarketV1) => MarketV1): RegistrySnapshotV1 {
  return {
    ...snapshot,
    networks: snapshot.networks.map(network => ({
      ...network,
      markets: network.markets.map(market => market.deploymentKey === key ? change(market) : market),
    })),
  };
}

function scopedTo(differences: ReturnType<typeof report>['differences'], scope: string) {
  return differences.filter(difference => difference.scope === scope);
}

t.test('the comparison covers the networks the registry imports, and no others', async t => {
  const shadow = report();

  t.same(COMPARED_NETWORKS, [ ...new Set(COMPARED_NETWORKS) ], 'each compared network appears once');
  t.equal(
    COMPARED_NETWORKS.filter(network => KnownNetwork.isNameOfTestnet(network)).length, 0,
    'the registry imports no testnets, so none are compared',
  );
  t.ok(COMPARED_NETWORKS.includes(MAINNET));
  t.same(shadow.networks, COMPARED_NETWORKS, 'and the report says which networks it covered');

  t.equal(shadow.versionId, snapshot.registryVersion.id, 'the report names the version it compared');
  t.equal(shadow.checksum, snapshot.registryVersion.checksum);
  t.equal(shadow.registryMarkets, 6, 'the fixture holds six markets');
  t.ok(shadow.staticMarkets > shadow.registryMarkets, 'the constants describe every deployment, the fixture a few');
});

/*
 * Two sources can disagree in three ways, and each is reported as its own
 * kind: a market only the constants have, a market only the registry has, and
 * a field the two answer differently.
 */
t.test('a market the constants do not describe is reported as such, not as differences', async t => {
  const unknown = '0x1111111111111111111111111111111111111111';
  const shadow  = report(withMarket('weth', market => ({
    ...market,
    contracts: { ...market.contracts, comet: unknown },
  })));

  t.same(shadow.onlyInRegistry, [ '1/weth' ], 'the registry market has no counterpart');
  t.equal(scopedTo(shadow.differences, '1/weth').length, 0, 'so no field of it is compared');
  t.ok(shadow.onlyInStatic.includes(`${MAINNET}/cWETHv3`),
    'and the constants entry it left behind is reported from the other side');
});

t.test('every market of the fixture exists in the constants', async t => {
  const shadow = report();

  t.same(shadow.onlyInRegistry, [], 'the fixture describes no market the constants lack');
  t.ok(shadow.onlyInStatic.length > 0, 'while the constants describe deployments the fixture leaves out');
  t.equal(
    shadow.onlyInStatic.filter(entry => entry.startsWith(`${MAINNET}/`)).length, 3,
    'on mainnet the fixture holds four of the seven deployments the constants do',
  );
});

t.test('a value the two sources disagree about is reported with both answers', async t => {
  const shadow = report(withMarket('usdc', market => ({
    ...market,
    creationBlock: 1,
    baseAsset: { ...market.baseAsset, token: { ...market.baseAsset.token, decimals: 18 } },
  })));
  const differences = scopedTo(shadow.differences, '1/usdc');

  t.same(differences.map(difference => difference.field), [ 'baseAsset.decimals', 'creationBlock' ],
    'each disagreeing field is reported once, ordered so a report reads the same way twice');
  t.same(differences[0], { scope: '1/usdc', field: 'baseAsset.decimals', static: 6, registry: 18 });
  t.equal(differences[1]!.static, 15331586, 'the constants answer stays readable beside the registry one');
  t.equal(differences[1]!.registry, 1);
});

/*
 * What the fixture and the constants disagree about today. These are real
 * differences, not test scaffolding: each one is a decision the cutover has
 * to make, and this test is what keeps them from drifting unnoticed.
 */
t.test('the differences the fixture has against the constants are the known ones', async t => {
  const shadow = report();

  t.same(shadow.differences.map(difference => `${difference.scope} ${difference.field}`), [
    // the constants flatten the WBTC market onto the BTC/USD feed; the chain
    // reports the market's own WBTC/BTC feed, with BTC/USD as the USD feed
    '1/wbtc baseAsset.priceFeed',
    '1/wbtc baseAsset.usdPriceFeed',
    // the constants point the Scroll market's reward feed at its base feed;
    // the chain has no COMP feed on Scroll, so the registry holds none
    '534352/usdc rewards.priceFeed',
    // the constants give the AERO market the USDC/USD feed as its base feed
    // and AERO/USD as a USD feed; on chain its base feed answers AERO / USD
    // itself, so the market is quoted in USD and the registry holds no USD feed
    '8453/aero baseAsset.priceFeed',
    '8453/aero baseAsset.usdPriceFeed',
  ], 'the known differences, and nothing else');
});

/*
 * A disabled market is a decision, not a gap. The operator who reads this
 * report before activating a version must not be told the registry is missing
 * a market it was told to stop serving.
 */
t.test('a market the version disables is reported as deliberate, not as missing', async t => {
  const shadow = report(withMarket('weth', market => ({ ...market, status: 'disabled' })));

  t.same(shadow.disabledInRegistry, [ '1/weth' ], 'the version says it does not serve this market');
  t.notOk(shadow.onlyInStatic.includes(`${MAINNET}/cWETHv3`), 'so it is not reported as missing');
  t.equal(shadow.registryMarkets, 5, 'and it is not counted among the markets served');
});

t.test('the static side is read by address, across every alias the constants index', async t => {
  const comets = staticComets(MAINNET);

  t.ok(comets.size > 0);
  t.ok(comets.has(WETH), 'a Comet is keyed by its lowercased address');
  t.equal(comets.get(WETH)!.address.toLowerCase(), WETH, 'and is the contract the constants hold');
  t.notOk(COMPARED_NETWORKS.includes('ethereum-sepolia'), 'a testnet the constants describe is left out entirely');
});
