import {
  Address,
  NetworkV1,
  PriceFeedV1,
} from '../../lib/model/comet-registry.js';

import {
  RpcTransport,
  enrichMarket,
  readFeeds,
} from './enrichment.js';
import { RegistryError, isRegistryError } from './errors.js';
import {
  MarketOverlay,
  NetworkOverlay,
  applyMarketOverlay,
  applyNetworkOverlay,
  networkOverlayFeedAddresses,
  orderNetworks,
  overlayFeedAddresses,
} from './overlay.js';
import {
  createCandidate,
  ensureNetwork,
  findAttemptsByCommit,
  latestValidationAttempt,
  markInvalid,
  markValidated,
  readActiveOverlays,
  readSnapshot,
  recordValidationResults,
  snapshotChecksum,
  writeMarket,
} from './repository.js';
import {
  Clock,
  Fence,
  acquireRun,
  claimItem,
  completeItem,
  dueForDiscovery,
  failItem,
  finishRun,
  pendingItems,
  recordUpstreamCheck,
  releaseLease,
  startRun,
} from './sync.js';
import {
  SourceConfig,
  assertReachableFromRef,
  listRootPaths,
  readRoot,
  resolveRef,
} from './source/github.js';
import { sourceChecksum } from './source/roots.js';
import { CheckResult, failures, hasFailures, validateCandidate, validateMarketImport } from './validation.js';

/*
 * One registry import, driven by the Cron trigger a few markets at a time.
 *
 * An invocation never assumes it can finish: it claims a root, commits that
 * market, and leaves the rest for the next invocation. Everything it needs to
 * resume lives in D1, so a deploy or a timeout costs at most the market in
 * flight. The last invocation, the one that finds no roots left, assembles
 * the candidate, validates it, and records the result.
 */
type ImporterDeps = {
  db:     D1Database,
  source: SourceConfig,
  // one transport per network, so each chain is read through its own endpoint
  transportFor: (network: string) => RpcTransport,
  config: {
    leaseSeconds:             number,
    marketsPerInvocation:     number,
    upstreamIntervalSeconds:  number,
  },
  actor: string,
  now?:  Clock,
};

type InvocationResult = {
  status:  'idle' | 'running' | 'completed' | 'failed',
  runId?:  string,
  versionId?: string,
  outcome?: 'imported' | 'no_change',
  processed: number,
  reason?: string,
};

type ManualRequest = {
  sourceCommitSha?: string,
  forceNewAttempt?: boolean,
  reason?:          string,
  requestedBy?:     string,
};

function now(clock: Clock | undefined): Date {
  return (clock ?? (() => new Date()))();
}

/*
 * Starts an import if upstream has something this registry has not imported.
 * Discovery is bounded by its own interval: the Cron fires hourly to continue
 * work, but only asks GitHub for a new commit once a day.
 */
async function startImport(
  deps: ImporterDeps,
  request: ManualRequest = {},
): Promise<{ result: InvocationResult, fence: Fence | null }> {
  const { db, source, config } = deps;
  const manual = request.sourceCommitSha !== undefined || request.forceNewAttempt === true;

  if (!manual && !(await dueForDiscovery(db, { intervalSeconds: config.upstreamIntervalSeconds, now: deps.now }))) {
    return { result: { status: 'idle', processed: 0, reason: 'upstream was checked recently' }, fence: null };
  }

  const commitSha = request.sourceCommitSha ?? await resolveRef(source);
  if (request.sourceCommitSha !== undefined) {
    // an explicitly requested commit must belong to the tracked ref
    await assertReachableFromRef(source, commitSha);
  }

  const attempts = await findAttemptsByCommit(db, source.repository, commitSha);
  const imported = attempts.find(attempt => attempt.status === 'validated');
  if (imported !== undefined && request.forceNewAttempt !== true) {
    // upstream answered and has nothing new, so the interval starts here
    await recordUpstreamCheck(db, { now: deps.now });
    return {
      result: {
        status: 'completed', outcome: 'no_change', versionId: imported.id,
        processed: 0, reason: 'the commit is already imported',
      },
      fence: null,
    };
  }

  const roots = await listRootPaths(source, commitSha);
  const fence = await startRun(db, {
    sourceCommitSha: commitSha,
    trackedRef:      request.sourceCommitSha === undefined ? source.ref : null,
    triggerKind:     manual ? 'manual' : 'scheduled',
    requestedBy:     request.requestedBy ?? deps.actor,
    reason:          request.reason ?? null,
    roots,
  }, { leaseSeconds: config.leaseSeconds, now: deps.now });

  /*
   * The discovery interval is consumed only once a run exists: a transient
   * GitHub failure between here and there must not silence discovery for the
   * rest of the interval.
   */
  await recordUpstreamCheck(db, { now: deps.now });

  /*
   * The run is created with its lease already held, so the fence travels back
   * to the caller: re-acquiring it would correctly be refused by the very
   * lease this invocation owns.
   */
  return { result: { status: 'running', runId: fence.runId, processed: 0 }, fence };
}

/*
 * Imports one market: read its root at the pinned commit, read the chain, and
 * combine both with the reviewed overlay inherited from the active version.
 */
async function importMarket(
  deps: ImporterDeps,
  versionId: string,
  rootPath: { rootPath: string, upstreamNetworkKey: string, deploymentKey: string, sourceBlobSha: string },
  commitSha: string,
  overlays: { networks: Map<number, NetworkOverlay>, markets: Map<string, MarketOverlay> },
  networkFeeds: Map<number, Map<Address, PriceFeedV1>> = new Map(),
): Promise<{ checksum: string, checks: CheckResult[] }> {
  const root      = await readRoot(deps.source, commitSha, rootPath);
  const transport = deps.transportFor(root.network);
  const enrichment = await enrichMarket(transport, root);

  const marketKey     = `${root.chainId}/${root.deploymentKey}`;
  const marketOverlay = overlays.markets.get(marketKey);
  if (marketOverlay === undefined) {
    throw new RegistryError(
      'OVERLAY_MISSING',
      `${marketKey} has no reviewed overlay: a new market must be reviewed before it can be imported`,
      root.rootPath,
    );
  }
  const networkOverlay = overlays.networks.get(root.chainId);
  if (networkOverlay === undefined) {
    throw new RegistryError(
      'OVERLAY_MISSING',
      `chain ${root.chainId} has no reviewed overlay`,
      root.rootPath,
    );
  }

  /*
   * A reviewed reward feed only makes sense with the reward token the chain
   * names. Rather than dropping the decision when the rewards contract
   * reports none, the import fails: the active version keeps the reviewed
   * feed, and an operator sees why the candidate did not validate.
   */
  if (marketOverlay.rewardPriceFeed !== null && enrichment.rewardToken === null) {
    throw new RegistryError(
      'OVERLAY_INVALID',
      `${marketKey} has a reviewed reward feed, but its rewards contract names no reward token`,
      root.rootPath,
    );
  }

  /*
   * The overlay names feeds without stating their scale, so their decimals
   * are read from the chain before the market is assembled. A network's remap
   * feeds are the same for every market on it, so they are read once per
   * invocation rather than once per market.
   */
  const cached = networkFeeds.get(root.chainId);
  if (cached === undefined) {
    const addresses = networkOverlayFeedAddresses(networkOverlay);
    networkFeeds.set(
      root.chainId,
      addresses.length === 0 ? new Map() : await readFeeds(transport, addresses, root.network),
    );
  }

  const marketFeedAddresses = overlayFeedAddresses(marketOverlay);
  const feeds = new Map<Address, PriceFeedV1>(networkFeeds.get(root.chainId));
  if (marketFeedAddresses.length > 0) {
    for (const [ address, feed ] of await readFeeds(transport, marketFeedAddresses, root.rootPath)) {
      feeds.set(address, feed);
    }
  }

  const market = applyMarketOverlay(root, enrichment, marketOverlay, feeds, crypto.randomUUID());
  const network = applyNetworkOverlay(
    { chainId: root.chainId, key: root.network, upstreamKey: root.upstreamNetworkKey, testnet: false },
    networkOverlay,
    [],
    feeds,
  );

  /*
   * The chain-dependent checks run here, while the chain's answers are still
   * in hand; the snapshot pass afterwards can only compare stored rows.
   */
  const checks = validateMarketImport({
    chainId:       root.chainId,
    deploymentKey: root.deploymentKey,
    market,
    enrichment,
  });
  if (hasFailures(checks)) {
    const failed = failures(checks).map(result => result.check_name).join(', ');
    throw new RegistryError('CHAIN_CONTRACT_MISSING', `${marketKey} failed ${failed}`, root.rootPath);
  }

  const networkId = await ensureNetwork(deps.db, versionId, network);
  await writeMarket(deps.db, versionId, networkId, market);

  return { checksum: root.checksum, checks };
}

/*
 * Assembles what the run imported, validates it, and gives the candidate its
 * terminal status. Validation is fail-closed: a candidate that does not pass
 * completely becomes invalid and keeps its diagnostics.
 */
async function finishCandidate(
  deps: ImporterDeps,
  fence: Fence,
  versionId: string,
  importChecks: CheckResult[],
): Promise<InvocationResult> {
  const networks: NetworkV1[] = orderNetworks(await readSnapshot(deps.db, versionId));

  /*
   * A root that exhausted its retries is no longer outstanding work, but the
   * market it describes is still missing, so the run's own counts decide
   * whether the candidate is complete.
   */
  const counts = await deps.db.prepare(
    `SELECT expected_count,
            (SELECT COUNT(*) FROM sync_run_items WHERE sync_run_id = ?1 AND status = 'completed') AS imported
     FROM sync_runs WHERE id = ?1`
  ).bind(fence.runId).first<{ expected_count: number, imported: number }>();

  const results = [
    ...importChecks,
    ...validateCandidate({
      networks,
      roots: { expected: counts?.expected_count ?? 0, imported: counts?.imported ?? 0 },
    }),
  ];

  /*
   * Results are append-only and unique per attempt, so a retried finish must
   * write a new attempt rather than collide with the one before it and wedge
   * the run.
   */
  const attempt = await latestValidationAttempt(deps.db, versionId) + 1;
  await recordValidationResults(deps.db, versionId, attempt, results);

  if (hasFailures(results)) {
    await markInvalid(deps.db, versionId);
    const closed = await finishRun(
      deps.db,
      fence,
      { status: 'failed', registryVersionId: versionId, error: 'validation failed' },
      { now: deps.now },
    );
    return {
      status: 'failed', runId: fence.runId, versionId, processed: 0,
      reason: closed ? 'validation failed' : 'validation failed, and the lease was taken over before the run closed',
    };
  }

  await markValidated(deps.db, versionId, await snapshotChecksum(networks));
  /*
   * Closing the run is the last step, and it names the fence: an invocation
   * that lost the lease says so rather than reporting a run it did not close.
   */
  const closed = await finishRun(
    deps.db,
    fence,
    { status: 'completed', outcome: 'imported', registryVersionId: versionId },
    { now: deps.now },
  );
  return {
    status: 'completed', outcome: 'imported', runId: fence.runId, versionId, processed: 0,
    ...(closed ? {} : { reason: 'the lease was taken over before the run closed' }),
  };
}

/*
 * One Cron invocation: continue the running import, or start one. Returns
 * what it did, which is also what the administrative status endpoint reports.
 */
async function runInvocation(deps: ImporterDeps, request: ManualRequest = {}): Promise<InvocationResult> {
  const { db, config } = deps;

  let fence = await acquireRun(db, { leaseSeconds: config.leaseSeconds, now: deps.now });
  if (fence === null) {
    const started = await startImport(deps, request);
    if (started.fence === null) {
      return started.result;
    }
    fence = started.fence;
  }

  const run = await db.prepare(`SELECT * FROM sync_runs WHERE id = ?1`).bind(fence.runId).first<{
    source_commit_sha: string, registry_version_id: string | null, tracked_ref: string | null,
  }>();
  if (run === null || run === undefined) {
    return { status: 'idle', processed: 0, reason: 'the run disappeared' };
  }

  /*
   * The candidate is created by the first invocation of a run and reused by
   * the ones that continue it, so markets accumulate in one version.
   */
  let versionId = run.registry_version_id;
  if (versionId === null) {
    const attempts    = await findAttemptsByCommit(db, deps.source.repository, run.source_commit_sha);
    const checkpoints = await db.prepare(
      `SELECT root_path, source_blob_sha FROM sync_run_items WHERE sync_run_id = ?1`
    ).bind(fence.runId).all<{ root_path: string, source_blob_sha: string }>();
    const version = await createCandidate(db, {
      repository: deps.source.repository,
      commitSha:  run.source_commit_sha,
      /*
       * The checkpoints carry the git object id of every roots.json, so the
       * candidate can name its exact source before a single root has been
       * read, and a rerun of the same commit produces the same identity.
       */
      sourceChecksum: await sourceChecksum((checkpoints.results ?? []).map(item => ({
        rootPath:      item.root_path,
        sourceBlobSha: item.source_blob_sha,
      }))),
      attempt:   attempts.length + 1,
      createdBy: deps.actor,
      createdAt: now(deps.now).toISOString(),
    });
    versionId = version.id;
    await db.prepare(`UPDATE sync_runs SET registry_version_id = ?1 WHERE id = ?2`)
      .bind(versionId, fence.runId).run();
  }

  const overlays     = await readActiveOverlays(db);
  const networkFeeds = new Map<number, Map<Address, PriceFeedV1>>();
  const importChecks: CheckResult[] = [];
  let processed = 0;

  while (processed < config.marketsPerInvocation) {
    const item = await claimItem(db, fence, { now: deps.now });
    if (item === null) {
      break;
    }
    let committed: boolean;
    try {
      const imported = await importMarket(deps, versionId, {
        rootPath:           item.root_path,
        upstreamNetworkKey: item.upstream_network_key,
        deploymentKey:      item.deployment_key,
        sourceBlobSha:      item.source_blob_sha,
      }, run.source_commit_sha, overlays, networkFeeds);
      importChecks.push(...imported.checks);
      committed = await completeItem(db, fence, { id: item.id, checksum: imported.checksum }, { now: deps.now });
    } catch (error) {
      // diagnostics are sanitized: an upstream body or a token never reaches D1
      const message = isRegistryError(error) ? `${error.code}: ${error.message}` : 'an unexpected error interrupted the import';
      committed = await failItem(db, fence, { id: item.id, error: message }, { now: deps.now });
    }
    /*
     * A checkpoint that does not commit means the lease was taken over while
     * this market was being imported. The invocation that replaced us is
     * already redoing this work, so stopping here is what keeps two
     * invocations out of one candidate.
     */
    if (!committed) {
      return { status: 'running', runId: fence.runId, versionId, processed, reason: 'the lease was taken over' };
    }
    processed++;
  }

  if (await pendingItems(db, fence.runId) > 0) {
    // more roots remain: release the fence so the next invocation continues
    await releaseLease(db, fence);
    return { status: 'running', runId: fence.runId, versionId, processed };
  }

  const finished = await finishCandidate(deps, fence, versionId, importChecks);
  return { ...finished, processed };
}

export type { ImporterDeps, InvocationResult, ManualRequest };

export {
  importMarket,
  runInvocation,
};
