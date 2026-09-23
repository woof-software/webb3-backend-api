import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type {
  Address,
  MarketV1,
  NetworkV1,
  ParsedRoot,
  PriceFeedV1,
} from '../../../lib/model/comet-registry.js';
import { CONTRACT_ROLES, CONTRACT_ROLE_KEYS } from '../../../lib/model/comet-registry.js';

import { applyMarketOverlay, applyNetworkOverlay, orderNetworks } from '../../../src/registry/overlay.js';
import {
  readActiveOverlays,
  readImportOverlays,
  readOverlays,
  recordValidationResults,
  markValidated,
  snapshotChecksum,
} from '../../../src/registry/repository.js';
import type { MarketEnrichment } from '../../../src/registry/enrichment.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * Overlay cloning, against real local D1: the reviewed decisions of a stored
 * version are read back and reapplied to the same markets. The rebuilt
 * snapshot must be byte-identical to the one it was cloned from, which is
 * what lets an import inherit review instead of asking an operator to restate
 * it for every unchanged market.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

const snapshot = loadRegistrySnapshotFixture();

/*
 * The pinned-source and on-chain halves of a market, taken from the fixture
 * itself: this test is about the overlay half, so the other two are given.
 */
function rootOf(network: NetworkV1, market: MarketV1): ParsedRoot {
  const contracts = Object.fromEntries(
    CONTRACT_ROLES
      .map(role => [ role, market.contracts[CONTRACT_ROLE_KEYS[role]] ])
      .filter(([ , address ]) => address !== null)
  );
  return {
    rootPath:           `deployments/${network.upstreamKey}/${market.deploymentKey}/roots.json`,
    upstreamNetworkKey: network.upstreamKey,
    deploymentKey:      market.deploymentKey,
    network:            network.key,
    chainId:            network.chainId,
    sourceBlobSha:      'a'.repeat(40),
    contracts,
    otherRoots:         {},
    checksum:           'b'.repeat(64),
  };
}

function enrichmentOf(market: MarketV1): MarketEnrichment {
  return {
    baseToken:        market.baseAsset.token,
    basePriceFeed:    market.baseAsset.priceFeed,
    rewardToken:      market.rewardAsset?.token ?? null,
    collateralAssets: market.collateralAssets,
    missingContracts: [],
  };
}

/*
 * The feeds an overlay names, with the decimals enrichment would read for
 * them: the base USD conversion, the reward feed, and any remap replacement.
 */
function feedsOf(network: NetworkV1): Map<Address, PriceFeedV1> {
  const feeds = new Map<Address, PriceFeedV1>();
  for (const market of network.markets) {
    for (const feed of [ market.baseAsset.usdPriceFeed, market.rewardAsset?.priceFeed ]) {
      if (feed !== null && feed !== undefined) {
        feeds.set(feed.address, feed);
      }
    }
  }
  for (const exception of network.priceExceptions) {
    if (exception.kind === 'deprecated_price_remap') {
      feeds.set(exception.replacementPriceFeed.address, exception.replacementPriceFeed);
    }
  }
  return feeds;
}

t.test('a stored version yields the overlay it was built from', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);

  const overlays = await readOverlays(db, versionId);
  t.equal(overlays.networks.size, snapshot.networks.length, 'every network yields an overlay');
  t.equal(
    overlays.markets.size,
    snapshot.networks.reduce((total, network) => total + network.markets.length, 0),
    'so does every market',
  );

  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const network = overlays.networks.get(1)!;
  t.equal(network.displayName, mainnet.displayName);
  t.same(network.assetDisplayOverrides, mainnet.presentation.assetDisplayOverrides, 'presentation survives the round trip');
  t.same(
    network.priceExceptions.map(exception => [ exception.kind, exception.priceFeedAddress ]),
    mainnet.priceExceptions.map(exception => [ exception.kind, exception.priceFeedAddress ]),
    'price exceptions survive with their kinds',
  );

  const weth = mainnet.markets.find(market => market.deploymentKey === 'weth')!;
  const market = overlays.markets.get('1/weth')!;
  t.same({
    displayName:          market.displayName,
    contractName:         market.contractName,
    slug:                 market.slug,
    isInstitutional:      market.isInstitutional,
    isDefault:            market.isDefault,
    status:               market.status,
    creationBlock:        market.creationBlock,
    collateralValueQuote: market.collateralValueQuote,
    capabilities:         market.capabilities,
    baseAsset:            market.baseAsset,
    rewardPriceFeed:      market.rewardPriceFeed,
  }, {
    displayName:          weth.displayName,
    contractName:         weth.contractName,
    slug:                 weth.slug,
    isInstitutional:      weth.isInstitutional,
    isDefault:            weth.isDefault,
    status:               weth.status,
    creationBlock:        weth.creationBlock,
    collateralValueQuote: weth.collateralValueQuote,
    capabilities:         weth.capabilities,
    baseAsset: {
      displayName:         weth.baseAsset.displayName,
      isWrappedNative:     weth.baseAsset.isWrappedNative,
      usdPriceFeedAddress: weth.baseAsset.usdPriceFeed!.address,
    },
    rewardPriceFeed: { address: weth.rewardAsset!.priceFeed!.address, quote: weth.rewardAsset!.priceFeedQuote },
  }, 'every reviewed decision of a market is recovered');

  const scroll = overlays.markets.get('534352/usdc')!;
  t.equal(scroll.rewardPriceFeed, null, 'a market with no reward feed clones without one');
});

t.test('cloned overlays rebuild the same snapshot', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  const overlays = await readOverlays(db, versionId);

  const rebuilt = orderNetworks(snapshot.networks.map(network => {
    const feeds = feedsOf(network);
    const markets = network.markets.map(market => applyMarketOverlay(
      rootOf(network, market),
      enrichmentOf(market),
      overlays.markets.get(`${network.chainId}/${market.deploymentKey}`)!,
      feeds,
      market.id,
    ));
    return applyNetworkOverlay(
      { chainId: network.chainId, key: network.key, upstreamKey: network.upstreamKey, testnet: network.testnet },
      overlays.networks.get(network.chainId)!,
      markets,
      feeds,
    );
  }));

  t.same(rebuilt, snapshot.networks, 'the rebuilt networks equal the frozen snapshot');
  t.equal(
    await snapshotChecksum(rebuilt),
    snapshot.registryVersion.checksum,
    'and reproduce its checksum, so a rediscovered market keeps its reviewed data',
  );
});

t.test('the active overlay is what an import inherits', async t => {
  const db = await freshDatabase();

  t.same(
    await readActiveOverlays(db),
    { networks: new Map(), markets: new Map() },
    'before the first activation there is nothing to inherit',
  );

  const { versionId } = await seedCandidate(db, snapshot);
  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, await snapshotChecksum(snapshot.networks));
  await db.batch([
    db.prepare(
      `INSERT INTO registry_activations (id, registry_version_id, previous_version_id, action, actor, reason, created_at)
       SELECT ?1, ?2, active_version_id, 'activate', 'test-admin', 'test', ?3 FROM registry_state
       WHERE singleton_id = 1 AND active_version_id IS NOT ?2`
    ).bind(randomUUID(), versionId, new Date().toISOString()),
    db.prepare(`UPDATE registry_state SET active_version_id = ?1, updated_at = ?2 WHERE singleton_id = 1`)
      .bind(versionId, new Date().toISOString()),
  ]);

  const active = await readActiveOverlays(db);
  t.equal(active.networks.size, snapshot.networks.length, 'the active version supplies network overlays');
  t.equal(active.markets.get('1/usdc')?.displayName, 'USDC', 'and market overlays');
});

/*
 * Attempts of one commit accumulate review: a market reviewed for an attempt
 * that later failed is not reviewed again for the next one. Reading only the
 * attempt before this one would lose what an earlier attempt decided about a
 * market that attempt never imported.
 */
t.test('an attempt inherits what every earlier attempt of the commit reviewed', async t => {
  const db = await freshDatabase();

  const first = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 1 });
  await db.batch([
    db.prepare(`UPDATE registry_networks SET reviewed = 1 WHERE registry_version_id = ?1`).bind(first.versionId),
    db.prepare(`UPDATE markets SET reviewed = 1, display_name = 'reviewed first' WHERE registry_version_id = ?1`)
      .bind(first.versionId),
  ]);

  /*
   * The second attempt failed before it reached the mainnet weth market, so
   * it has nothing to say about it — and it renamed the one it did import.
   */
  const second = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  await db.batch([
    db.prepare(
      `DELETE FROM markets WHERE registry_version_id = ?1 AND deployment_key = 'weth'`
    ).bind(second.versionId),
    db.prepare(
      `UPDATE markets SET reviewed = 1, display_name = 'reviewed again' WHERE registry_version_id = ?1`
    ).bind(second.versionId),
  ]);

  const third     = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 3 });
  const inherited = await readImportOverlays(db, third.versionId);

  t.equal(inherited.markets.get('1/usdc')?.displayName, 'reviewed again',
    'the latest attempt that reviewed a market decides it');
  t.equal(inherited.markets.get('1/weth')?.displayName, 'reviewed first',
    'and a market only an earlier attempt reviewed keeps that review');
  t.equal(inherited.networks.get(1)?.displayName, snapshot.networks.find(network => network.chainId === 1)!.displayName,
    'networks are inherited the same way');
});
