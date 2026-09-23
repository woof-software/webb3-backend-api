import {
  Address,
  NetworkV1,
  PriceFeedV1,
  ValidationSummaryV1,
  VersionStatus,
} from '../../lib/model/comet-registry.js';

import { ApiError } from '../http/errors.js';

import {
  networkOverlayFeedAddresses,
  orderNetworks,
  overlayDigest,
  overlayFeedAddresses,
  parseMarketOverlay,
  parseNetworkOverlay,
} from './overlay.js';
import type { MarketOverlay, NetworkOverlay } from './overlay.js';
import {
  latestValidationAttempt,
  markInvalid,
  markValidated,
  readOverlays,
  readAttemptChecks,
  readSnapshot,
  readUnreviewed,
  readValidationSummary,
  readVersion,
  recordValidationResults,
  snapshotChecksum,
} from './repository.js';
import { IMPORT_CHECKS, hasFailures, validateCandidate } from './validation.js';

/*
 * The administrative command behind `POST /versions/{id}/validate`.
 *
 * Validation is a decision about a stored candidate, so it reads the rows
 * back rather than trusting whatever the importer held in memory, and it is
 * fail-closed: a candidate that does not pass completely becomes invalid and
 * keeps the diagnostics that explain why.
 */
type ValidationOutcome = {
  version: { id: string, status: VersionStatus, checksum: string | null },
  changed: boolean,
  summary: ValidationSummaryV1,
};

async function validateStoredVersion(db: D1Database, versionId: string): Promise<ValidationOutcome> {
  const version = await readVersion(db, versionId);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }

  /*
   * Revalidating a validated version is the same answer again: its checks
   * are already recorded, and its snapshot can no longer change.
   */
  if (version.status === 'validated') {
    return {
      version: { id: version.id, status: version.status, checksum: version.snapshot_checksum },
      changed: false,
      summary: await readValidationSummary(db, versionId),
    };
  }
  if (version.status === 'invalid') {
    throw new ApiError('CONFLICT', `an invalid registry version cannot be validated`);
  }

  const networks: NetworkV1[] = orderNetworks(await readSnapshot(db, versionId));

  /*
   * If a sync run produced this candidate, its checkpoints say how many roots
   * the source had, which is what makes an incomplete import visible.
   */
  const run = await db.prepare(
    `SELECT status, expected_count,
            (SELECT COUNT(*) FROM sync_run_items WHERE sync_run_id = sync_runs.id AND status = 'completed') AS imported
     FROM sync_runs WHERE registry_version_id = ?1
     ORDER BY started_at DESC LIMIT 1`
  ).bind(versionId).first<{ status: string, expected_count: number, imported: number }>();

  /*
   * A candidate whose import is still running is missing markets it will
   * have in a minute. Validating it now would find them missing and freeze it
   * as invalid, so the answer is to wait rather than to fail.
   */
  if (run?.status === 'running') {
    throw new ApiError('CONFLICT', `the import of this registry version is still running`);
  }

  const previous = await latestValidationAttempt(db, versionId);
  /*
   * What the chain said about a market can only be checked while it is being
   * imported; afterwards the rows would be compared with themselves. Those
   * checks are carried forward from the attempt that ran them, because the
   * schema reads the latest attempt alone to decide whether a version may be
   * validated, and an attempt without them would hide a disagreement the
   * import found.
   */
  const carried = previous === 0
    ? []
    : (await readAttemptChecks(db, versionId, previous))
        .filter(result => (IMPORT_CHECKS as readonly string[]).includes(result.check_name));

  const results = [
    ...carried,
    ...validateCandidate({
      networks,
      ...(run === null || run === undefined
        ? {}
        : { roots: { expected: run.expected_count, imported: run.imported } }),
    }),
  ];

  await recordValidationResults(db, versionId, previous + 1, results);

  if (hasFailures(results)) {
    await markInvalid(db, versionId);
    return {
      version: { id: version.id, status: 'invalid', checksum: null },
      changed: true,
      summary: await readValidationSummary(db, versionId),
    };
  }

  const checksum = await snapshotChecksum(networks);
  await markValidated(db, versionId, checksum);
  return {
    version: { id: version.id, status: 'validated', checksum },
    changed: true,
    summary: await readValidationSummary(db, versionId),
  };
}

export type { ValidationOutcome };
export { validateStoredVersion };

/*
 * Complete overlay replacement.
 *
 * An overlay is a decision, so a replacement states all of it: the DTO is
 * validated with exact keys, and what is not said is not kept. Only an
 * importing candidate is writable, and an identical replacement is an
 * idempotent no-op that writes no audit event.
 *
 * The overlay names feeds without their scale, so decimals for any feed it
 * introduces are read from the chain here, exactly as the importer does.
 */
type FeedReader = (network: string, addresses: Address[]) => Promise<Map<Address, PriceFeedV1>>;

type OverlayResult = {
  versionId:        string,
  changed:          boolean,
  overlayEventId:   string | null,
  snapshotChecksum: string | null,
};

type OverlayScope = { versionId: string, actor: string, reason: string };

/*
 * Feed decimals this version already recorded for one network. An overlay
 * that keeps a feed it already named needs no chain read at all, so replacing
 * a label does not depend on a node provider answering.
 *
 * The network is part of the question, not a detail: the same address is a
 * different contract on a different chain, and deterministic deployments make
 * that ordinary. A version-wide lookup would hand one chain's scale to
 * another chain's feed, and every price read through it would be off by a
 * power of ten with nothing to show for it.
 */
async function storedFeeds(db: D1Database, versionId: string, networkId: string): Promise<Map<Address, PriceFeedV1>> {
  const { results } = await db.prepare(
    `SELECT price_feed_address AS address, price_feed_decimals AS decimals
     FROM market_assets
     WHERE registry_version_id = ?1 AND network_id = ?2 AND price_feed_address IS NOT NULL
     UNION
     SELECT usd_price_feed_address, usd_price_feed_decimals
     FROM market_assets
     WHERE registry_version_id = ?1 AND network_id = ?2 AND usd_price_feed_address IS NOT NULL
     UNION
     SELECT replacement_price_feed_address, replacement_price_feed_decimals
     FROM network_price_exceptions
     WHERE registry_version_id = ?1 AND network_id = ?2 AND replacement_price_feed_address IS NOT NULL`
  ).bind(versionId, networkId).all<{ address: Address, decimals: number }>();

  return new Map((results ?? []).map(feed => [ feed.address, { address: feed.address, decimals: feed.decimals } ]));
}

/*
 * The decimals of every feed the overlay names: taken from the version where
 * it already knows them, and read from the chain only for feeds it does not.
 */
async function resolveFeeds(
  db: D1Database,
  versionId: string,
  network: { id: string, canonicalName: string },
  addresses: Address[],
  readFeeds: FeedReader,
): Promise<Map<Address, PriceFeedV1>> {
  const known   = await storedFeeds(db, versionId, network.id);
  const missing = addresses.filter(address => !known.has(address));
  if (missing.length === 0) {
    return known;
  }
  for (const [ address, feed ] of await readFeeds(network.canonicalName, missing)) {
    known.set(address, feed);
  }
  return known;
}

async function importingVersion(db: D1Database, versionId: string) {
  const version = await readVersion(db, versionId);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }
  if (version.status !== 'importing') {
    throw new ApiError('CONFLICT', `a ${version.status} registry version cannot be changed`);
  }
  return version;
}

function overlayEventStatement(db: D1Database, event: {
  id:             string,
  versionId:      string,
  scopeType:      'network' | 'market',
  scopeKey:       string,
  previousDigest: string | null,
  newDigest:      string,
  actor:          string,
  reason:         string,
}): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO registry_overlay_events (
       id, registry_version_id, scope_type, scope_key, previous_digest, new_digest, actor, reason, created_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  ).bind(
    event.id, event.versionId, event.scopeType, event.scopeKey,
    event.previousDigest, event.newDigest, event.actor, event.reason,
    new Date().toISOString(),
  );
}

/*
 * A changed overlay invalidates the snapshot checksum: the stored snapshot no
 * longer hashes to it, and validation recomputes it.
 */
function clearChecksumStatement(db: D1Database, versionId: string): D1PreparedStatement {
  return db.prepare(`UPDATE registry_versions SET snapshot_checksum = NULL WHERE id = ?1 AND status = 'importing'`)
    .bind(versionId);
}

type NetworkRow = { id: string, canonical_name: string };

type MarketRow = {
  market_id:      string,
  network_id:     string,
  canonical_name: string,
  reward_id:      number | null,
};

/*
 * The statements that write one reviewed network overlay onto the rows the
 * import wrote. They are built apart from running them so that one document
 * and a whole directory are written by the same code.
 */
function networkStatements(
  db: D1Database,
  scope: OverlayScope & { chainId: number, eventId: string, previous: string | null, digest: string },
  row: NetworkRow,
  overlay: NetworkOverlay,
  feeds: Map<Address, PriceFeedV1>,
): D1PreparedStatement[] {
  return [
    // reviewing a network is what makes its row a decision someone made
    db.prepare(`UPDATE registry_networks SET display_name = ?1, metadata = ?2, reviewed = 1 WHERE id = ?3`).bind(
      overlay.displayName,
      JSON.stringify({
        assetDisplayOverrides:     overlay.assetDisplayOverrides,
        unwrappedCollateralAssets: overlay.unwrappedCollateralAssets,
      }),
      row.id,
    ),
    db.prepare(`DELETE FROM network_price_exceptions WHERE registry_version_id = ?1 AND network_id = ?2`)
      .bind(scope.versionId, row.id),
    ...overlay.priceExceptions.map(exception => db.prepare(
      `INSERT INTO network_price_exceptions (
         registry_version_id, network_id, price_feed_address, kind,
         fixed_price_value, fixed_price_decimals,
         replacement_price_feed_address, replacement_price_feed_decimals,
         provenance, expires_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`
    ).bind(
      scope.versionId, row.id, exception.priceFeedAddress, exception.kind,
      exception.kind === 'fixed_price' ? exception.price.value : null,
      exception.kind === 'fixed_price' ? exception.price.decimals : null,
      exception.kind === 'deprecated_price_remap' ? exception.replacementPriceFeed.address : null,
      exception.kind === 'deprecated_price_remap'
        ? feedDecimals(feeds, exception.replacementPriceFeed.address, row.canonical_name)
        : null,
      exception.provenance, exception.expiresAt,
    )),
    overlayEventStatement(db, {
      id:             scope.eventId,
      versionId:      scope.versionId,
      scopeType:      'network',
      scopeKey:       String(scope.chainId),
      previousDigest: scope.previous,
      newDigest:      scope.digest,
      actor:          scope.actor,
      reason:         scope.reason,
    }),
  ];
}

// the same for one market overlay
function marketStatements(
  db: D1Database,
  scope: OverlayScope & { key: string, eventId: string, previous: string | null, digest: string },
  row: MarketRow,
  overlay: MarketOverlay,
  feeds: Map<Address, PriceFeedV1>,
): D1PreparedStatement[] {
  const statements = [
    db.prepare(
      /*
       * `reviewed` is set in the same statement that may enable the market:
       * the schema refuses an unreviewed market that is served, and a
       * review is exactly what makes serving it a decision.
       */
      `UPDATE markets
       SET display_name = ?1, contract_name = ?2, is_default = ?3, status = ?4, creation_block = ?5,
           collateral_value_quote = ?6, rewards_enabled = ?7, account_rewards_enabled = ?8,
           transaction_history_enabled = ?9, slug = ?10, is_institutional = ?11, reviewed = 1
       WHERE id = ?12`
    ).bind(
      overlay.displayName, overlay.contractName, overlay.isDefault ? 1 : 0, overlay.status,
      overlay.creationBlock, overlay.collateralValueQuote,
      overlay.capabilities.rewards ? 1 : 0,
      overlay.capabilities.accountRewards ? 1 : 0,
      overlay.capabilities.transactionHistory ? 1 : 0,
      overlay.slug, overlay.isInstitutional ? 1 : 0,
      row.market_id,
    ),
    db.prepare(
      `UPDATE market_assets
       SET display_name = ?1, is_wrapped_native = ?2, usd_price_feed_address = ?3, usd_price_feed_decimals = ?4
       WHERE market_id = ?5 AND role = 'base'`
    ).bind(
      overlay.baseAsset.displayName,
      overlay.baseAsset.isWrappedNative ? 1 : 0,
      overlay.baseAsset.usdPriceFeedAddress,
      overlay.baseAsset.usdPriceFeedAddress === null
        ? null
        : feedDecimals(feeds, overlay.baseAsset.usdPriceFeedAddress, row.canonical_name),
      row.market_id,
    ),
  ];

  if (row.reward_id !== null) {
    statements.push(db.prepare(
      `UPDATE market_assets
       SET price_feed_address = ?1, price_feed_decimals = ?2, price_feed_quote = ?3
       WHERE market_id = ?4 AND role = 'reward'`
    ).bind(
      overlay.rewardPriceFeed?.address ?? null,
      overlay.rewardPriceFeed === null
        ? null
        : feedDecimals(feeds, overlay.rewardPriceFeed.address, row.canonical_name),
      overlay.rewardPriceFeed?.quote ?? null,
      row.market_id,
    ));
  }

  statements.push(overlayEventStatement(db, {
    id:             scope.eventId,
    versionId:      scope.versionId,
    scopeType:      'market',
    scopeKey:       scope.key,
    previousDigest: scope.previous,
    newDigest:      scope.digest,
    actor:          scope.actor,
    reason:         scope.reason,
  }));
  return statements;
}

function refuseRewardFeedWithoutReward(key: string, row: MarketRow, overlay: MarketOverlay): void {
  if (overlay.rewardPriceFeed !== null && row.reward_id === null) {
    throw new ApiError(
      'CONFLICT',
      `${key} has no reward asset on chain, so it cannot carry a reward price feed`,
    );
  }
}

/*
 * The schema allows one default market per version and one market per slug
 * and network. Both surface as unique constraint failures, told apart by the
 * columns SQLite names.
 */
async function writeReview(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  try {
    await db.batch(statements);
  } catch (error) {
    const message = String(error);
    if (message.includes('UNIQUE constraint failed') && message.includes('markets.slug')) {
      throw new ApiError('CONFLICT', `another market of this network already has that slug`);
    }
    if (message.includes('UNIQUE constraint failed: markets.registry_version_id')) {
      throw new ApiError('CONFLICT', `another market of this version is already the default`);
    }
    throw error;
  }
}

/*
 * Every network, and every market with its reward asset, that the import has
 * written into a version. The routes address them by chain id and deployment
 * key; these are the rows those names resolve to.
 */
async function networkRows(db: D1Database, versionId: string): Promise<Map<number, NetworkRow>> {
  const { results } = await db.prepare(
    `SELECT id, chain_id, canonical_name FROM registry_networks WHERE registry_version_id = ?1`
  ).bind(versionId).all<NetworkRow & { chain_id: number }>();
  return new Map((results ?? []).map(row => [ row.chain_id, { id: row.id, canonical_name: row.canonical_name } ]));
}

async function marketRows(db: D1Database, versionId: string): Promise<Map<string, MarketRow>> {
  const { results } = await db.prepare(
    `SELECT market.id AS market_id, market.network_id, network.canonical_name,
            network.chain_id || '/' || market.deployment_key AS market_key,
            (SELECT asset.id FROM market_assets AS asset
             WHERE asset.market_id = market.id AND asset.role = 'reward') AS reward_id
     FROM markets AS market
     JOIN registry_networks AS network ON network.id = market.network_id
     WHERE market.registry_version_id = ?1`
  ).bind(versionId).all<MarketRow & { market_key: string }>();
  return new Map((results ?? []).map(row => [ row.market_key, {
    market_id:      row.market_id,
    network_id:     row.network_id,
    canonical_name: row.canonical_name,
    reward_id:      row.reward_id ?? null,
  } ]));
}

async function replaceNetworkOverlay(
  db: D1Database,
  input: OverlayScope & { chainId: number, overlay: unknown },
  readFeeds: FeedReader,
): Promise<OverlayResult> {
  const version = await importingVersion(db, input.versionId);
  const overlay = parseNetworkOverlay(input.overlay);

  /*
   * An import writes every network it reaches, reviewed or not, so a network
   * missing here is one this candidate has not reached yet: the answer is to
   * let the import continue, not to record the decision somewhere else.
   */
  const row = (await networkRows(db, input.versionId)).get(input.chainId);
  if (row === undefined) {
    throw new ApiError('NOT_FOUND', `chain ${input.chainId} has not been imported into this registry version yet`);
  }

  const current  = (await readOverlays(db, input.versionId)).networks.get(input.chainId);
  const previous = current === undefined ? null : await overlayDigest(current);
  const digest   = await overlayDigest(overlay);
  if (previous === digest) {
    return {
      versionId:        input.versionId,
      changed:          false,
      overlayEventId:   null,
      snapshotChecksum: version.snapshot_checksum,
    };
  }

  // a remap must name a feed that answers, and its scale comes from the chain
  const feeds = await resolveFeeds(
    db,
    input.versionId,
    { id: row.id, canonicalName: row.canonical_name },
    networkOverlayFeedAddresses(overlay),
    readFeeds,
  );

  const eventId = crypto.randomUUID();
  await writeReview(db, [
    ...networkStatements(db, { ...input, eventId, previous, digest }, row, overlay, feeds),
    clearChecksumStatement(db, input.versionId),
  ]);

  return { versionId: input.versionId, changed: true, overlayEventId: eventId, snapshotChecksum: null };
}

function feedDecimals(feeds: Map<Address, PriceFeedV1>, address: Address, scope: string): number {
  const feed = feeds.get(address);
  if (feed === undefined) {
    throw new ApiError('UNPROCESSABLE', `the decimals of ${address} could not be read on ${scope}`);
  }
  return feed.decimals;
}

async function replaceMarketOverlay(
  db: D1Database,
  input: OverlayScope & { chainId: number, deploymentKey: string, overlay: unknown },
  readFeeds: FeedReader,
): Promise<OverlayResult> {
  const version = await importingVersion(db, input.versionId);
  const overlay = parseMarketOverlay(input.overlay);
  const key     = `${input.chainId}/${input.deploymentKey}`;

  // an import writes every market it reaches, reviewed or not
  const row = (await marketRows(db, input.versionId)).get(key);
  if (row === undefined) {
    throw new ApiError('NOT_FOUND', `${key} has not been imported into this registry version yet`);
  }

  const current  = (await readOverlays(db, input.versionId)).markets.get(key);
  const previous = current === undefined ? null : await overlayDigest(current);
  const digest   = await overlayDigest(overlay);
  if (previous === digest) {
    return {
      versionId:        input.versionId,
      changed:          false,
      overlayEventId:   null,
      snapshotChecksum: version.snapshot_checksum,
    };
  }

  refuseRewardFeedWithoutReward(key, row, overlay);
  const feeds = await resolveFeeds(
    db,
    input.versionId,
    { id: row.network_id, canonicalName: row.canonical_name },
    overlayFeedAddresses(overlay),
    readFeeds,
  );

  const eventId = crypto.randomUUID();
  await writeReview(db, [
    ...marketStatements(db, { ...input, key, eventId, previous, digest }, row, overlay, feeds),
    clearChecksumStatement(db, input.versionId),
  ]);

  return { versionId: input.versionId, changed: true, overlayEventId: eventId, snapshotChecksum: null };
}

/*
 * A whole reviewed directory in one request: the way a new environment is
 * reviewed, where every network and market the first import wrote needs its
 * decisions at once.
 *
 * Nothing is written unless everything can be. Every document is parsed, every
 * row it names is found, and every feed it introduces is read before the first
 * statement runs, and the writes go to D1 as one batch, which is one
 * transaction: a directory is either applied or not, never half. What each
 * document changes is decided exactly as the one-document routes decide it,
 * and a document identical to what is stored writes nothing.
 */
type OverlayDocuments = OverlayScope & {
  networks: Array<{ chainId: number, overlay: unknown }>,
  markets:  Array<{ chainId: number, deploymentKey: string, overlay: unknown }>,
};

type OverlaysResult = {
  versionId:        string,
  changed:          boolean,
  documents:        Array<{ scopeType: 'network' | 'market', scopeKey: string, changed: boolean, overlayEventId: string | null }>,
  snapshotChecksum: string | null,
  unreviewed:       { networks: number[], markets: string[] },
};

async function replaceOverlays(
  db: D1Database,
  input: OverlayDocuments,
  readFeeds: FeedReader,
): Promise<OverlaysResult> {
  const version = await importingVersion(db, input.versionId);

  const networks = input.networks.map(({ chainId, overlay }) => ({
    chainId,
    overlay: parseNetworkOverlay(overlay, `networks.${chainId}`),
  }));
  const markets = input.markets.map(({ chainId, deploymentKey, overlay }) => ({
    key:     `${chainId}/${deploymentKey}`,
    overlay: parseMarketOverlay(overlay, `markets.${chainId}/${deploymentKey}`),
  }));

  const [ networkRow, marketRow ] = [ await networkRows(db, input.versionId), await marketRows(db, input.versionId) ];
  const missing = [
    ...networks.filter(({ chainId }) => !networkRow.has(chainId)).map(({ chainId }) => `chain ${chainId}`),
    ...markets.filter(({ key }) => !marketRow.has(key)).map(({ key }) => key),
  ];
  if (missing.length > 0) {
    throw new ApiError('NOT_FOUND', `${missing.join(', ')} not imported into this registry version yet`);
  }

  const stored = await readOverlays(db, input.versionId);
  const plannedNetworks = await Promise.all(networks.map(async ({ chainId, overlay }) => {
    const current = stored.networks.get(chainId);
    return {
      chainId, overlay,
      row:      networkRow.get(chainId)!,
      previous: current === undefined ? null : await overlayDigest(current),
      digest:   await overlayDigest(overlay),
    };
  }));
  const plannedMarkets = await Promise.all(markets.map(async ({ key, overlay }) => {
    const current = stored.markets.get(key);
    return {
      key, overlay,
      row:      marketRow.get(key)!,
      previous: current === undefined ? null : await overlayDigest(current),
      digest:   await overlayDigest(overlay),
    };
  }));
  const changedNetworks = plannedNetworks.filter(entry => entry.previous !== entry.digest);
  const changedMarkets  = plannedMarkets.filter(entry => entry.previous !== entry.digest);

  for (const { key, row, overlay } of changedMarkets) {
    refuseRewardFeedWithoutReward(key, row, overlay);
  }

  /*
   * One read per network for the feeds the changed documents introduce, so a
   * directory costs a chain read per network rather than one per document.
   */
  const addresses = new Map<string, { canonicalName: string, addresses: Set<Address> }>();
  const want = (networkId: string, canonicalName: string, feeds: Address[]) => {
    const entry = addresses.get(networkId) ?? { canonicalName, addresses: new Set<Address>() };
    feeds.forEach(address => entry.addresses.add(address));
    addresses.set(networkId, entry);
  };
  changedNetworks.forEach(({ row, overlay }) => want(row.id, row.canonical_name, networkOverlayFeedAddresses(overlay)));
  changedMarkets.forEach(({ row, overlay }) => want(row.network_id, row.canonical_name, overlayFeedAddresses(overlay)));
  const feeds = new Map<string, Map<Address, PriceFeedV1>>();
  for (const [ networkId, { canonicalName, addresses: wanted } ] of addresses) {
    feeds.set(networkId, wanted.size === 0
      ? new Map()
      : await resolveFeeds(db, input.versionId, { id: networkId, canonicalName }, [ ...wanted ], readFeeds));
  }

  const events = new Map<string, string>();
  const eventFor = (key: string) => {
    const id = crypto.randomUUID();
    events.set(key, id);
    return id;
  };
  const statements = [
    ...changedNetworks.flatMap(({ chainId, row, overlay, previous, digest }) => networkStatements(
      db,
      { ...input, chainId, eventId: eventFor(`network ${chainId}`), previous, digest },
      row, overlay, feeds.get(row.id)!,
    )),
    /*
     * The schema allows one default market per version and one market per
     * slug and network after every statement, not only at the end of the
     * batch. A directory may move the default or a slug, or swap two slugs,
     * and no order of writes satisfies that for every such directory; so every
     * changed market first gives up both, and then takes what its document
     * says. A conflict left after that is one the directory itself holds.
     */
    ...changedMarkets.map(({ row }) => db.prepare(
      `UPDATE markets SET slug = NULL, is_default = 0 WHERE id = ?1`
    ).bind(row.market_id)),
    ...changedMarkets.flatMap(({ key, row, overlay, previous, digest }) => marketStatements(
      db,
      { ...input, key, eventId: eventFor(`market ${key}`), previous, digest },
      row, overlay, feeds.get(row.network_id)!,
    )),
  ];

  if (statements.length > 0) {
    await writeReview(db, [ ...statements, clearChecksumStatement(db, input.versionId) ]);
  }

  const changed = statements.length > 0;
  return {
    versionId: input.versionId,
    changed,
    documents: [
      ...plannedNetworks.map(({ chainId }) => ({
        scopeType:      'network' as const,
        scopeKey:       String(chainId),
        changed:        events.has(`network ${chainId}`),
        overlayEventId: events.get(`network ${chainId}`) ?? null,
      })),
      ...plannedMarkets.map(({ key }) => ({
        scopeType:      'market' as const,
        scopeKey:       key,
        changed:        events.has(`market ${key}`),
        overlayEventId: events.get(`market ${key}`) ?? null,
      })),
    ],
    snapshotChecksum: changed ? null : version.snapshot_checksum,
    unreviewed:       await readUnreviewed(db, input.versionId),
  };
}

export type { FeedReader, OverlayDocuments, OverlayResult, OverlaysResult };
export { replaceMarketOverlay, replaceNetworkOverlay, replaceOverlays };
