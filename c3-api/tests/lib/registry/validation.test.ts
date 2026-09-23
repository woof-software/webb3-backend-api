import t from 'tap';

import type { MarketV1, NetworkV1 } from '../../../lib/model/comet-registry.js';
import type { MarketEnrichment } from '../../../src/registry/enrichment.js';
import { failures, hasFailures, validateCandidate, validateMarketImport } from '../../../src/registry/validation.js';

import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

/*
 * Candidate validation against the frozen RegistrySnapshotV1 fixture: it must
 * pass unchanged, and each mutation of it must fail the one check that covers
 * that mistake. A check that cannot be made to fail is not protecting
 * anything, so every case names the check it expects.
 */
const snapshot = loadRegistrySnapshotFixture();

function enrichmentFor(networks: NetworkV1[]): Map<string, MarketEnrichment> {
  const enrichment = new Map<string, MarketEnrichment>();
  for (const network of networks) {
    for (const market of network.markets) {
      enrichment.set(`${network.chainId}/${market.deploymentKey}`, {
        baseToken:        market.baseAsset.token,
        basePriceFeed:    market.baseAsset.priceFeed,
        rewardToken:      market.rewardAsset?.token ?? null,
        collateralAssets: market.collateralAssets,
        missingContracts: [],
      });
    }
  }
  return enrichment;
}

/*
 * Applies one mutation to a copy of the fixture and reports which checks the
 * snapshot pass fails.
 */
function failingChecks(mutate: (networks: NetworkV1[]) => void): string[] {
  const networks = structuredClone(snapshot.networks) as NetworkV1[];
  mutate(networks);
  return [ ...new Set(failures(validateCandidate({ networks })).map(result => result.check_name)) ].sort();
}

/*
 * The import-time pass, which compares one assembled market with what the
 * chain answered for it.
 */
function failingImportChecks(mutate: (market: MarketV1, enrichment: MarketEnrichment) => void): string[] {
  const networks   = structuredClone(snapshot.networks) as NetworkV1[];
  const market     = mainnetMarket(networks, 'usdc');
  const enrichment = enrichmentFor(networks).get('1/usdc')!;
  mutate(market, enrichment);
  return failures(validateMarketImport({ chainId: 1, deploymentKey: 'usdc', market, enrichment }))
    .map(result => result.check_name)
    .sort();
}

function mainnetMarket(networks: NetworkV1[], deploymentKey: string): MarketV1 {
  return networks.find(network => network.chainId === 1)!.markets.find(market => market.deploymentKey === deploymentKey)!;
}

t.test('the frozen fixture passes every check', async t => {
  const networks = snapshot.networks as NetworkV1[];
  const results  = validateCandidate({ networks });

  t.equal(hasFailures(results), false, 'a reviewed candidate validates');
  t.ok(results.length > 50, `every market and network is checked (${results.length} checks)`);
  t.same(failures(results), [], 'with no diagnostics');

  const scopes = new Set(results.map(result => result.scope));
  t.ok(scopes.has('global'), 'checks are scoped globally,');
  t.ok(scopes.has('network:1'), 'per network,');
  t.ok(scopes.has('market:1/usdc'), 'and per market');
});

t.test('a market whose parts disagree is rejected', async t => {
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'weth').baseAsset.usdPriceFeed = null; }),
    [ 'base-usd-feed-matches-quote' ],
    'a base-quoted market without its USD conversion feed',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdc').baseAsset.usdPriceFeed = { address: '0x'.padEnd(42, 'a') as `0x${string}`, decimals: 8 }; }),
    [ 'base-usd-feed-matches-quote' ],
    'a USD-quoted market carrying one',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'weth').rewardAsset!.priceFeedQuote = null; }),
    [ 'reward-feed-paired' ],
    'a reward feed without its unit',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdc').rewardAsset!.priceFeedQuote = 'base'; }),
    [ 'reward-feed-quote-supported' ],
    'a base-quoted reward feed in a USD-quoted market',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.rewardAsset!.priceFeed = null;
      market.rewardAsset!.priceFeedQuote = null;
    }),
    [ 'rewards-capability-has-feed' ],
    'rewards enabled without a feed to price them',
  );
});

/*
 * History is read from one range of logs covering the market and the rewards
 * contract its claims come from. A market whose history is served without
 * naming that contract would be addressable and answer nothing. The
 * capability is a review, made after the import, so this is checked over the
 * stored rows rather than at import time, where it could never fail: an
 * unreviewed market serves no history yet.
 */
t.test('history is served only by a market that names its rewards contract', async t => {
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.contracts = { ...market.contracts, rewards: null };
    }),
    [ 'transaction-history-requires-rewards-contract' ],
    'transaction history without the rewards contract it is read with',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.contracts    = { ...market.contracts, rewards: null };
      market.capabilities = { ...market.capabilities, transactionHistory: false };
    }),
    [],
    'while a market that serves no history needs no rewards contract',
  );
});

t.test('an assembled market must match what the chain answered', async t => {
  t.same(
    failingImportChecks(() => {}),
    [],
    'a market assembled from the chain passes',
  );
  t.same(
    failingImportChecks((_market, enrichment) => { enrichment.rewardToken = null; }),
    [ 'reward-token-matches-chain' ],
    'a reward token the chain does not confirm',
  );
  t.same(
    failingImportChecks((_market, enrichment) => { enrichment.missingContracts = [ 'bulker' ]; }),
    [ 'market-contracts-deployed' ],
    'a declared contract with no bytecode',
  );
  t.same(
    failingImportChecks((market, enrichment) => { enrichment.baseToken = market.collateralAssets[0]!.token; }),
    [ 'base-asset-matches-chain' ],
    'a base asset the Comet does not name',
  );

});

t.test('malformed collateral is rejected', async t => {
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdc').collateralAssets.splice(0, 1); }),
    [ 'collateral-indices-contiguous' ],
    'a gap in the asset indices',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.collateralAssets[1]!.token = market.collateralAssets[0]!.token;
    }),
    [ 'collateral-assets-distinct' ],
    'the same collateral token twice',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.collateralAssets[0]!.token = market.baseAsset.token;
    }),
    [ 'collateral-excludes-base-asset' ],
    'the base asset listed as its own collateral',
  );
});

t.test('registry-wide invariants are enforced', async t => {
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'weth').isDefault = true; }),
    [ 'single-default-market' ],
    'two default markets',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdc').isDefault = false; }),
    [ 'single-default-market' ],
    'no default market at all',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdc');
      market.status = 'deprecated';
    }),
    [ 'default-market-is-enabled' ],
    'a deprecated market as the default',
  );
  /*
   * The frontend addresses a market by its slug, or by its label where it has
   * none. Two listed markets of one network answering to the same key would
   * make the second unreachable.
   */
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdt').displayName = 'usdc'; }),
    [ 'market-listing-keys-unique' ],
    'two markets of one network under one label, compared as the frontend does, ignoring case',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdt').slug = 'usdc'; }),
    [ 'market-listing-keys-unique' ],
    'or a slug that is another market\'s label',
  );
  t.same(
    failingChecks(networks => {
      const institutional = mainnetMarket(networks, 'usdt');
      institutional.displayName     = 'USDC';
      institutional.slug            = 'usdc-institutional';
      institutional.isInstitutional = true;
    }),
    [],
    'a shared label is fine where a slug tells the markets apart',
  );
  t.same(
    failingChecks(networks => {
      const market = mainnetMarket(networks, 'usdt');
      market.displayName = 'USDC';
      market.status      = 'disabled';
    }),
    [],
    'and a disabled market is not listed, so it takes no key',
  );
  t.same(
    failingChecks(networks => { networks.reverse(); }),
    [ 'networks-ordered' ],
    'networks out of chain id order',
  );
  t.same(
    failingChecks(networks => { networks[0]!.markets.reverse(); }),
    [ 'markets-ordered' ],
    'markets out of creation block order',
  );
  t.same(
    failingChecks(networks => {
      const mainnet = networks.find(network => network.chainId === 1)!;
      mainnet.markets[1]!.contracts.comet = mainnet.markets[0]!.contracts.comet;
    }),
    [ 'comet-addresses-unique' ],
    'one Comet address serving two markets',
  );
  t.same(
    failingChecks(networks => {
      const mainnet = networks.find(network => network.chainId === 1)!;
      mainnet.markets[1]!.deploymentKey = mainnet.markets[0]!.deploymentKey;
    }),
    [ 'deployment-keys-unique' ],
    'one deployment key used twice',
  );
  t.same(
    failingChecks(networks => {
      networks.find(network => network.chainId === 1)!.markets.length = 0;
    }),
    [ 'single-default-market', 'network-has-markets' ].sort(),
    'a network with no markets',
  );
  t.same(
    failingChecks(networks => {
      const exception = networks[0]!.priceExceptions.find(entry => entry.kind === 'fixed_price')!;
      networks[0]!.priceExceptions = [ {
        kind:                 'deprecated_price_remap',
        priceFeedAddress:     exception.priceFeedAddress,
        // decimals stay negative until enrichment reads the replacement feed
        replacementPriceFeed: { address: '0x'.padEnd(42, 'b') as `0x${string}`, decimals: -1 },
        provenance:           'replaced by governance',
        expiresAt:            null,
      } ];
    }),
    [ 'price-exception-feeds-readable' ],
    'a remap whose replacement feed was never read',
  );
  t.same(
    failingChecks(networks => { mainnetMarket(networks, 'usdc').creationBlock = 0; }),
    [ 'creation-block-known' ],
    'a served market with no creation block',
  );
  /*
   * A market nobody has reviewed is imported disabled, and the chain cannot
   * cheaply say when it was deployed. It is not served, so nothing starts an
   * index from it, and it must not fail the commit it arrived with.
   */
  t.same(
    failingChecks(networks => {
      const mainnet = networks.find(network => network.chainId === 1)!;
      const weth    = mainnetMarket(networks, 'weth');
      weth.creationBlock = 0;
      weth.status        = 'disabled';
      // stored markets are read back in creation-block order, so it comes first
      mainnet.markets = [ weth, ...mainnet.markets.filter(market => market !== weth) ];
    }),
    [],
    'while a disabled market may leave it unknown',
  );
});

t.test('an incomplete import cannot validate', async t => {
  const networks = snapshot.networks as NetworkV1[];
  t.same(
    failures(validateCandidate({ networks, roots: { expected: 6, imported: 6 } })),
    [],
    'a candidate holding every discovered root passes',
  );

  const incomplete = failures(validateCandidate({ networks, roots: { expected: 7, imported: 6 } }));
  t.same(incomplete.map(result => result.check_name), [ 'all-roots-imported' ], 'a missing market fails the candidate');
  t.same(
    incomplete[0]!.details,
    { expected: 7, imported: 6 },
    'and the diagnostic says how many roots never made it',
  );
});

t.test('failures carry diagnostics, passes stay compact', async t => {
  const networks = structuredClone(snapshot.networks) as NetworkV1[];
  mainnetMarket(networks, 'weth').baseAsset.usdPriceFeed = null;

  const failed = failures(validateCandidate({ networks }));
  t.equal(failed.length, 1);
  t.equal(failed[0]!.scope, 'market:1/weth', 'the scope names the market that failed');
  t.same(failed[0]!.details, {
    collateralValueQuote: 'base',
    usdPriceFeed:         null,
  }, 'diagnostics explain the mismatch without dumping the snapshot');

  const passing = validateCandidate({ networks: snapshot.networks as NetworkV1[] });
  t.ok(passing.every(result => result.details === undefined), 'a passing check stores no details');
});
