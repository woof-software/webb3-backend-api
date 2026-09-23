import t from 'tap';

import type * as KnownNetwork from '../../../lib/well-known/networks/network.js';
import type { MarketV1, NetworkV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';
import { Comet } from '../../../lib/well-known/contracts/types.js';

import { ZERO_ADDRESS, catalogOf } from '../../../src/registry/catalog.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * The request catalog materializes one snapshot into the contract objects the
 * computations already consume. What it must get right is which markets are
 * resolvable, how a market is addressed, and that everything it hands out
 * comes from the one version it was built from.
 */
const snapshot = loadRegistrySnapshotFixture();

const MAINNET  = 'ethereum-mainnet';
const USDC     = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const SCROLL   = 'scroll-mainnet';

function marketsOf(networks: NetworkV1[]): MarketV1[] {
  return networks.flatMap(network => network.markets);
}

/*
 * A copy of the fixture with one market rewritten, so a test can state the
 * case it is about without mutating what every other test reads.
 */
function withMarket(
  key: string,
  change: (market: MarketV1) => MarketV1,
  source: RegistrySnapshotV1 = snapshot,
): RegistrySnapshotV1 {
  return {
    ...source,
    networks: source.networks.map(network => ({
      ...network,
      markets: network.markets.map(market => market.deploymentKey === key ? change(market) : market),
    })),
  };
}

t.test('the catalog materializes every resolvable market of one version', async t => {
  const catalog = catalogOf(snapshot);

  t.equal(catalog.versionId, snapshot.registryVersion.id, 'it answers for the version it was built from');
  t.equal(catalog.checksum, snapshot.registryVersion.checksum, 'and carries the checksum of that version');
  t.equal(catalog.markets().length, marketsOf(snapshot.networks).length, 'every market of the fixture is present');
  t.equal(catalog.networks().length, snapshot.networks.length);

  const usdc = catalog.marketAt(MAINNET, USDC);
  t.ok(usdc, 'a market is addressed by its Comet address');
  t.ok(Comet.is(usdc!.comet), 'and is handed out as a Comet contract');
  t.equal(usdc!.comet.address.toLowerCase(), USDC, 'carrying the address it is found by, checksummed');
  t.equal(usdc!.comet.displayName, 'cUSDCv3', 'named as the registry names it');
  t.equal(usdc!.comet.creation.block.number, usdc!.market.creationBlock);
  t.equal(usdc!.comet.base.asset.canonicalName, 'USDC');
  t.equal(usdc!.comet.base.asset.decimals, 6);
  t.equal(usdc!.comet.base.priceFeed.decimals, 8, 'with the feed scale the registry read, not an assumed one');
  t.equal(usdc!.chainId, 1);
  t.equal(usdc!.deploymentKey, 'usdc');
});

/*
 * The contract shapes have two places for a name: `description` carries the
 * human name of a token, which is where the static constants put it and where
 * the market rewards response reads it from, and the canonical name carries
 * the symbol.
 */
t.test('a token keeps its name where the contract shapes carry it', async t => {
  const usdc = catalogOf(snapshot).marketAt(MAINNET, USDC)!;

  t.equal(usdc.comet.base.asset.description, 'USD Coin', 'the registry name is the description');
  t.equal(usdc.comet.base.asset.canonicalName, 'USDC', 'and the symbol stays the name it is known by');
  t.equal(usdc.comet.base.asset.symbol, 'USDC');
  t.equal(usdc.comet.rewards.asset.description, 'Compound', 'the reward token too');
});

t.test('a market is addressed case-insensitively, and only on its own network', async t => {
  const catalog = catalogOf(snapshot);

  t.ok(catalog.marketAt(MAINNET, '0xc3d688B66703497DAA19211EEdFf47f25384cdc3'), 'a checksummed address resolves');
  t.equal(catalog.marketAt(SCROLL, USDC), null, 'the same address on another network does not');
  t.equal(catalog.marketAt(MAINNET, ZERO_ADDRESS), null, 'and an address no market has does not');

  t.equal(catalog.marketsOn(MAINNET).length, 4);
  t.equal(catalog.marketsOn(SCROLL).length, 1);
  t.equal(catalog.defaultMarket()?.deploymentKey, 'usdc', 'the default market is the one the version marks');
});

/*
 * The status of a market decides what may resolve it: a disabled market must
 * not be reachable at all, while a deprecated one stays reachable so existing
 * positions and history keep working, and only drops out of discovery.
 */
t.test('a disabled market is unreachable, a deprecated one is readable but not discoverable', async t => {
  const disabled = catalogOf(withMarket('weth', market => ({ ...market, status: 'disabled' })));
  t.equal(disabled.marketsOn(MAINNET).length, 3, 'a disabled market is not in the catalog');
  t.equal(disabled.markets().length, 5);

  const deprecated = catalogOf(withMarket('weth', market => ({ ...market, status: 'deprecated' })));
  const weth = deprecated.marketAt(MAINNET, '0xa17581a9e3356d9a858b789d68b4d866e593ae94');
  t.ok(weth, 'a deprecated market still resolves');
  t.equal(deprecated.discoverable().length, 5, 'but is not offered for discovery');
  t.equal(deprecated.markets().length, 6);
});

t.test('a network this API cannot name is not served', async t => {
  const catalog = catalogOf({
    ...snapshot,
    networks: [
      ...snapshot.networks,
      { ...snapshot.networks[0]!, key: 'nowhere-mainnet', chainId: 999999 },
    ],
  });

  t.equal(catalog.networks().length, snapshot.networks.length, 'the unknown network is dropped');
  t.equal(catalog.networkOf('nowhere-mainnet' as KnownNetwork.Name), null);
  t.equal(catalog.markets().length, marketsOf(snapshot.networks).length, 'and so are its markets');
});

/*
 * A price exception is the registry saying a feed must not be read from the
 * chain. It is keyed by feed address, because that is what a computation has
 * in hand when it is about to read one.
 */
t.test('price exceptions are resolved by feed address, within their network', async t => {
  const catalog = catalogOf(snapshot);
  const fixed   = catalog.priceExceptionFor(MAINNET, '0x351A133fd850ea81Ed8a782016E308aCBAddec91');

  t.equal(fixed?.kind, 'fixed_price', 'a fixed price exception resolves from a checksummed address');
  t.equal(catalog.priceExceptionFor(MAINNET, '0xe3a409ed15cd53afdefdd191ad945cec528a2496')?.kind, 'zero_price');
  t.equal(catalog.priceExceptionFor(SCROLL, '0x351a133fd850ea81ed8a782016e308acbaddec91'), null,
    'an exception does not apply to another network');
  t.equal(catalog.priceExceptionFor(MAINNET, ZERO_ADDRESS), null);
});

/*
 * An exception may carry an expiry, and it is compared as an instant. An
 * overlay may state that instant in any form Date.parse accepts, and the same
 * moment written with an offset sorts differently as a string.
 */
t.test('a price exception stops applying when it expires, whatever form the expiry took', async t => {
  const feed = '0x351a133fd850ea81ed8a782016e308acbaddec91';
  const withExpiry = (expiresAt: string | null): RegistrySnapshotV1 => ({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      priceExceptions: network.priceExceptions.map(exception => ({ ...exception, expiresAt })),
    }),
  });
  const noon = new Date('2026-09-21T12:00:00.000Z');

  t.ok(catalogOf(withExpiry(null), noon).priceExceptionFor(MAINNET, feed), 'an exception without an expiry applies');
  t.ok(
    catalogOf(withExpiry('2026-09-21T15:00:00.000Z'), noon).priceExceptionFor(MAINNET, feed),
    'and one that has not expired yet',
  );
  t.equal(
    catalogOf(withExpiry('2026-09-21T11:00:00.000Z'), noon).priceExceptionFor(MAINNET, feed), null,
    'one that has expired does not',
  );
  t.equal(
    catalogOf(withExpiry('2026-09-21T13:00:00+02:00'), noon).priceExceptionFor(MAINNET, feed), null,
    'including one written as an offset, which is 11:00Z and sorts after it as a string',
  );
  t.equal(
    catalogOf(withExpiry('whenever'), noon).priceExceptionFor(MAINNET, feed), null,
    'and one nobody can date is not one to keep suppressing a live feed with',
  );
});

t.test('the default market is one the API offers', async t => {
  t.equal(catalogOf(snapshot).defaultMarket()?.deploymentKey, 'usdc');

  const deprecated = catalogOf(withMarket('usdc', market => ({ ...market, status: 'deprecated' })));
  t.equal(deprecated.marketAt(MAINNET, USDC)?.market.status, 'deprecated', 'the market is still readable');
  t.equal(deprecated.defaultMarket(), null, 'but a deprecated market is not offered as the default');
});

/*
 * Not every market rewards. The contract shape stays uniform so no consumer
 * has to branch on its existence; what says whether rewards are usable is the
 * market's capability, and the placeholder addresses make a misuse obvious
 * rather than plausible.
 */
t.test('a market without a reward feed keeps a complete shape', async t => {
  const catalog = catalogOf(snapshot);
  const scroll  = catalog.marketsOn(SCROLL)[0]!;

  t.equal(scroll.market.rewardAsset?.priceFeed, null, 'the fixture has no reward feed on scroll');
  t.equal(scroll.comet.rewards.priceFeed.address, ZERO_ADDRESS, 'so the contract carries the placeholder feed');
  t.equal(scroll.comet.rewards.asset.canonicalName, 'COMP', 'while the reward token itself is real');
  t.equal(scroll.comet.rewards.contract.address.toLowerCase(), scroll.market.contracts.rewards);

  const none = catalogOf(withMarket('usdc', market => ({ ...market, rewardAsset: null })));
  const usdc = none.marketAt(MAINNET, USDC)!;
  t.equal(usdc.comet.rewards.asset.address, ZERO_ADDRESS, 'a market with no reward token at all uses placeholders');
  t.equal(usdc.comet.rewards.priceFeed.address, ZERO_ADDRESS);
});
