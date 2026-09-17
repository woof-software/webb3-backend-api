import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Row, insertStatement } from './d1.js';

/*
 * The subset of the RegistrySnapshotV1 wire shape needed to seed D1. The
 * contract itself is enforced by tests/lib/registry/registry-snapshot-v1-fixture.test.ts.
 */
type Feed = { address: string, decimals: number };
type Token = { address: string, symbol: string, name: string, decimals: number };

type PriceException = {
  kind: 'zero_price' | 'fixed_price' | 'deprecated_price_remap',
  priceFeedAddress: string,
  price?: { value: string, decimals: number },
  replacementPriceFeed?: Feed,
  provenance: string,
  expiresAt: string | null,
};

type Market = {
  id: string,
  deploymentKey: string,
  displayName: string,
  contractName: string | null,
  isDefault: boolean,
  status: 'enabled' | 'deprecated' | 'disabled',
  creationBlock: number,
  collateralValueQuote: 'usd' | 'base',
  capabilities: { rewards: boolean, accountRewards: boolean, transactionHistory: boolean },
  contracts: Record<string, string | null>,
  baseAsset: {
    token: Token,
    displayName: string,
    isWrappedNative: boolean,
    priceFeed: Feed,
    usdPriceFeed: Feed | null,
  },
  rewardAsset: { token: Token, priceFeed: Feed | null, priceFeedQuote: 'usd' | 'base' | null } | null,
  collateralAssets: Array<{ assetIndex: number, token: Token, priceFeed: Feed }>,
};

type Network = {
  chainId: number,
  key: string,
  upstreamKey: string,
  displayName: string,
  testnet: boolean,
  presentation: Record<string, unknown>,
  priceExceptions: PriceException[],
  markets: Market[],
};

type RegistrySnapshot = {
  schemaVersion: number,
  registryVersion: { id: string, sourceRepository: string, sourceCommitSha: string, checksum: string },
  networks: Network[],
};

const FIXTURE_PATH = './tests/fixtures/registry/registry-snapshot-v1.json';

const CONTRACT_ROLES: Record<string, string> = {
  comet:          'comet',
  configurator:   'configurator',
  rewards:        'rewards',
  bulker:         'bulker',
  fauceteer:      'fauceteer',
  bridgeReceiver: 'bridge_receiver',
};

function loadRegistrySnapshotFixture(): RegistrySnapshot {
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

type SeedOptions = {
  // defaults to the fixture's version id, which also keeps the fixture market ids
  versionId?: string,
  attempt?: number,
  createdAt?: string,
};

type SeededCandidate = {
  versionId: string,
  snapshotChecksum: string,
  counts: Record<string, number>,
};

/*
 * Writes the snapshot as one importing registry version in a single batch.
 * Market row ids are global primary keys, so a version other than the
 * fixture's own gets fresh market ids.
 */
async function seedCandidate(
  db: D1Database,
  snapshot: RegistrySnapshot,
  options: SeedOptions = {},
): Promise<SeededCandidate> {
  const fixtureVersionId = snapshot.registryVersion.id;
  const versionId = options.versionId ?? fixtureVersionId;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const rows: Array<[ string, Row ]> = [];
  const counts: Record<string, number> = {};
  const add = (table: string, row: Row) => {
    rows.push([ table, row ]);
    counts[table] = (counts[table] ?? 0) + 1;
  };

  add('registry_versions', {
    id:                versionId,
    source_repository: snapshot.registryVersion.sourceRepository,
    source_commit_sha: snapshot.registryVersion.sourceCommitSha,
    source_checksum:   sha256Hex(`source:${versionId}`),
    snapshot_checksum: null,
    attempt:           options.attempt ?? 1,
    status:            'importing',
    created_at:        createdAt,
    created_by:        'test-seed',
  });

  for (const network of snapshot.networks) {
    const networkId = randomUUID();
    const scope = { registry_version_id: versionId, network_id: networkId };
    add('registry_networks', {
      id:                   networkId,
      registry_version_id:  versionId,
      chain_id:             network.chainId,
      upstream_network_key: network.upstreamKey,
      canonical_name:       network.key,
      display_name:         network.displayName,
      is_testnet:           network.testnet ? 1 : 0,
      metadata:             JSON.stringify(network.presentation),
    });

    for (const exception of network.priceExceptions) {
      add('network_price_exceptions', {
        ...scope,
        price_feed_address:              exception.priceFeedAddress,
        kind:                            exception.kind,
        fixed_price_value:               exception.price?.value ?? null,
        fixed_price_decimals:            exception.price?.decimals ?? null,
        replacement_price_feed_address:  exception.replacementPriceFeed?.address ?? null,
        replacement_price_feed_decimals: exception.replacementPriceFeed?.decimals ?? null,
        provenance:                      exception.provenance,
        expires_at:                      exception.expiresAt,
      });
    }

    // on-chain token identity is shared by every market of the network
    const tokenIds = new Map<string, { id: string, token: Token }>();
    const tokenId = (token: Token): string => {
      const known = tokenIds.get(token.address);
      if (known !== undefined) {
        if (JSON.stringify(known.token) !== JSON.stringify(token)) {
          throw new Error(`fixture token ${token.address} differs between markets on chain ${network.chainId}`);
        }
        return known.id;
      }
      const id = randomUUID();
      tokenIds.set(token.address, { id, token });
      add('tokens', {
        id,
        ...scope,
        address:  token.address,
        symbol:   token.symbol,
        name:     token.name,
        decimals: token.decimals,
      });
      return id;
    };

    for (const market of network.markets) {
      const marketId = versionId === fixtureVersionId ? market.id : randomUUID();
      add('markets', {
        id:                          marketId,
        ...scope,
        deployment_key:              market.deploymentKey,
        display_name:                market.displayName,
        contract_name:               market.contractName,
        creation_block:              market.creationBlock,
        status:                      market.status,
        is_default:                  market.isDefault ? 1 : 0,
        rewards_enabled:             market.capabilities.rewards ? 1 : 0,
        account_rewards_enabled:     market.capabilities.accountRewards ? 1 : 0,
        transaction_history_enabled: market.capabilities.transactionHistory ? 1 : 0,
        collateral_value_quote:      market.collateralValueQuote,
      });

      for (const [ key, address ] of Object.entries(market.contracts)) {
        if (address !== null) {
          add('market_contracts', { market_id: marketId, role: CONTRACT_ROLES[key]!, address });
        }
      }

      const { baseAsset, rewardAsset } = market;
      add('market_assets', {
        ...scope,
        market_id:               marketId,
        token_id:                tokenId(baseAsset.token),
        role:                    'base',
        price_feed_address:      baseAsset.priceFeed.address,
        price_feed_decimals:     baseAsset.priceFeed.decimals,
        usd_price_feed_address:  baseAsset.usdPriceFeed?.address ?? null,
        usd_price_feed_decimals: baseAsset.usdPriceFeed?.decimals ?? null,
        display_name:            baseAsset.displayName,
        is_wrapped_native:       baseAsset.isWrappedNative ? 1 : 0,
      });
      if (rewardAsset !== null) {
        add('market_assets', {
          ...scope,
          market_id:           marketId,
          token_id:            tokenId(rewardAsset.token),
          role:                'reward',
          price_feed_address:  rewardAsset.priceFeed?.address ?? null,
          price_feed_decimals: rewardAsset.priceFeed?.decimals ?? null,
          price_feed_quote:    rewardAsset.priceFeedQuote,
        });
      }
      for (const collateral of market.collateralAssets) {
        add('market_assets', {
          ...scope,
          market_id:           marketId,
          token_id:            tokenId(collateral.token),
          role:                'collateral',
          asset_index:         collateral.assetIndex,
          price_feed_address:  collateral.priceFeed.address,
          price_feed_decimals: collateral.priceFeed.decimals,
        });
      }
    }
  }

  await db.batch(rows.map(([ table, row ]) => insertStatement(db, table, row)));
  return { versionId, snapshotChecksum: snapshot.registryVersion.checksum, counts };
}

export {
  RegistrySnapshot,
  SeededCandidate,
  loadRegistrySnapshotFixture,
  seedCandidate,
  sha256Hex,
};
