import t from 'tap';

import type { NetworkV1 } from '../../../lib/model/comet-registry.js';

import { compareVersions } from '../../../src/registry/changes.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * What a version changes against the one that is on. The cases are the ones
 * a new commit of the source brings: a market it adds, one it drops, a feed
 * or a collateral that moves on a market already served.
 */
const snapshot = loadRegistrySnapshotFixture();

function copy(): NetworkV1[] {
  return structuredClone(snapshot.networks);
}

function mainnet(networks: NetworkV1[]): NetworkV1 {
  return networks.find(network => network.chainId === 1)!;
}

t.test('a version identical to the one that is on changes nothing', async t => {
  const renumbered = copy();
  // every version assigns its rows new ids, which is not a change
  mainnet(renumbered).markets[0]!.id = '00000000-0000-4000-8000-00000000abcd';

  t.same(compareVersions(snapshot.networks, renumbered, new Set()), {
    networks: { added: [], removed: [], changed: [] },
    markets:  { added: [], removed: [], changed: [] },
  });
});

t.test('without a version that is on, everything is added', async t => {
  const changes = compareVersions(null, snapshot.networks, new Set([ '1/weth' ]));

  t.same(changes.networks.added, [ 1, 8453, 534352 ], 'every network');
  t.same(changes.markets.added.map(entry => entry.scope), [
    '1/usdc', '1/usdt', '1/wbtc', '1/weth', '8453/aero', '534352/usdc',
  ], 'every market, by chain and deployment key');
  t.same(
    changes.markets.added.filter(entry => !entry.reviewed).map(entry => entry.scope),
    [ '1/weth' ],
    'saying which of them nobody has reviewed',
  );
  t.notOk('id' in changes.markets.added[0]!.market, 'a market is reported without its row id');
});

t.test('a new commit is reported as what it adds, drops and changes', async t => {
  const after = copy();
  const network = mainnet(after);

  const usdc = network.markets.find(market => market.deploymentKey === 'usdc')!;
  const before = usdc.baseAsset.priceFeed.address;
  usdc.baseAsset.priceFeed = { ...usdc.baseAsset.priceFeed, address: '0x1111111111111111111111111111111111111111' };

  const weth  = network.markets.find(market => market.deploymentKey === 'weth')!;
  const count = weth.collateralAssets.length;
  weth.collateralAssets.push({ ...weth.collateralAssets[0]!, assetIndex: count });

  network.markets = network.markets.filter(market => market.deploymentKey !== 'wbtc');

  const usdt = network.markets.find(market => market.deploymentKey === 'usdt')!;
  network.markets.push({
    ...structuredClone(usdt),
    id:            '00000000-0000-4000-8000-00000000beef',
    deploymentKey: 'usde',
    status:        'disabled',
  });

  network.priceExceptions = [];

  const changes = compareVersions(snapshot.networks, after, new Set([ '1/usde' ]));

  t.same(changes.markets.added.map(({ scope, reviewed }) => ({ scope, reviewed })), [ { scope: '1/usde', reviewed: false } ],
    'the market the source added, which nobody has reviewed yet');
  t.equal(changes.markets.added[0]!.market.status, 'disabled', 'reported whole, with what its import read');
  t.same(changes.markets.removed, [ '1/wbtc' ], 'the market the source dropped');

  t.same(
    changes.markets.changed.filter(change => change.scope === '1/usdc'),
    [ { scope: '1/usdc', field: 'baseAsset.priceFeed.address', before, after: '0x1111111111111111111111111111111111111111' } ],
    'a moved feed is one field, with both answers',
  );
  const collateral = changes.markets.changed.filter(change => change.scope === '1/weth');
  t.same(collateral[0], { scope: '1/weth', field: 'collateralAssets.length', before: count, after: count + 1 },
    'an added collateral makes the list longer');
  t.ok(collateral.some(change => change.field === `collateralAssets[${count}].token.address` && change.before === null),
    'and is the entry that was not there');

  t.ok(changes.networks.changed.some(change => change.scope === '1' && change.field === 'priceExceptions.length'),
    'a network change is reported for the network');
  t.same(changes.networks.added, [], 'no network was added');
});
