import {
  Address,
  NetworkV1,
  PriceFeedV1,
  SyncOutcome,
} from '../../lib/model/comet-registry.js';

import {
  RpcTransport,
  enrichMarket,
  readFeeds,
} from './enrichment.js';
import { RegistryError, isRegistryError, isTransportFailure } from './errors.js';
import {
  MarketOverlay,
  NetworkOverlay,
  applyMarketOverlay,
  applyNetworkOverlay,
  networkOverlayFeedAddresses,
  orderNetworks,
  overlayFeedAddresses,
  provisionalMarketOverlay,
  provisionalNetworkOverlay,
} from './overlay.js';
import {
  createCandidate,
  ensureNetwork,
  findAttemptsByCommit,
  latestValidationAttempt,
  markInvalid,
  markValidated,
  readActiveVersionId,
  readImportOverlays,
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
  MAX_ITEM_ATTEMPTS,
  pendingItems,
  recordUpstreamCheck,
  releaseLease,
  runningRun,
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
  // where the cause of a failure goes; D1 keeps only its sanitized form
  debug?: { error: (...parameters: unknown[]) => unknown },
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

/*
 * What one invocation did. `idle` means there was nothing due, which is the
 * usual answer between daily discovery windows.
 */
const INVOCATION_STATUSES = [ 'idle', 'running', 'completed', 'failed' ] as const;

type InvocationStatus = (typeof INVOCATION_STATUSES)[number];

type InvocationResult = {
  status:     InvocationStatus,
  runId?:     string,
  versionId?: string,
  outcome?:   SyncOutcome,
  processed:  number,
  reason?:    string,
  // every root is imported and the candidate is left open for review
  held?:      boolean,
  // checks that failed on a candidate that is held rather than validated
  checksFailed?: number,
  /*
   * How far the run has got, in roots: how many the commit has, how many are
   * imported, and how many are still to attempt. A caller that sees
   * `running` learns from these whether the last invocation made progress,
   * and what is left; a root that exhausted its attempts is in neither of the
   * last two.
   */
  expected?:    number,
  completed?:   number,
  outstanding?: number,
  /*
   * What stopped an invocation that failed on a registry error, so a caller
   * that answers a person can tell a request it has to refuse from a source
   * that did not answer. It never leaves the process: the reason is the
   * sanitized form of it.
   */
  error?:     RegistryError,
};

type ManualRequest = {
  sourceCommitSha?: string,
  forceNewAttempt?: boolean,
  reason?:          string,
  requestedBy?:     string,
  /*
   * Leave the candidate open once every root is imported, so a market the
   * source has added can be reviewed in place before the version validates.
   */
  holdForReview?:   boolean,
  /*
   * How many markets this invocation imports. The Cron keeps to its small
   * configured batch; an operator bringing an environment up asks for the
   * whole source in one request.
   */
  markets?:         number,
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

  /*
   * A candidate of this commit that is still importing, with no run left to
   * continue it, is one an operator is reviewing. Starting another attempt
   * over it would abandon that review, so only an explicit new attempt does.
   *
   * A candidate whose run is still there is not that: another invocation is
   * importing into it right now, and holds the lease this one could not take.
   * That falls through to startRun, where the index that allows one running
   * sync refuses it, which is what the caller has to hear.
   */
  const held    = attempts.find(attempt => attempt.status === 'importing');
  const working = held === undefined ? null : await runningRun(db);
  if (held !== undefined && request.forceNewAttempt !== true && working?.registry_version_id !== held.id) {
    await recordUpstreamCheck(db, { now: deps.now });
    return {
      result: {
        status: 'idle', versionId: held.id, processed: 0,
        reason: 'a candidate of this commit is held for review; validate it or force a new attempt',
      },
      fence: null,
    };
  }

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
    ...(request.holdForReview === true ? { holdForReview: true } : {}),
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
 *
 * A market no version has reviewed is imported all the same, with the
 * provisional overlay: disabled, every capability off, marked unreviewed. Its
 * rows are what an operator reviews in place, and until then it changes
 * nothing the API serves. Refusing it instead would fail the whole commit
 * over one deployment nobody has looked at yet.
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

  const marketKey       = `${root.chainId}/${root.deploymentKey}`;
  const reviewedMarket  = overlays.markets.get(marketKey);
  const reviewedNetwork = overlays.networks.get(root.chainId);
  const marketOverlay   = reviewedMarket ?? provisionalMarketOverlay(root.deploymentKey, enrichment.baseToken.name);
  const networkOverlay  = reviewedNetwork ?? provisionalNetworkOverlay(root.network);

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

  const networkId = await ensureNetwork(deps.db, versionId, network, reviewedNetwork !== undefined);
  await writeMarket(deps.db, versionId, networkId, market, reviewedMarket !== undefined);

  return { checksum: root.checksum, checks };
}

/*
 * Assembles what the run imported, validates it, and gives the candidate its
 * terminal status. Validation is fail-closed: a candidate that does not pass
 * completely becomes invalid and keeps its diagnostics.
 *
 * A held run validates too, so its diagnostics are there to read, but leaves
 * the candidate importing: its markets are reviewed in place, which a
 * terminal version no longer allows, and an operator validates it once they
 * are. The first import of an environment is always held. Nothing it imports
 * can have been reviewed yet, so it could only ever end invalid.
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
    `SELECT expected_count, hold_for_review,
            (SELECT COUNT(*) FROM sync_run_items WHERE sync_run_id = ?1 AND status = 'completed') AS imported
     FROM sync_runs WHERE id = ?1`
  ).bind(fence.runId).first<{ expected_count: number, hold_for_review: number, imported: number }>();

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

  const held   = counts?.hold_for_review === 1 || await readActiveVersionId(deps.db) === null;
  const failed = failures(results).length;
  if (held) {
    const closed = await finishRun(
      deps.db,
      fence,
      { status: 'completed', outcome: 'imported', registryVersionId: versionId },
      { now: deps.now },
    );
    /*
     * A held candidate is not validated: it is left open for review. Its
     * checks still ran, and a caller told only that the import completed
     * would not know that some of them failed.
     */
    return {
      status: 'completed', outcome: 'imported', runId: fence.runId, versionId, processed: 0, held: true,
      ...(failed === 0 ? {} : { checksFailed: failed }),
      reason: [
        closed
          ? 'every root is imported; the candidate is held for review'
          : 'the candidate is held for review, and the lease was taken over before the run closed',
        ...(failed === 0 ? [] : [ `${failed} of its checks failed` ]),
      ].join('; '),
    };
  }

  if (failed > 0) {
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
 * How far a run has got, in roots. One statement, so every answer can carry
 * it: a caller that is told `running` needs to know whether the invocation
 * made progress and how much is left, and deriving that from the status
 * alone is what makes a resumable import look erratic.
 */
async function progressOf(db: D1Database, runId: string): Promise<{
  expected: number, completed: number, outstanding: number,
}> {
  // `outstanding` is pendingItems' predicate, in the same statement as the run's own counters
  const counts = await db.prepare(
    `SELECT run.expected_count AS expected, run.completed_count AS completed,
            (SELECT COUNT(*) FROM sync_run_items
             WHERE sync_run_id = ?1 AND status <> 'completed' AND attempts < ?2) AS outstanding
     FROM sync_runs AS run WHERE run.id = ?1`
  ).bind(runId, MAX_ITEM_ATTEMPTS).first<{ expected: number, completed: number, outstanding: number }>();
  return counts ?? { expected: 0, completed: 0, outstanding: 0 };
}

/*
 * One Cron invocation: continue the running import, or start one. Returns
 * what it did, which is also what the administrative status endpoint reports.
 */
async function runInvocation(deps: ImporterDeps, request: ManualRequest = {}): Promise<InvocationResult> {
  const { db, config } = deps;

  /*
   * A run's commit, its attempt and whether it holds the candidate are all
   * decided when the run is created, so a request carrying any of the three
   * is asking for a new run. If one is unfinished it is refused — and
   * refused before the lease is touched: taking the lease first would abort
   * an invocation that is alive and merely overran it, losing the market it
   * was importing.
   */
  const wantsNewRun = request.sourceCommitSha !== undefined
    || request.forceNewAttempt === true
    || request.holdForReview === true;
  if (wantsNewRun) {
    const unfinished = await runningRun(db);
    if (unfinished !== null) {
      throw new RegistryError(
        'SYNC_ALREADY_RUNNING',
        `an import is in progress; continue it with an empty body, or wait for it to finish`,
        unfinished.id,
      );
    }
  }

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

  const overlays     = await readImportOverlays(db, versionId);
  const networkFeeds = new Map<number, Map<Address, PriceFeedV1>>();
  const importChecks: CheckResult[] = [];
  let processed = 0;
  // roots this invocation actually imported, which is what tells a failure apart from an interruption
  let imported  = 0;

  /*
   * At most one attempt per root in one invocation. A failed root goes back
   * into the pool, so a batch larger than what is outstanding would claim it
   * again straight away — and a chain that is briefly down would burn every
   * retry of every root inside a single request.
   */
  const batch = Math.min(request.markets ?? config.marketsPerInvocation, await pendingItems(db, fence.runId));
  // every root this invocation has claimed, so none of them is claimed twice
  const tried: string[] = [];
  while (processed < batch) {
    const item = await claimItem(db, fence, { now: deps.now, except: tried });
    if (item === null) {
      break;
    }
    tried.push(item.id);
    let committed: boolean;
    try {
      const importedRoot = await importMarket(deps, versionId, {
        rootPath:           item.root_path,
        upstreamNetworkKey: item.upstream_network_key,
        deploymentKey:      item.deployment_key,
        sourceBlobSha:      item.source_blob_sha,
      }, run.source_commit_sha, overlays, networkFeeds);
      importChecks.push(...importedRoot.checks);
      committed = await completeItem(db, fence, { id: item.id, checksum: importedRoot.checksum }, { now: deps.now });
      imported += 1;
    } catch (error) {
      // diagnostics are sanitized: an upstream body or a token never reaches D1
      const message = isRegistryError(error) ? `${error.code}: ${error.message}` : 'an unexpected error interrupted the import';
      /*
       * D1 keeps the sanitized code, because an upstream body or a token
       * must never be written where diagnostics are read. The cause itself
       * goes to the logs, where it is the only way to tell which limit or
       * which provider ended the invocation.
       */
      deps.debug?.error(`registry root failed`, { rootPath: item.root_path, error });
      /*
       * A transport failure in an invocation that has already imported
       * something is the invocation running out — of the subrequests or the
       * time a Worker is given — rather than anything about this root, so it
       * does not spend one of the root's five attempts. That is what stops a
       * large source from exhausting every root's budget in five invocations
       * and leaving a candidate that can never be completed.
       *
       * An invocation that has imported nothing gets no such benefit: a chain
       * or a provider that answers for no root at all is a failure this run
       * has to end on, or it would hold the one running slot forever and the
       * registry would stop following the source.
       */
      const interrupted = isTransportFailure(error) && imported > 0;
      committed = await failItem(db, fence, { id: item.id, error: message }, {
        now:           deps.now,
        spendsAttempt: !interrupted,
      });
    }
    /*
     * A checkpoint that does not commit means the lease was taken over while
     * this market was being imported. The invocation that replaced us is
     * already redoing this work, so stopping here is what keeps two
     * invocations out of one candidate.
     */
    if (!committed) {
      return {
        status: 'running', runId: fence.runId, versionId, processed,
        ...await progressOf(db, fence.runId),
        reason: 'the lease was taken over',
      };
    }
    processed++;
  }

  const progress = await progressOf(db, fence.runId);
  if (progress.outstanding > 0) {
    // more roots remain: release the fence so the next invocation continues
    await releaseLease(db, fence);
    return { status: 'running', runId: fence.runId, versionId, processed, ...progress };
  }

  const finished = await finishCandidate(deps, fence, versionId, importChecks);
  return { ...finished, processed, ...await progressOf(db, fence.runId) };
}

export type { ImporterDeps, InvocationResult, InvocationStatus, ManualRequest };

export {
  INVOCATION_STATUSES,
  importMarket,
  runInvocation,
};
