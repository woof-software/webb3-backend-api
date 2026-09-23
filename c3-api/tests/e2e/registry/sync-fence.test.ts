import t from 'tap';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import { isRegistryError } from '../../../src/registry/errors.js';
import {
  Fence,
  MAX_ITEM_ATTEMPTS,
  RootCheckpoint,
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
} from '../../../src/registry/sync.js';

import { applyMigrations } from '../../util/d1.js';

/*
 * The sync fence against real local D1. A Cron invocation can be interrupted
 * at any point, so the properties under test are the awkward ones: two
 * invocations overlapping, a lease taken over mid-import, and a result
 * arriving from an invocation that has already been replaced.
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

const COMMIT = 'a34d9b571c833b5d77f052ab8e2dbdbe10df726d';

const ROOTS: RootCheckpoint[] = [
  { rootPath: 'deployments/mainnet/usdc/roots.json', upstreamNetworkKey: 'mainnet', deploymentKey: 'usdc', sourceBlobSha: 'a'.repeat(40) },
  { rootPath: 'deployments/mainnet/weth/roots.json', upstreamNetworkKey: 'mainnet', deploymentKey: 'weth', sourceBlobSha: 'b'.repeat(40) },
  { rootPath: 'deployments/base/usdc/roots.json',    upstreamNetworkKey: 'base',    deploymentKey: 'usdc', sourceBlobSha: 'c'.repeat(40) },
];

// a fixed clock, so lease expiry is exercised without waiting for it
function clockAt(iso: string) {
  return () => new Date(iso);
}

const T0 = '2026-09-18T12:00:00.000Z';
const T1 = '2026-09-18T12:05:00.000Z';
const T2 = '2026-09-18T12:20:00.000Z';

async function newRun(db: D1Database, now: string = T0): Promise<Fence> {
  return startRun(db, {
    sourceCommitSha: COMMIT,
    trackedRef:      'main',
    triggerKind:     'scheduled',
    requestedBy:     'registry-cron',
    reason:          null,
    roots:           ROOTS,
  }, { leaseSeconds: 900, now: clockAt(now) });
}

t.test('one import runs at a time', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  t.equal(fence.generation, 1, 'a new run starts at generation one');
  const run = await runningRun(db);
  t.equal(run?.id, fence.runId);
  t.equal(run?.expected_count, ROOTS.length, 'every root is checkpointed');
  t.equal(await pendingItems(db, fence.runId), ROOTS.length, 'and starts unprocessed');

  try {
    await newRun(db);
    t.fail('a second run was created while one was running');
  } catch (error) {
    t.ok(isRegistryError(error) && error.code === 'SYNC_ALREADY_RUNNING', 'a concurrent creator is refused');
  }

  // the refused creation leaves no partial run behind
  t.equal(await pendingItems(db, fence.runId), ROOTS.length);
  const runs = await db.prepare(`SELECT COUNT(*) AS n FROM sync_runs`).first<number>('n');
  t.equal(runs, 1, 'and no orphaned run rows');
});

t.test('a lease is taken over only once it expires', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  t.equal(await acquireRun(db, { leaseSeconds: 900, now: clockAt(T1) }), null, 'a held lease cannot be taken');
  t.equal(await renewLease(db, fence, { leaseSeconds: 900, now: clockAt(T1) }), true, 'the owner may extend it');

  // T2 is beyond the lease granted at T1
  const resumed = await acquireRun(db, { leaseSeconds: 900, now: clockAt(T2) });
  t.ok(resumed, 'an expired lease is taken over');
  t.equal(resumed!.runId, fence.runId, 'by resuming the same run');
  t.equal(resumed!.generation, 2, 'with a higher generation');

  t.equal(await renewLease(db, fence, { leaseSeconds: 900, now: clockAt(T2) }), false, 'the replaced invocation cannot renew');
  t.equal(await claimItem(db, fence, { now: clockAt(T2) }), null, 'nor claim more work');
  t.equal(
    await finishRun(db, fence, { status: 'completed', outcome: 'imported' }, { now: clockAt(T2) }),
    false,
    'nor finish the run it no longer owns',
  );

  t.equal(await releaseLease(db, resumed!), true, 'the current owner may release the lease');
  const released = await acquireRun(db, { leaseSeconds: 900, now: clockAt(T2) });
  t.equal(released?.generation, 3, 'a released run is resumable at once, without waiting for expiry');
});

t.test('roots are claimed once and committed by their claimant', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  const first = await claimItem(db, fence, { now: clockAt(T0) });
  t.ok(first, 'a pending root is claimed');
  t.equal(first!.status, 'processing');
  t.equal(first!.attempts, 1, 'the attempt is counted at claim time, so a crash cannot loop forever');
  t.equal(first!.claim_generation, fence.generation);

  const second = await claimItem(db, fence, { now: clockAt(T0) });
  t.not(second!.id, first!.id, 'a second claim returns a different root');

  t.equal(
    await completeItem(db, fence, { id: first!.id, checksum: 'c'.repeat(64) }, { now: clockAt(T0) }),
    true,
    'the claimant commits its result',
  );
  t.equal(
    await completeItem(db, fence, { id: first!.id, checksum: 'c'.repeat(64) }, { now: clockAt(T0) }),
    false,
    'committing the same root twice changes nothing',
  );

  const run = await runningRun(db);
  t.equal(run?.completed_count, 1, 'the run counts one completed root');
  t.equal(run?.failed_count, 0);

  t.equal(
    await failItem(db, fence, { id: second!.id, error: 'price feed did not answer' }, { now: clockAt(T0) }),
    true,
    'a failure is recorded against the run',
  );
  const failed = await runningRun(db);
  t.equal(failed?.failed_count, 0, 'a root that may still be retried is not yet a failed root');
  t.equal(failed?.last_error, 'price feed did not answer', 'but its diagnostic is recorded');
});

t.test('an expired lease commits nothing, not even a counter', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  const item = await claimItem(db, fence, { now: clockAt(T0) });
  t.ok(item, 'a root is claimed while the lease is held');

  /*
   * The import outlives the lease and nobody has taken the run over yet. Both
   * statements of the checkpoint batch check the same fence, so neither the
   * counter nor the item moves.
   */
  t.equal(
    await completeItem(db, fence, { id: item!.id, checksum: 'a'.repeat(64) }, { now: clockAt(T2) }),
    false,
    'the commit is refused once the lease has expired',
  );
  const run = await runningRun(db);
  t.equal(run?.completed_count, 0, 'the completed counter is untouched');
  t.equal(run?.failed_count, 0, 'and so is the failed counter');

  const stale = await db.prepare(`SELECT status FROM sync_run_items WHERE id = ?1`).bind(item!.id).first<string>('status');
  t.equal(stale, 'processing', 'the checkpoint is left for whoever takes the run over');
});

t.test('a result from a replaced invocation is discarded', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  const claimed = await claimItem(db, fence, { now: clockAt(T0) });
  t.ok(claimed, 'the first invocation claims a root');

  // the invocation stalls; a later one takes the run over
  const resumed = await acquireRun(db, { leaseSeconds: 900, now: clockAt(T2) });
  t.equal(resumed!.generation, 2);

  t.equal(
    await completeItem(db, fence, { id: claimed!.id, checksum: 'd'.repeat(64) }, { now: clockAt(T2) }),
    false,
    'the stalled invocation cannot commit its late result',
  );
  const run = await runningRun(db);
  t.equal(run?.completed_count, 0, 'so the counters stay untouched');

  /*
   * Roots that were never attempted are claimed before one left behind by a
   * replaced invocation, so first-attempt coverage comes before retries. The
   * abandoned root is still reclaimed, as a second attempt.
   */
  const reclaimed: Array<{ id: string, attempts: number }> = [];
  for (;;) {
    const item = await claimItem(db, resumed!, { now: clockAt(T2) });
    if (item === null) {
      break;
    }
    reclaimed.push({ id: item.id, attempts: item.attempts });
    await completeItem(db, resumed!, { id: item.id, checksum: 'e'.repeat(64) }, { now: clockAt(T2) });
  }

  t.equal(reclaimed.length, ROOTS.length, 'the new owner works through every root');
  t.same(
    reclaimed.find(item => item.id === claimed!.id),
    { id: claimed!.id, attempts: 2 },
    'including the abandoned one, as a second attempt',
  );
  t.same(reclaimed.slice(0, -1).map(item => item.attempts), [ 1, 1 ], 'untouched roots are claimed first');
  t.equal((await runningRun(db))?.completed_count, ROOTS.length, 'and commits them all');
});

t.test('a root that keeps failing stops being retried', async t => {
  const db    = await freshDatabase();
  let fence   = await newRun(db);

  // fail every root until the fence stops handing work out
  let processed = 0;
  const limit   = MAX_ITEM_ATTEMPTS * ROOTS.length + 1;
  for (;;) {
    const item = await claimItem(db, fence, { now: clockAt(T0) });
    if (item === null || processed > limit) {
      break;
    }
    processed++;
    await failItem(db, fence, { id: item.id, error: 'unreadable' }, { now: clockAt(T0) });
  }
  t.equal(processed, MAX_ITEM_ATTEMPTS * ROOTS.length, 'each root is retried up to its bound, then left alone');
  t.equal(await claimItem(db, fence, { now: clockAt(T0) }), null, 'nothing remains claimable');
  t.equal(await pendingItems(db, fence.runId), 0, 'and nothing is reported as outstanding work');
  t.equal(
    (await runningRun(db))?.failed_count,
    ROOTS.length,
    'each exhausted root counts once, however many attempts it took',
  );

  t.equal(
    await finishRun(db, fence, { status: 'failed', error: 'every root failed' }, { now: clockAt(T0) }),
    true,
    'the run finishes as failed',
  );
  t.equal(await runningRun(db), null, 'and no longer holds the running slot');

  fence = await newRun(db, T2);
  t.ok(fence.runId, 'a new run may start once the previous one is terminal');
});

/*
 * An attempt is given back when the failure was the invocation's rather than
 * the root's. What must not follow is the same invocation claiming that root
 * again: it looks untouched, it sorts first, and one root would then consume
 * the whole batch while the others were never tried.
 */
t.test('an attempt can be given back, and the root is not claimed again by the same invocation', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  const first = await claimItem(db, fence, { now: clockAt(T0) });
  t.equal(first?.attempts, 1, 'claiming spends an attempt');
  await failItem(db, fence, { id: first!.id, error: 'the node provider did not answer' }, {
    now:           clockAt(T0),
    spendsAttempt: false,
  });

  const refunded = await db.prepare(`SELECT attempts, status FROM sync_run_items WHERE id = ?1`)
    .bind(first!.id).first<{ attempts: number, status: string }>();
  t.same(refunded, { attempts: 0, status: 'failed' }, 'and giving it back leaves the root as it was');
  t.equal((await runningRun(db))?.failed_count, 0, 'a refunded attempt never makes a root a failed root');

  const next = await claimItem(db, fence, { now: clockAt(T0), except: [ first!.id ] });
  t.not(next?.id, first!.id, 'the same invocation claims a different root');
  t.equal(next?.attempts, 1);

  /*
   * A later invocation is a different one, and the root is claimable again —
   * with the budget it never spent.
   */
  const later = await claimItem(db, fence, { now: clockAt(T0) });
  t.equal(later?.id, first!.id, 'the refunded root is claimed first by whoever comes next');
  t.equal(later?.attempts, 1, 'spending its first attempt for the first time');
});

t.test('a finished run records what it produced', async t => {
  const db    = await freshDatabase();
  const fence = await newRun(db);

  for (;;) {
    const item = await claimItem(db, fence, { now: clockAt(T0) });
    if (item === null) {
      break;
    }
    await completeItem(db, fence, { id: item.id, checksum: 'f'.repeat(64) }, { now: clockAt(T0) });
  }

  t.equal(await pendingItems(db, fence.runId), 0, 'every root is checkpointed as done');
  t.equal(
    await finishRun(db, fence, { status: 'completed', outcome: 'no_change' }, { now: clockAt(T0) }),
    true,
  );

  const run = await db.prepare(`SELECT * FROM sync_runs WHERE id = ?1`).bind(fence.runId).first<{
    status: string, outcome: string, completed_count: number, lease_owner: string | null, completed_at: string,
  }>();
  t.equal(run?.status, 'completed');
  t.equal(run?.outcome, 'no_change', 'an unchanged source is a successful outcome, not an import');
  t.equal(run?.completed_count, ROOTS.length);
  t.equal(run?.lease_owner, null, 'the lease is released');
  t.ok(run?.completed_at, 'and the run is timestamped');
});

t.test('discovery is due once a day, while continuation is hourly', async t => {
  const db = await freshDatabase();
  const day = 86400;

  t.equal(await dueForDiscovery(db, { intervalSeconds: day, now: clockAt(T0) }), true, 'the first check is always due');

  await recordUpstreamCheck(db, { now: clockAt(T0) });
  t.equal(await dueForDiscovery(db, { intervalSeconds: day, now: clockAt(T2) }), false, 'an hour later it is not');
  t.equal(
    await dueForDiscovery(db, { intervalSeconds: day, now: clockAt('2026-09-19T12:00:00.000Z') }),
    true,
    'a day later it is due again',
  );
});
