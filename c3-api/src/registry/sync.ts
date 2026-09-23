import {
  DeploymentPath,
  SyncItemStatus,
  SyncOutcome,
  SyncRunItemRow,
  SyncRunRow,
  SyncRunStatus,
  SyncTriggerKind,
} from '../../lib/model/comet-registry.js';

import { RegistryError } from './errors.js';
import { changedRows } from './repository.js';

/*
 * The sync fence. One registry import may run at a time, and one invocation
 * at a time may work on it: a Cron invocation can be interrupted by a deploy
 * or a timeout, so work is claimed per root and committed only by the
 * invocation that still owns the run.
 *
 * Ownership is a random owner token plus a generation counter. Taking over an
 * expired lease increments the generation in the same statement that replaces
 * the owner, so a resumed invocation cannot be raced by the one it replaced:
 * every later write names both, and a stale invocation updates zero rows and
 * stops.
 */
type Fence = {
  runId:      string,
  owner:      string,
  generation: number,
};

type Clock = () => Date;

/*
 * A checkpoint needs the git object id of its roots.json: it is what the
 * candidate's source identity is computed from and what the content is
 * verified against, so the type requires it rather than defaulting it.
 */
type RootCheckpoint = DeploymentPath & { sourceBlobSha: string };

type RunInput = {
  sourceCommitSha: string,
  trackedRef:      string | null,
  triggerKind:     SyncTriggerKind,
  requestedBy:     string | null,
  reason:          string | null,
  roots:           RootCheckpoint[],
  // leave the candidate open for review once every root is imported
  holdForReview?:  boolean,
};

/*
 * An injectable clock, so lease expiry and retry behavior can be exercised
 * without waiting for real time to pass.
 */
type ClockOption = { now?: Clock | undefined };

type LeaseOptions = ClockOption & {
  leaseSeconds: number,
};

// an item that keeps failing is left for an operator rather than retried forever
const MAX_ITEM_ATTEMPTS = 5;

function at(clock: Clock | undefined): string {
  return (clock ?? (() => new Date()))().toISOString();
}

function expiry(clock: Clock | undefined, seconds: number): string {
  const base = (clock ?? (() => new Date()))().getTime();
  return new Date(base + seconds * 1000).toISOString();
}

/*
 * Starts a new run and its per-root checkpoints in one transaction. The
 * partial unique index on a running status is what makes two concurrent
 * creators collide instead of both importing.
 */
async function startRun(db: D1Database, input: RunInput, options: LeaseOptions): Promise<Fence> {
  const runId     = crypto.randomUUID();
  const owner     = crypto.randomUUID();
  const timestamp = at(options.now);

  const statements = [
    db.prepare(
      `INSERT INTO sync_runs (
         id, source_commit_sha, tracked_ref, trigger_kind, requested_by, reason,
         status, lease_owner, lease_generation, lease_expires_at, expected_count, started_at, hold_for_review
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7, 1, ?8, ?9, ?10, ?11)`
    ).bind(
      runId, input.sourceCommitSha, input.trackedRef, input.triggerKind, input.requestedBy, input.reason,
      owner, expiry(options.now, options.leaseSeconds), input.roots.length, timestamp,
      input.holdForReview === true ? 1 : 0,
    ),
    ...input.roots.map(root => db.prepare(
      `INSERT INTO sync_run_items (
         id, sync_run_id, root_path, source_blob_sha, root_checksum,
         upstream_network_key, deployment_key, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`
    ).bind(
      crypto.randomUUID(), runId, root.rootPath, root.sourceBlobSha,
      '0'.repeat(64), root.upstreamNetworkKey, root.deploymentKey, timestamp,
    )),
  ];

  try {
    await db.batch(statements);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint failed: sync_runs.status')) {
      throw new RegistryError('SYNC_ALREADY_RUNNING', `a registry sync is already running`, input.sourceCommitSha);
    }
    throw error;
  }
  return { runId, owner, generation: 1 };
}

/*
 * Takes over the running job when nobody holds an unexpired lease on it. The
 * compare-and-set is one statement: expiring a lease and claiming it in two
 * steps would let two invocations both believe they own the run.
 */
async function acquireRun(db: D1Database, options: LeaseOptions): Promise<Fence | null> {
  const owner     = crypto.randomUUID();
  const timestamp = at(options.now);

  const claimed = await db.prepare(
    `UPDATE sync_runs
     SET lease_owner = ?1, lease_generation = lease_generation + 1, lease_expires_at = ?2
     WHERE id = (
       SELECT id FROM sync_runs
       WHERE status = 'running' AND (lease_owner IS NULL OR lease_expires_at <= ?3)
       LIMIT 1
     )
     RETURNING id, lease_generation`
  ).bind(owner, expiry(options.now, options.leaseSeconds), timestamp).first<{ id: string, lease_generation: number }>();

  return claimed === null || claimed === undefined
    ? null
    : { runId: claimed.id, owner, generation: claimed.lease_generation };
}

/*
 * Extends the lease of the invocation that still owns it. A false result
 * means the fence was taken over, and the caller must stop rather than
 * commit work the new owner is redoing.
 */
async function renewLease(db: D1Database, fence: Fence, options: LeaseOptions): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sync_runs SET lease_expires_at = ?1
     WHERE id = ?2 AND status = 'running' AND lease_owner = ?3 AND lease_generation = ?4`
  ).bind(expiry(options.now, options.leaseSeconds), fence.runId, fence.owner, fence.generation).run();
  return changedRows(result) === 1;
}

/*
 * Releases the lease without finishing the run, so the next invocation can
 * continue immediately instead of waiting for the lease to expire.
 */
async function releaseLease(db: D1Database, fence: Fence): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sync_runs SET lease_owner = NULL, lease_expires_at = NULL
     WHERE id = ?1 AND status = 'running' AND lease_owner = ?2 AND lease_generation = ?3`
  ).bind(fence.runId, fence.owner, fence.generation).run();
  return changedRows(result) === 1;
}

/*
 * Claims one root to process. A pending root is preferred, then one a lost
 * invocation left processing, then one that failed and may be retried. The
 * condition proves the caller still owns an unexpired run, so claiming and
 * the fence check cannot disagree.
 */
async function claimItem(
  db: D1Database,
  fence: Fence,
  options: ClockOption & { except?: readonly string[] } = {},
): Promise<SyncRunItemRow | null> {
  const timestamp = at(options.now);
  /*
   * `except` is what this invocation has already tried. An attempt that was
   * given back — because the invocation ran out rather than the root being
   * wrong — leaves the root looking untouched, and the ordering below would
   * then hand it straight back to the same invocation, which would spend its
   * whole batch on one root and never reach the others.
   */
  const excluded = options.except ?? [];
  const holes    = excluded.map((_, index) => `?${index + 6}`).join(', ');
  const claimed = await db.prepare(
    `UPDATE sync_run_items
     SET status = 'processing', attempts = attempts + 1, claim_owner = ?1,
         claim_generation = ?2, claimed_at = ?3, updated_at = ?3
     WHERE id = (
       SELECT item.id
       FROM sync_run_items AS item
       JOIN sync_runs AS run ON run.id = item.sync_run_id
       WHERE item.sync_run_id = ?4
         AND run.status = 'running'
         AND run.lease_owner = ?1
         AND run.lease_generation = ?2
         AND run.lease_expires_at > ?3
         AND item.attempts < ?5
         AND (
           item.status = 'pending'
           OR item.status = 'failed'
           OR (item.status = 'processing' AND item.claim_generation < ?2)
         )
         ${excluded.length === 0 ? '' : `AND item.id NOT IN (${holes})`}
       ORDER BY item.attempts, item.root_path
       LIMIT 1
     )
     RETURNING *`
  ).bind(fence.owner, fence.generation, timestamp, fence.runId, MAX_ITEM_ATTEMPTS, ...excluded)
    .first<SyncRunItemRow>();
  return claimed ?? null;
}

async function commitItem(
  db: D1Database,
  fence: Fence,
  item: { id: string, checksum?: string, error?: string },
  status: Extract<SyncItemStatus, 'completed' | 'failed'>,
  options: ClockOption & { spendsAttempt?: boolean } = {},
): Promise<boolean> {
  const timestamp = at(options.now);
  /*
   * An attempt is spent unless the caller says the failure was not about
   * this root. Claiming an item increments the counter, so giving it back is
   * a decrement here, and the root keeps the budget it never used.
   */
  const refunded = status === 'failed' && options.spendsAttempt === false;
  /*
   * Counters count roots, not attempts: a root that failed but may still be
   * retried is not yet a failed root, and counting it as one would exceed the
   * expected count the schema enforces. A refunded attempt can never be the
   * last one, so it never makes a root a failed root.
   */
  const increment = status === 'completed'
    ? `completed_count = completed_count + 1`
    : refunded
      ? `failed_count = failed_count`
      : `failed_count = failed_count + (
         SELECT CASE WHEN attempts >= ${MAX_ITEM_ATTEMPTS} THEN 1 ELSE 0 END
         FROM sync_run_items WHERE id = ?5
       )`;

  /*
   * The counter is bumped first, while the item is still processing: a batch
   * runs in order, so the reverse order would make the counter's own guard
   * contradict the update before it.
   */
  const [ runResult, itemResult ] = await db.batch([
    db.prepare(
      /*
       * `last_error` is replaced, not coalesced: a run that recovers from a
       * failed attempt must stop reporting it, or a successful import still
       * carries the diagnostic of a root that has since succeeded.
       *
       * The lease expiry is part of this guard too. Both statements of the
       * batch check the same fence, so an expired lease commits neither the
       * counter nor the checkpoint.
       */
      `UPDATE sync_runs SET ${increment}, last_error = ?1
       WHERE id = ?2 AND status = 'running' AND lease_owner = ?3 AND lease_generation = ?4
         AND lease_expires_at > ?6
         AND EXISTS (
           SELECT 1 FROM sync_run_items
           WHERE id = ?5 AND sync_run_id = ?2 AND claim_owner = ?3
             AND claim_generation = ?4 AND status = 'processing'
         )`
    ).bind(item.error ?? null, fence.runId, fence.owner, fence.generation, item.id, timestamp),
    db.prepare(
      `UPDATE sync_run_items
       SET status = ?1,
           completed_at = ?2,
           root_checksum = COALESCE(?3, root_checksum),
           last_error = ?4,
           updated_at = ?5${refunded ? ',\n           attempts = MAX(attempts - 1, 0)' : ''}
       WHERE id = ?6 AND sync_run_id = ?7 AND claim_owner = ?8 AND claim_generation = ?9
         AND status = 'processing'
         AND EXISTS (
           SELECT 1 FROM sync_runs
           WHERE id = ?7 AND status = 'running' AND lease_owner = ?8
             AND lease_generation = ?9 AND lease_expires_at > ?5
         )`
    ).bind(
      status,
      status === 'completed' ? timestamp : null,
      item.checksum ?? null,
      item.error ?? null,
      timestamp,
      item.id, fence.runId, fence.owner, fence.generation,
    ),
  ]);

  /*
   * Both statements change one row, or the result is stale and neither does:
   * a late result from a replaced invocation must not move the counters.
   */
  const committed = changedRows(itemResult!) === 1 && changedRows(runResult!) === 1;
  if (!committed && (changedRows(itemResult!) !== 0 || changedRows(runResult!) !== 0)) {
    throw new RegistryError('SYNC_FENCE_INCONSISTENT', `a checkpoint update changed an unexpected number of rows`, item.id);
  }
  return committed;
}

async function completeItem(db: D1Database, fence: Fence, item: { id: string, checksum: string }, options: ClockOption = {}): Promise<boolean> {
  return commitItem(db, fence, item, 'completed', options);
}

/*
 * Records a failed attempt at one root. `spendsAttempt: false` says the
 * failure was the carrier's, not the root's — see isTransportFailure — and
 * the root's budget is left as it was.
 */
async function failItem(
  db: D1Database,
  fence: Fence,
  item: { id: string, error: string },
  options: ClockOption & { spendsAttempt?: boolean } = {},
): Promise<boolean> {
  return commitItem(db, fence, item, 'failed', options);
}

/*
 * Finishes the run. `completed` requires an outcome, which distinguishes an
 * import that produced a version from one that found the source unchanged.
 */
async function finishRun(
  db: D1Database,
  fence: Fence,
  finish: { status: Exclude<SyncRunStatus, 'running'>, outcome?: SyncOutcome, registryVersionId?: string, error?: string },
  options: ClockOption = {},
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sync_runs
     SET status = ?1, outcome = ?2, registry_version_id = COALESCE(?3, registry_version_id),
         last_error = COALESCE(?4, last_error), lease_owner = NULL, lease_expires_at = NULL,
         completed_at = ?5
     WHERE id = ?6 AND status = 'running' AND lease_owner = ?7 AND lease_generation = ?8`
  ).bind(
    finish.status,
    finish.status === 'completed' ? (finish.outcome ?? null) : null,
    finish.registryVersionId ?? null,
    finish.error ?? null,
    at(options.now),
    fence.runId, fence.owner, fence.generation,
  ).run();
  return changedRows(result) === 1;
}

async function runningRun(db: D1Database): Promise<SyncRunRow | null> {
  return db.prepare(`SELECT * FROM sync_runs WHERE status = 'running'`).first<SyncRunRow>();
}

async function pendingItems(db: D1Database, runId: string): Promise<number> {
  const value = await db.prepare(
    `SELECT COUNT(*) AS n FROM sync_run_items
     WHERE sync_run_id = ?1 AND status <> 'completed' AND attempts < ?2`
  ).bind(runId, MAX_ITEM_ATTEMPTS).first<number>('n');
  return value ?? 0;
}

/*
 * Whether upstream should be checked for a new commit. Discovery is daily,
 * while the Cron fires hourly to continue an unfinished import.
 */
async function dueForDiscovery(db: D1Database, options: ClockOption & { intervalSeconds: number }): Promise<boolean> {
  const checkedAt = await db
    .prepare(`SELECT last_upstream_checked_at FROM registry_state WHERE singleton_id = 1`)
    .first<string | null>('last_upstream_checked_at');
  if (checkedAt === null || checkedAt === undefined) {
    return true;
  }
  const elapsed = (options.now ?? (() => new Date()))().getTime() - Date.parse(checkedAt);
  return elapsed >= options.intervalSeconds * 1000;
}

async function recordUpstreamCheck(db: D1Database, options: ClockOption = {}): Promise<void> {
  const timestamp = at(options.now);
  await db.prepare(
    `UPDATE registry_state SET last_upstream_checked_at = ?1, updated_at = ?1 WHERE singleton_id = 1`
  ).bind(timestamp).run();
}

export type { Clock, ClockOption, Fence, LeaseOptions, RootCheckpoint, RunInput };

export {
  MAX_ITEM_ATTEMPTS,
  acquireRun,
  claimItem,
  completeItem,
  dueForDiscovery,
  failItem,
  finishRun,
  pendingItems,
  recordUpstreamCheck,
  releaseLease,
  renewLease,
  runningRun,
  startRun,
};
