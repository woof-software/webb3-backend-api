import {
  ActivationAction,
  ActivationResultV1,
  Address,
  CONTRACT_ROLES,
  CONTRACT_ROLE_KEYS,
  MarketAssetRow,
  MarketContractRow,
  MarketRow,
  MarketStatus,
  MarketV1,
  NetworkPriceExceptionRow,
  NetworkV1,
  PriceExceptionV1,
  PriceQuote,
  RegistryNetworkRow,
  RegistrySnapshotV1,
  RegistryVersionRow,
  TokenV1,
  ValidationResultRow,
  ValidationSummaryV1,
} from '../../lib/model/comet-registry.js';

import { RegistryError } from './errors.js';
import {
  MarketOverlay,
  NetworkOverlay,
  parseMarketOverlay,
  parseNetworkOverlay,
} from './overlay.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { sha256Hex } from '../../lib/hash.js';

/*
 * Writes to the registry tables of APP_DB. The database owns the invariants:
 * the lifecycle, singleton, and append-only triggers of
 * migrations/0001_comet_registry.sql reject anything this module gets wrong,
 * so these functions stay thin and never re-implement those rules.
 *
 * Only candidate writes live here. Snapshot hydration for the public API
 * arrives with the registry API.
 */
type SqlValue = string | number | null;
type Row = Record<string, SqlValue>;

/*
 * D1 executes a batch as one transaction. Statements are chunked so a whole
 * registry version does not arrive as one oversized request; each chunk is
 * atomic, and a failed chunk leaves the version importing, which is a state
 * the next attempt can resume from.
 */
const BATCH_SIZE = 100;

type CandidateInput = {
  repository:     string,
  commitSha:      string,
  sourceChecksum: string,
  attempt:        number,
  createdBy:      string,
  versionId?:     string,
  createdAt?:     string,
};

/*
 * The reviewed overlay of one stored version, keyed by chain id and by
 * `chainId/deploymentKey`, which is how an import looks up the decisions made
 * for a market it rediscovers.
 */
type ClonedOverlays = {
  networks: Map<number, NetworkOverlay>,
  markets:  Map<string, MarketOverlay>,
};

type SnapshotCounts = {
  networks:         number,
  markets:          number,
  tokens:           number,
  contracts:        number,
  assets:           number,
  priceExceptions:  number,
};

function insertStatement(db: D1Database, table: string, row: Row): D1PreparedStatement {
  const columns      = Object.keys(row);
  const placeholders = columns.map((_, index) => `?${index + 1}`);
  return db
    .prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`)
    .bind(...Object.values(row));
}

async function runInChunks(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += BATCH_SIZE) {
    await db.batch(statements.slice(index, index + BATCH_SIZE));
  }
}

function boolean(value: boolean): number {
  return value ? 1 : 0;
}

/*
 * The checksum of the semantic snapshot: it covers the networks alone, and
 * within them everything except the generated row ids, so importing the same
 * markets twice produces the same value. Row ids are per-write UUIDs; keeping
 * them would make every re-import of unchanged source look like a change.
 * Objects are built in the order the RegistrySnapshotV1 contract fixes, which
 * makes the serialization canonical.
 */
async function snapshotChecksum(networks: NetworkV1[]): Promise<string> {
  const semantic = networks.map(network => ({
    ...network,
    markets: network.markets.map(({ id: _id, ...market }) => market),
  }));
  return sha256Hex(canonicalJson(semantic));
}

/*
 * Every import attempt for one source, newest first. The caller decides
 * whether to resume an importing attempt, reuse a validated one, or start a
 * new attempt after an invalid one.
 */
async function findAttempts(
  db: D1Database,
  source: { repository: string, commitSha: string, sourceChecksum: string },
): Promise<RegistryVersionRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM registry_versions
     WHERE source_repository = ?1 AND source_commit_sha = ?2 AND source_checksum = ?3
     ORDER BY attempt DESC`
  ).bind(source.repository.toLowerCase(), source.commitSha, source.sourceChecksum).all<RegistryVersionRow>();
  return results ?? [];
}

/*
 * Every attempt for one commit, whatever roots it produced. Discovery uses
 * this to recognize a commit it has already imported, without reading the
 * whole source again.
 */
async function findAttemptsByCommit(
  db: D1Database,
  repository: string,
  commitSha: string,
): Promise<RegistryVersionRow[]> {
  const { results } = await db.prepare(
    `SELECT * FROM registry_versions
     WHERE source_repository = ?1 AND source_commit_sha = ?2
     ORDER BY attempt DESC`
  ).bind(repository.toLowerCase(), commitSha).all<RegistryVersionRow>();
  return results ?? [];
}

/*
 * Creates an importing candidate. The repository identifier is stored
 * lowercase, so a casing difference cannot create a second source.
 */
async function createCandidate(db: D1Database, input: CandidateInput): Promise<RegistryVersionRow> {
  const version: RegistryVersionRow = {
    id:                input.versionId ?? crypto.randomUUID(),
    source_repository: input.repository.toLowerCase(),
    source_commit_sha: input.commitSha,
    source_checksum:   input.sourceChecksum,
    snapshot_checksum: null,
    attempt:           input.attempt,
    status:            'importing',
    created_at:        input.createdAt ?? new Date().toISOString(),
    validated_at:      null,
    created_by:        input.createdBy,
  };
  await insertStatement(db, 'registry_versions', { ...version }).run();
  return version;
}

/*
 * Replaces the snapshot rows of an importing candidate. The triggers reject
 * this for a terminal version, so a caller cannot rewrite history by mistake.
 */
async function clearCandidateSnapshot(db: D1Database, versionId: string): Promise<void> {
  await db.batch([
    // assets and contracts follow their markets and networks by cascade
    db.prepare(`DELETE FROM market_assets WHERE registry_version_id = ?1`).bind(versionId),
    db.prepare(`DELETE FROM markets WHERE registry_version_id = ?1`).bind(versionId),
    db.prepare(`DELETE FROM tokens WHERE registry_version_id = ?1`).bind(versionId),
    db.prepare(`DELETE FROM network_price_exceptions WHERE registry_version_id = ?1`).bind(versionId),
    db.prepare(`DELETE FROM registry_networks WHERE registry_version_id = ?1`).bind(versionId),
  ]);
}

type Scope = { registry_version_id: string, network_id: string };

/*
 * `reviewed` says whether the decisions in a row were made by someone. A row
 * written from a reviewed overlay says so; one written for a network or
 * market nobody has reviewed carries the provisional values of
 * provisionalNetworkOverlay and provisionalMarketOverlay, and is not cloned
 * into the next version.
 */
function networkStatement(
  db: D1Database,
  versionId: string,
  networkId: string,
  network: NetworkV1,
  reviewed: boolean = true,
): D1PreparedStatement {
  return insertStatement(db, 'registry_networks', {
    id:                   networkId,
    registry_version_id:  versionId,
    chain_id:             network.chainId,
    upstream_network_key: network.upstreamKey,
    canonical_name:       network.key,
    display_name:         network.displayName,
    is_testnet:           boolean(network.testnet),
    metadata:             JSON.stringify(network.presentation),
    reviewed:             boolean(reviewed),
  });
}

function exceptionStatements(db: D1Database, scope: Scope, network: NetworkV1): D1PreparedStatement[] {
  return network.priceExceptions.map(exception => insertStatement(db, 'network_price_exceptions', {
    ...scope,
    price_feed_address:              exception.priceFeedAddress,
    kind:                            exception.kind,
    fixed_price_value:               exception.kind === 'fixed_price' ? exception.price.value : null,
    fixed_price_decimals:            exception.kind === 'fixed_price' ? exception.price.decimals : null,
    replacement_price_feed_address:  exception.kind === 'deprecated_price_remap' ? exception.replacementPriceFeed.address : null,
    replacement_price_feed_decimals: exception.kind === 'deprecated_price_remap' ? exception.replacementPriceFeed.decimals : null,
    provenance:                      exception.provenance,
    expires_at:                      exception.expiresAt,
  }));
}

/*
 * The rows of one market, given the token ids of its network. Tokens the
 * network does not have yet are created here and reported back, so a caller
 * writing markets one at a time keeps token identity shared across them.
 */
function marketStatements(
  db: D1Database,
  scope: Scope,
  market: MarketV1,
  tokenIds: Map<Address, string>,
  reviewed: boolean = true,
): { statements: D1PreparedStatement[], tokens: number, contracts: number, assets: number } {
  const statements: D1PreparedStatement[] = [];
  let tokens = 0;

  const tokenId = (token: TokenV1): string => {
    const known = tokenIds.get(token.address);
    if (known !== undefined) {
      return known;
    }
    const id = crypto.randomUUID();
    tokenIds.set(token.address, id);
    tokens++;
    statements.push(insertStatement(db, 'tokens', {
      id,
      ...scope,
      address:  token.address,
      symbol:   token.symbol,
      name:     token.name,
      decimals: token.decimals,
    }));
    return id;
  };

  // the caller owns market identity, so the row keeps the id it was assembled with
  const marketId = market.id;
  statements.push(insertStatement(db, 'markets', {
    id:                          marketId,
    ...scope,
    deployment_key:              market.deploymentKey,
    display_name:                market.displayName,
    slug:                        market.slug,
    contract_name:               market.contractName,
    creation_block:              market.creationBlock,
    status:                      market.status,
    is_default:                  boolean(market.isDefault),
    is_institutional:            boolean(market.isInstitutional),
    rewards_enabled:             boolean(market.capabilities.rewards),
    account_rewards_enabled:     boolean(market.capabilities.accountRewards),
    transaction_history_enabled: boolean(market.capabilities.transactionHistory),
    collateral_value_quote:      market.collateralValueQuote,
    reviewed:                    boolean(reviewed),
  }));

  let contracts = 0;
  for (const role of CONTRACT_ROLES) {
    const address = market.contracts[CONTRACT_ROLE_KEYS[role]];
    if (address !== null && address !== undefined) {
      contracts++;
      statements.push(insertStatement(db, 'market_contracts', { market_id: marketId, role, address }));
    }
  }

  const { baseAsset, rewardAsset } = market;
  let assets = 1;
  statements.push(insertStatement(db, 'market_assets', {
    ...scope,
    market_id:               marketId,
    token_id:                tokenId(baseAsset.token),
    role:                    'base',
    asset_index:             null,
    price_feed_address:      baseAsset.priceFeed.address,
    price_feed_decimals:     baseAsset.priceFeed.decimals,
    price_feed_quote:        null,
    usd_price_feed_address:  baseAsset.usdPriceFeed?.address ?? null,
    usd_price_feed_decimals: baseAsset.usdPriceFeed?.decimals ?? null,
    display_name:            baseAsset.displayName,
    is_wrapped_native:       boolean(baseAsset.isWrappedNative),
  }));

  if (rewardAsset !== null) {
    assets++;
    statements.push(insertStatement(db, 'market_assets', {
      ...scope,
      market_id:           marketId,
      token_id:            tokenId(rewardAsset.token),
      role:                'reward',
      asset_index:         null,
      price_feed_address:  rewardAsset.priceFeed?.address ?? null,
      price_feed_decimals: rewardAsset.priceFeed?.decimals ?? null,
      price_feed_quote:    rewardAsset.priceFeedQuote,
    }));
  }

  for (const collateral of market.collateralAssets) {
    assets++;
    statements.push(insertStatement(db, 'market_assets', {
      ...scope,
      market_id:           marketId,
      token_id:            tokenId(collateral.token),
      role:                'collateral',
      asset_index:         collateral.assetIndex,
      price_feed_address:  collateral.priceFeed.address,
      price_feed_decimals: collateral.priceFeed.decimals,
    }));
  }

  return { statements, tokens, contracts, assets };
}

/*
 * Writes the complete snapshot of an importing candidate: networks, their
 * price exceptions, and each market with its contracts, tokens, and assets.
 * Token identity is shared within a network, so a token referenced by several
 * markets is written once.
 */
async function writeCandidateSnapshot(
  db: D1Database,
  versionId: string,
  networks: NetworkV1[],
): Promise<SnapshotCounts> {
  const statements: D1PreparedStatement[] = [];
  const counts: SnapshotCounts = {
    networks: 0, markets: 0, tokens: 0, contracts: 0, assets: 0, priceExceptions: 0,
  };

  for (const network of networks) {
    const networkId = crypto.randomUUID();
    const scope     = { registry_version_id: versionId, network_id: networkId };
    counts.networks++;
    statements.push(networkStatement(db, versionId, networkId, network));

    const exceptions = exceptionStatements(db, scope, network);
    counts.priceExceptions += exceptions.length;
    statements.push(...exceptions);

    const tokenIds = new Map<Address, string>();
    for (const market of network.markets) {
      const written = marketStatements(db, scope, market, tokenIds);
      counts.markets++;
      counts.tokens    += written.tokens;
      counts.contracts += written.contracts;
      counts.assets    += written.assets;
      statements.push(...written.statements);
    }
  }

  await runInChunks(db, statements);
  return counts;
}

/*
 * Writes one network of a candidate if it is not there yet, and returns its
 * row id. An import discovers a network when it reaches the first market on
 * it, and later markets of the same network find it already written.
 */
async function ensureNetwork(
  db: D1Database,
  versionId: string,
  network: NetworkV1,
  reviewed: boolean = true,
): Promise<string> {
  const existing = await db.prepare(
    `SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = ?2`
  ).bind(versionId, network.chainId).first<string>('id');
  if (existing !== null && existing !== undefined) {
    return existing;
  }

  const networkId = crypto.randomUUID();
  const scope     = { registry_version_id: versionId, network_id: networkId };
  await db.batch([
    networkStatement(db, versionId, networkId, network, reviewed),
    ...exceptionStatements(db, scope, network),
  ]);
  return networkId;
}

/*
 * Writes one market of a candidate, reusing the token rows its network
 * already has. This is the incremental counterpart of writeCandidateSnapshot:
 * an import commits a market as its checkpoint completes, so an interrupted
 * invocation loses nothing.
 */
async function writeMarket(
  db: D1Database,
  versionId: string,
  networkId: string,
  market: MarketV1,
  reviewed: boolean = true,
): Promise<void> {
  const known = await db.prepare(
    `SELECT id, address FROM tokens WHERE registry_version_id = ?1 AND network_id = ?2`
  ).bind(versionId, networkId).all<{ id: string, address: Address }>();

  const tokenIds = new Map<Address, string>(
    (known.results ?? []).map(token => [ token.address, token.id ])
  );
  const { statements } = marketStatements(
    db,
    { registry_version_id: versionId, network_id: networkId },
    market,
    tokenIds,
    reviewed,
  );

  /*
   * Writing a market is idempotent: an import that committed a market and
   * then lost its invocation before the checkpoint is retried, and the retry
   * must replace the market rather than collide with the deployment key it
   * already wrote. Contracts and assets follow the market by cascade; tokens
   * stay, because token identity is shared with the network's other markets.
   */
  await db.batch([
    db.prepare(
      `DELETE FROM markets WHERE registry_version_id = ?1 AND network_id = ?2 AND deployment_key = ?3`
    ).bind(versionId, networkId, market.deploymentKey),
    ...statements,
  ]);
}

/*
 * Reads a stored version back as the snapshot shape: what validation checks,
 * what the snapshot checksum is taken over, and what the public API will
 * serve. Ordering is the contract's: networks by chain id, markets by
 * creation block then deployment key, collateral by asset index.
 */
async function readSnapshot(db: D1Database, versionId: string): Promise<NetworkV1[]> {
  const [ networkRows, exceptionRows, marketRows, contractRows, assetRows ] = await db.batch([
    db.prepare(
      `SELECT id, chain_id, canonical_name, upstream_network_key, display_name, is_testnet, metadata
       FROM registry_networks WHERE registry_version_id = ?1 ORDER BY chain_id`
    ).bind(versionId),
    db.prepare(
      `SELECT * FROM network_price_exceptions WHERE registry_version_id = ?1 ORDER BY price_feed_address`
    ).bind(versionId),
    db.prepare(
      `SELECT * FROM markets WHERE registry_version_id = ?1 ORDER BY creation_block, deployment_key`
    ).bind(versionId),
    db.prepare(
      `SELECT contract.* FROM market_contracts AS contract
       JOIN markets AS market ON market.id = contract.market_id
       WHERE market.registry_version_id = ?1`
    ).bind(versionId),
    db.prepare(
      `SELECT asset.*, token.address AS token_address, token.symbol, token.name, token.decimals
       FROM market_assets AS asset
       JOIN tokens AS token ON token.id = asset.token_id
       WHERE asset.registry_version_id = ?1
       ORDER BY asset.asset_index`
    ).bind(versionId),
  ]) as [
    D1Result<RegistryNetworkRow>, D1Result<NetworkPriceExceptionRow>, D1Result<MarketRow>,
    D1Result<MarketContractRow>, D1Result<MarketAssetRow & { token_address: Address, symbol: string, name: string, decimals: number }>,
  ];

  const contractsByMarket = new Map<string, MarketContractRow[]>();
  for (const row of contractRows.results ?? []) {
    contractsByMarket.set(row.market_id, [ ...(contractsByMarket.get(row.market_id) ?? []), row ]);
  }
  const assetsByMarket = new Map<string, Array<MarketAssetRow & { token_address: Address, symbol: string, name: string, decimals: number }>>();
  for (const row of assetRows.results ?? []) {
    assetsByMarket.set(row.market_id, [ ...(assetsByMarket.get(row.market_id) ?? []), row ]);
  }

  return (networkRows.results ?? []).map(network => {
    const presentation = JSON.parse(network.metadata) as NetworkV1['presentation'];
    const markets = (marketRows.results ?? [])
      .filter(market => market.network_id === network.id)
      .map(market => {
        const assets    = assetsByMarket.get(market.id) ?? [];
        const contracts = Object.fromEntries(CONTRACT_ROLES.map(role => [
          CONTRACT_ROLE_KEYS[role],
          (contractsByMarket.get(market.id) ?? []).find(contract => contract.role === role)?.address ?? null,
        ])) as MarketV1['contracts'];

        const tokenOf = (row: typeof assets[number]): TokenV1 => ({
          address:  row.token_address,
          symbol:   row.symbol,
          name:     row.name,
          decimals: row.decimals,
        });
        const feedOf = (address: Address | null, decimals: number | null) => (
          address === null || decimals === null ? null : { address, decimals }
        );

        const base   = assets.find(asset => asset.role === 'base')!;
        const reward = assets.find(asset => asset.role === 'reward') ?? null;

        return {
          id:                   market.id,
          deploymentKey:        market.deployment_key,
          displayName:          market.display_name,
          slug:                 market.slug,
          contractName:         market.contract_name,
          isDefault:            market.is_default === 1,
          isInstitutional:      market.is_institutional === 1,
          status:               market.status,
          creationBlock:        market.creation_block,
          collateralValueQuote: market.collateral_value_quote,
          capabilities: {
            rewards:            market.rewards_enabled === 1,
            accountRewards:     market.account_rewards_enabled === 1,
            transactionHistory: market.transaction_history_enabled === 1,
          },
          contracts,
          baseAsset: {
            token:           tokenOf(base),
            displayName:     base.display_name!,
            isWrappedNative: base.is_wrapped_native === 1,
            priceFeed:       feedOf(base.price_feed_address, base.price_feed_decimals)!,
            usdPriceFeed:    feedOf(base.usd_price_feed_address, base.usd_price_feed_decimals),
          },
          rewardAsset: reward === null ? null : {
            token:          tokenOf(reward),
            priceFeed:      feedOf(reward.price_feed_address, reward.price_feed_decimals),
            priceFeedQuote: reward.price_feed_quote,
          },
          collateralAssets: assets
            .filter(asset => asset.role === 'collateral')
            .sort((left, right) => (left.asset_index ?? 0) - (right.asset_index ?? 0))
            .map(asset => ({
              assetIndex: asset.asset_index!,
              token:      tokenOf(asset),
              priceFeed:  feedOf(asset.price_feed_address, asset.price_feed_decimals)!,
            })),
        };
      });

    return {
      chainId:     network.chain_id,
      key:         network.canonical_name,
      upstreamKey: network.upstream_network_key,
      displayName: network.display_name,
      testnet:     network.is_testnet === 1,
      presentation,
      priceExceptions: (exceptionRows.results ?? [])
        .filter(exception => exception.network_id === network.id)
        .map((exception): PriceExceptionV1 => {
          // each branch is written out, so the key order follows the wire
          // contract and the kind stays a literal the union can discriminate
          if (exception.kind === 'fixed_price') {
            return {
              kind:             'fixed_price',
              priceFeedAddress: exception.price_feed_address,
              price:            { value: exception.fixed_price_value!, decimals: exception.fixed_price_decimals! },
              provenance:       exception.provenance,
              expiresAt:        exception.expires_at,
            };
          }
          if (exception.kind === 'deprecated_price_remap') {
            return {
              kind:                 'deprecated_price_remap',
              priceFeedAddress:     exception.price_feed_address,
              replacementPriceFeed: {
                address:  exception.replacement_price_feed_address!,
                decimals: exception.replacement_price_feed_decimals!,
              },
              provenance:           exception.provenance,
              expiresAt:            exception.expires_at,
            };
          }
          return {
            kind:             'zero_price',
            priceFeedAddress: exception.price_feed_address,
            provenance:       exception.provenance,
            expiresAt:        exception.expires_at,
          };
        }),
      markets,
    };
  });
}

/*
 * The version a request resolves against, and the snapshot it serves.
 */
async function readActiveVersionId(db: D1Database): Promise<string | null> {
  const active = await db
    .prepare(`SELECT active_version_id FROM registry_state WHERE singleton_id = 1`)
    .first<string | null>('active_version_id');
  return active ?? null;
}

async function readVersion(db: D1Database, versionId: string): Promise<RegistryVersionRow | null> {
  const version = await db
    .prepare(`SELECT * FROM registry_versions WHERE id = ?1`)
    .bind(versionId).first<RegistryVersionRow>();
  return version ?? null;
}

/*
 * A stored version as the wire contract serves it. Only a validated version
 * has a snapshot checksum, so only a validated version can be served.
 */
async function readRegistrySnapshot(db: D1Database, versionId: string): Promise<RegistrySnapshotV1 | null> {
  const version = await readVersion(db, versionId);
  if (version === null || version.status !== 'validated' || version.snapshot_checksum === null) {
    return null;
  }
  return {
    schemaVersion: 1,
    registryVersion: {
      id:               version.id,
      sourceRepository: version.source_repository,
      sourceCommitSha:  version.source_commit_sha,
      checksum:         version.snapshot_checksum,
    },
    networks: await readSnapshot(db, versionId),
  };
}

async function readActiveSnapshot(db: D1Database): Promise<RegistrySnapshotV1 | null> {
  const activeVersionId = await readActiveVersionId(db);
  return activeVersionId === null ? null : readRegistrySnapshot(db, activeVersionId);
}

/*
 * Moves the active pointer, auditing the change. Both statements carry the
 * same condition, so activating the version that is already active writes
 * neither: it is an idempotent no-op, not a second activation event.
 *
 * The pointer trigger refuses a target that is not validated, and because
 * both statements run in one batch, a refused pointer change rolls back the
 * audit event with it.
 */
async function activateVersion(
  db: D1Database,
  input: { versionId: string, action: ActivationAction, actor: string, reason: string },
): Promise<ActivationResultV1> {
  const version = await readVersion(db, input.versionId);
  if (version === null) {
    throw new RegistryError('CANDIDATE_STATE_CONFLICT', `no such registry version`, input.versionId);
  }
  if (version.status !== 'validated' || version.snapshot_checksum === null) {
    throw new RegistryError(
      'CANDIDATE_STATE_CONFLICT',
      `only a validated version can be ${input.action === 'rollback' ? 'restored' : 'activated'}`,
      input.versionId,
    );
  }

  const activationId = crypto.randomUUID();
  const timestamp    = new Date().toISOString();

  const [ auditResult, pointerResult ] = await db.batch([
    db.prepare(
      `INSERT INTO registry_activations (id, registry_version_id, previous_version_id, action, actor, reason, created_at)
       SELECT ?1, ?2, active_version_id, ?3, ?4, ?5, ?6
       FROM registry_state
       WHERE singleton_id = 1 AND active_version_id IS NOT ?2`
    ).bind(activationId, input.versionId, input.action, input.actor, input.reason, timestamp),
    db.prepare(
      `UPDATE registry_state SET active_version_id = ?1, updated_at = ?2
       WHERE singleton_id = 1 AND active_version_id IS NOT ?1`
    ).bind(input.versionId, timestamp),
  ]);

  const audited = changedRows(auditResult!);
  const moved   = changedRows(pointerResult!);
  if (audited !== moved) {
    throw new RegistryError(
      'CANDIDATE_STATE_CONFLICT',
      `the activation audit and the pointer disagree`,
      input.versionId,
    );
  }

  /*
   * What was replaced is read back from the audit row this activation wrote,
   * not from a read taken before the batch. Two activations can race, and the
   * answer an operator is given must be the one the audit trail records, not
   * the state the request happened to observe on the way in.
   */
  const previousVersionId = moved === 1
    ? await db.prepare(`SELECT previous_version_id FROM registry_activations WHERE id = ?1`)
        .bind(activationId).first<string | null>('previous_version_id')
    : null;

  return {
    action:            input.action,
    activationId:      moved === 1 ? activationId : null,
    previousVersionId: previousVersionId ?? null,
    targetVersionId:   input.versionId,
    changed:           moved === 1,
    registryVersion:   { id: input.versionId, checksum: version.snapshot_checksum },
  };
}

/*
 * The latest complete validation attempt of a version, which is the one that
 * decided its status.
 */
/*
 * The checks one attempt recorded, as they were recorded. Validating a stored
 * candidate carries forward the ones the chain answered, which only the
 * attempt that imported it could have run.
 */
async function readAttemptChecks(
  db: D1Database,
  versionId: string,
  attempt: number,
): Promise<Array<{ check_name: string, scope: string, passed: number, details?: Record<string, unknown> }>> {
  const { results } = await db.prepare(
    `SELECT check_name, scope, passed, details FROM validation_results
     WHERE registry_version_id = ?1 AND validation_attempt = ?2`
  ).bind(versionId, attempt).all<{ check_name: string, scope: string, passed: number, details: string }>();

  return (results ?? []).map(row => ({
    check_name: row.check_name,
    scope:      row.scope,
    passed:     row.passed,
    ...(row.passed === 1 ? {} : { details: JSON.parse(row.details) as Record<string, unknown> }),
  }));
}

async function readValidationSummary(db: D1Database, versionId: string): Promise<ValidationSummaryV1> {
  const attempt = await latestValidationAttempt(db, versionId);
  if (attempt === 0) {
    return { attempt: 0, passed: 0, failed: 0, checks: [] };
  }
  const { results } = await db.prepare(
    `SELECT check_name, scope, passed, details FROM validation_results
     WHERE registry_version_id = ?1 AND validation_attempt = ?2
     ORDER BY passed, check_name, scope`
  ).bind(versionId, attempt).all<{ check_name: string, scope: string, passed: number, details: string }>();

  const checks = (results ?? []).map(row => ({
    name:   row.check_name,
    scope:  row.scope,
    passed: row.passed === 1,
    ...(row.passed === 1 ? {} : { details: JSON.parse(row.details) as unknown }),
  }));
  return {
    attempt,
    passed: checks.filter(check => check.passed).length,
    failed: checks.filter(check => !check.passed).length,
    checks,
  };
}

async function readActivationHistory(
  db: D1Database,
  versionId: string,
): Promise<Array<{ id: string, action: string, previousVersionId: string | null, actor: string, reason: string, createdAt: string }>> {
  const { results } = await db.prepare(
    `SELECT id, action, previous_version_id, actor, reason, created_at
     FROM registry_activations
     WHERE registry_version_id = ?1 OR previous_version_id = ?1
     ORDER BY created_at DESC, rowid DESC`
  ).bind(versionId).all<{
    id: string, action: string, previous_version_id: string | null,
    actor: string, reason: string, created_at: string,
  }>();
  return (results ?? []).map(row => ({
    id:                row.id,
    action:            row.action,
    previousVersionId: row.previous_version_id,
    actor:             row.actor,
    reason:            row.reason,
    createdAt:         row.created_at,
  }));
}

/*
 * Rebuilds the reviewed overlay of a stored version, so an import inherits
 * the decisions already made for markets it rediscovers. Rows are read back
 * through the overlay parsers, which normalizes them and rejects a version
 * whose stored overlay no longer satisfies the contract.
 */
async function readOverlays(db: D1Database, versionId: string): Promise<ClonedOverlays> {
  /*
   * Only what someone reviewed is an overlay. A row written for a network or
   * market nobody reviewed carries provisional values, and cloning those into
   * the next version would turn them into decisions nobody made.
   */
  const networkRows = await db.prepare(
    `SELECT chain_id, canonical_name, upstream_network_key, display_name, is_testnet, metadata
     FROM registry_networks WHERE registry_version_id = ?1 AND reviewed = 1 ORDER BY chain_id`
  ).bind(versionId).all<{
    chain_id: number, canonical_name: string, upstream_network_key: string,
    display_name: string, is_testnet: number, metadata: string,
  }>();

  const exceptionRows = await db.prepare(
    `SELECT network.chain_id AS chain_id, exception.*
     FROM network_price_exceptions AS exception
     JOIN registry_networks AS network ON network.id = exception.network_id
     WHERE exception.registry_version_id = ?1 AND network.reviewed = 1
     ORDER BY network.chain_id, exception.price_feed_address`
  ).bind(versionId).all<NetworkPriceExceptionRow & { chain_id: number }>();

  const marketRows = await db.prepare(
    `SELECT network.chain_id AS chain_id, market.deployment_key, market.display_name, market.slug, market.contract_name,
            market.is_default, market.is_institutional, market.status, market.creation_block, market.collateral_value_quote,
            market.rewards_enabled, market.account_rewards_enabled, market.transaction_history_enabled,
            base.display_name AS base_display_name, base.is_wrapped_native,
            base.usd_price_feed_address, reward.price_feed_address AS reward_price_feed_address,
            reward.price_feed_quote AS reward_price_feed_quote
     FROM markets AS market
     JOIN registry_networks AS network ON network.id = market.network_id
     LEFT JOIN market_assets AS base ON base.market_id = market.id AND base.role = 'base'
     LEFT JOIN market_assets AS reward ON reward.market_id = market.id AND reward.role = 'reward'
     WHERE market.registry_version_id = ?1 AND market.reviewed = 1
     ORDER BY network.chain_id, market.creation_block, market.deployment_key`
  ).bind(versionId).all<{
    chain_id: number, deployment_key: string, display_name: string, slug: string | null, contract_name: string | null,
    is_default: number, is_institutional: number, status: MarketStatus, creation_block: number, collateral_value_quote: PriceQuote,
    rewards_enabled: number, account_rewards_enabled: number, transaction_history_enabled: number,
    base_display_name: string | null, is_wrapped_native: number | null,
    usd_price_feed_address: string | null, reward_price_feed_address: string | null,
    reward_price_feed_quote: PriceQuote | null,
  }>();

  const exceptionsByChain = new Map<number, unknown[]>();
  for (const row of exceptionRows.results ?? []) {
    const shared = { priceFeedAddress: row.price_feed_address, provenance: row.provenance, expiresAt: row.expires_at };
    const exception = row.kind === 'fixed_price'
      ? { kind: row.kind, ...shared, price: { value: row.fixed_price_value, decimals: row.fixed_price_decimals } }
      : row.kind === 'deprecated_price_remap'
        ? { kind: row.kind, ...shared, replacementPriceFeedAddress: row.replacement_price_feed_address }
        : { kind: row.kind, ...shared };
    exceptionsByChain.set(row.chain_id, [ ...(exceptionsByChain.get(row.chain_id) ?? []), exception ]);
  }

  const networks = new Map<number, NetworkOverlay>();
  for (const row of networkRows.results ?? []) {
    const presentation = JSON.parse(row.metadata) as Record<string, unknown>;
    networks.set(row.chain_id, parseNetworkOverlay({
      displayName:               row.display_name,
      assetDisplayOverrides:     presentation.assetDisplayOverrides ?? [],
      unwrappedCollateralAssets: presentation.unwrappedCollateralAssets ?? [],
      priceExceptions:           exceptionsByChain.get(row.chain_id) ?? [],
    }, `version ${versionId} network ${row.chain_id}`));
  }

  const markets = new Map<string, MarketOverlay>();
  for (const row of marketRows.results ?? []) {
    markets.set(`${row.chain_id}/${row.deployment_key}`, parseMarketOverlay({
      displayName:          row.display_name,
      slug:                 row.slug,
      contractName:         row.contract_name,
      isDefault:            row.is_default === 1,
      isInstitutional:      row.is_institutional === 1,
      status:               row.status,
      creationBlock:        row.creation_block,
      collateralValueQuote: row.collateral_value_quote,
      capabilities: {
        rewards:            row.rewards_enabled === 1,
        accountRewards:     row.account_rewards_enabled === 1,
        transactionHistory: row.transaction_history_enabled === 1,
      },
      baseAsset: {
        displayName:         row.base_display_name,
        isWrappedNative:     row.is_wrapped_native === 1,
        usdPriceFeedAddress: row.usd_price_feed_address,
      },
      rewardPriceFeed: row.reward_price_feed_address === null ? null : {
        address: row.reward_price_feed_address,
        quote:   row.reward_price_feed_quote,
      },
    }, `version ${versionId} market ${row.chain_id}/${row.deployment_key}`));
  }

  return { networks, markets };
}

/*
 * The overlay of the currently active version, or empty maps when no version
 * has been activated yet, which is the first import.
 */
async function readActiveOverlays(db: D1Database): Promise<ClonedOverlays> {
  const activeVersionId = await db
    .prepare(`SELECT active_version_id FROM registry_state WHERE singleton_id = 1`)
    .first<string | null>('active_version_id');
  if (activeVersionId === null || activeVersionId === undefined) {
    return { networks: new Map(), markets: new Map() };
  }
  return readOverlays(db, activeVersionId);
}

/*
 * The overlay an import applies: what the active version says, with what was
 * reviewed for the earlier attempts at the same commit over it.
 *
 * An earlier attempt matters because a review happens in place, in the rows
 * of an importing candidate, and a candidate that ends invalid is frozen with
 * those rows in it. The next attempt at the same source inherits them rather
 * than asking for the same review again. A different commit does not: what
 * was reviewed for it and then activated is already the active version.
 *
 * Every earlier attempt is read, oldest first, so the newest review of a
 * market wins and one attempt that reviewed nothing — it failed on the chain
 * before anyone saw it — does not lose the review an attempt before it
 * carried.
 */
async function readImportOverlays(db: D1Database, versionId: string): Promise<ClonedOverlays> {
  const active  = await readActiveOverlays(db);
  const earlier = await db.prepare(
    `SELECT previous.id
     FROM registry_versions AS current
     JOIN registry_versions AS previous
       ON previous.source_repository = current.source_repository
      AND previous.source_commit_sha = current.source_commit_sha
      AND previous.attempt < current.attempt
     WHERE current.id = ?1
     ORDER BY previous.attempt`
  ).bind(versionId).all<{ id: string }>();

  const inherited = { networks: new Map(active.networks), markets: new Map(active.markets) };
  for (const attempt of earlier.results ?? []) {
    const reviewed = await readOverlays(db, attempt.id);
    for (const [ chainId, overlay ] of reviewed.networks) {
      inherited.networks.set(chainId, overlay);
    }
    for (const [ key, overlay ] of reviewed.markets) {
      inherited.markets.set(key, overlay);
    }
  }
  return inherited;
}

/*
 * What in a version nobody has reviewed: the networks and markets an import
 * wrote with provisional values. It is what an operator works through before
 * the version can be offered, and what a new deployment in the source shows
 * up as.
 */
async function readUnreviewed(db: D1Database, versionId: string): Promise<{
  networks: number[],
  markets:  string[],
}> {
  const [ networks, markets ] = await db.batch([
    db.prepare(
      `SELECT chain_id FROM registry_networks
       WHERE registry_version_id = ?1 AND reviewed = 0 ORDER BY chain_id`
    ).bind(versionId),
    db.prepare(
      `SELECT network.chain_id, market.deployment_key
       FROM markets AS market
       JOIN registry_networks AS network ON network.id = market.network_id
       WHERE market.registry_version_id = ?1 AND market.reviewed = 0
       ORDER BY network.chain_id, market.deployment_key`
    ).bind(versionId),
  ]);
  return {
    networks: ((networks!.results ?? []) as Array<{ chain_id: number }>).map(row => row.chain_id),
    markets:  ((markets!.results ?? []) as Array<{ chain_id: number, deployment_key: string }>)
      .map(row => `${row.chain_id}/${row.deployment_key}`),
  };
}

/*
 * Appends the results of one validation attempt. Results are append-only, so
 * a repeated attempt number for the same check is a programming error rather
 * than an update.
 */
async function recordValidationResults(
  db: D1Database,
  versionId: string,
  attempt: number,
  results: Array<Pick<ValidationResultRow, 'check_name' | 'scope' | 'passed'> & { details?: unknown }>,
): Promise<void> {
  const createdAt = new Date().toISOString();
  await runInChunks(db, results.map(result => insertStatement(db, 'validation_results', {
    registry_version_id: versionId,
    validation_attempt:  attempt,
    check_name:          result.check_name,
    scope:               result.scope,
    passed:              result.passed,
    details:             JSON.stringify(result.details ?? {}),
    created_at:          createdAt,
  })));
}

async function latestValidationAttempt(db: D1Database, versionId: string): Promise<number> {
  const attempt = await db.prepare(
    `SELECT max(validation_attempt) AS attempt FROM validation_results WHERE registry_version_id = ?1`
  ).bind(versionId).first<number | null>('attempt');
  return attempt ?? 0;
}

/*
 * Moves a candidate to a terminal status. The transition triggers verify the
 * stored validation results, so a mismatch fails here rather than producing a
 * version that claims to be validated.
 */
async function markValidated(db: D1Database, versionId: string, checksum: string): Promise<void> {
  const result = await db.prepare(
    `UPDATE registry_versions
     SET status = 'validated', snapshot_checksum = ?1, validated_at = ?2
     WHERE id = ?3 AND status = 'importing'`
  ).bind(checksum, new Date().toISOString(), versionId).run();
  assertChanged(result, versionId, `the candidate is no longer importing`);
}

async function markInvalid(db: D1Database, versionId: string): Promise<void> {
  const result = await db.prepare(
    `UPDATE registry_versions SET status = 'invalid' WHERE id = ?1 AND status = 'importing'`
  ).bind(versionId).run();
  assertChanged(result, versionId, `the candidate is no longer importing`);
}

/*
 * Rows a statement changed. D1 reports it in `meta.changes`, which the
 * workers-types version this worker resolves does not declare.
 */
// how many rows a statement changed; workers-types does not type `meta.changes` on every version
function changedRows(result: D1Result): number {
  return (result as unknown as { meta?: { changes?: number } }).meta?.changes ?? 0;
}

function assertChanged(result: D1Result, versionId: string, message: string): void {
  const changes = changedRows(result);
  if (changes !== 1) {
    throw new RegistryError('CANDIDATE_STATE_CONFLICT', message, versionId);
  }
}

export type { CandidateInput, ClonedOverlays, SnapshotCounts };

export {
  readAttemptChecks,
  changedRows,
  BATCH_SIZE,
  activateVersion,
  clearCandidateSnapshot,
  createCandidate,
  ensureNetwork,
  findAttempts,
  findAttemptsByCommit,
  readSnapshot,
  readUnreviewed,
  writeMarket,
  latestValidationAttempt,
  readActivationHistory,
  readActiveOverlays,
  readActiveSnapshot,
  readActiveVersionId,
  readImportOverlays,
  readOverlays,
  readRegistrySnapshot,
  readValidationSummary,
  readVersion,
  markInvalid,
  markValidated,
  recordValidationResults,
  snapshotChecksum,
  writeCandidateSnapshot,
};
