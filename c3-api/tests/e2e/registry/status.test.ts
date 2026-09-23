import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import { markValidated, recordValidationResults, snapshotChecksum } from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * The status route: one answer a monitor polls and an operator reads.
 *
 * The contract these tests hold is `alerts`: a healthy registry names none,
 * and each condition worth waking someone for names itself, so a check can be
 * "alerts is empty" without the monitor knowing the registry's rules.
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';

const server = createTestHarness({
  workers: [ {
    configPath: './wrangler.toml',
    secrets:    { COMET_REGISTRY_ADMIN_TOKEN_HASH: await sha256Hex(ADMIN_TOKEN) },
  } ],
});

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();
const auth     = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };

type Status = {
  environment: string,
  active: { versionId: string, checksum: string, activatedBy: string | null } | null,
  cache: { snapshotCached: boolean, pointerAgeSeconds: number | null },
  sync: {
    lastRun: { id: string, status: string, failedCount: number } | null,
    upstreamCheckedAt: string | null,
    upstreamAgeSeconds: number | null,
    intervalSeconds: number,
  },
  candidates: { importing: Array<{ versionId: string, unreviewed: { networks: number, markets: number } }>, invalid: number },
  alerts: string[],
};

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

async function status(): Promise<Status> {
  const response = await server.fetch('/registry/v1/admin/status', { headers: auth });
  t.equal(response.status, 200);
  return await response.json() as Status;
}

async function activate(db: D1Database, versionId: string): Promise<void> {
  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, await snapshotChecksum(snapshot.networks));
  await db.batch([
    db.prepare(
      `INSERT INTO registry_activations (id, registry_version_id, previous_version_id, action, actor, reason, created_at)
       SELECT ?1, ?2, active_version_id, 'activate', 'test-admin', 'bringing it up', ?3 FROM registry_state
       WHERE singleton_id = 1 AND active_version_id IS NOT ?2`
    ).bind(randomUUID(), versionId, new Date().toISOString()),
    db.prepare(`UPDATE registry_state SET active_version_id = ?1, updated_at = ?2 WHERE singleton_id = 1`)
      .bind(versionId, new Date().toISOString()),
  ]);
}

const COMMIT = 'a34d9b571c833b5d77f052ab8e2dbdbe10df726d';

async function recordRun(
  db: D1Database,
  run: { status: string, outcome?: string | null, failed?: number, leaseExpiresAt?: string | null, startedAt?: string },
): Promise<string> {
  const id = randomUUID();
  const at = run.startedAt ?? new Date().toISOString();
  await db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, trigger_kind, status, outcome, lease_owner, lease_generation,
       lease_expires_at, expected_count, completed_count, failed_count, last_error, started_at, completed_at
     ) VALUES (?1, ?2, 'main', 'scheduled', ?3, ?4, ?5, 1, ?6, 1, 0, ?7, ?8, ?9, ?10)`
  ).bind(
    id, COMMIT, run.status, run.outcome ?? null,
    run.status === 'running' ? randomUUID() : null,
    run.leaseExpiresAt ?? null,
    run.failed ?? 0,
    run.status === 'failed' ? 'the source did not answer' : null,
    at,
    run.status === 'running' ? null : at,
  ).run();
  return id;
}

t.test('a registry with nothing in it says exactly what is missing', async t => {
  await freshDatabase();

  const empty = await status();
  t.equal(empty.active, null, 'nothing is active');
  t.equal(empty.sync.lastRun, null, 'and nothing has run');
  t.equal(empty.sync.upstreamCheckedAt, null);
  t.same(empty.alerts.sort(), [ 'no-active-version', 'sync-overdue' ],
    'which is two conditions, each named');
  t.equal(empty.cache.snapshotCached, false);
});

t.test('a healthy registry raises nothing', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activate(db, versionId);
  await recordRun(db, { status: 'completed', outcome: 'no_change' });
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();

  // the worker caches what it serves, which is what the status then reports
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const healthy = await status();
  t.equal(healthy.active?.versionId, versionId);
  t.equal(healthy.active?.activatedBy, 'test-admin', 'the status says who switched it on');
  t.equal(healthy.cache.snapshotCached, true, 'the bytes of the active version are cached');
  t.type(healthy.cache.pointerAgeSeconds, 'number', 'and the pointer record has an age');
  t.equal(healthy.sync.lastRun?.status, 'completed');
  t.same(healthy.alerts, [], 'so there is nothing to alert on');
  t.equal(healthy.environment, 'local');
});

t.test('a candidate nobody has reviewed is reported as work waiting', async t => {
  const db = await freshDatabase();
  const { versionId: active } = await seedCandidate(db, snapshot);
  await activate(db, active);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const candidate = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });
  // a market nobody has reviewed is switched off, which the schema enforces
  await db.prepare(
    `UPDATE markets SET reviewed = 0, status = 'disabled', is_default = 0, slug = NULL,
            rewards_enabled = 0, account_rewards_enabled = 0, transaction_history_enabled = 0
     WHERE registry_version_id = ?1 AND deployment_key IN ('usdc', 'weth')
       AND network_id = (SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1)`
  ).bind(candidate.versionId).run();
  await recordRun(db, { status: 'completed', outcome: 'imported' });

  const waiting = await status();
  t.same(waiting.candidates.importing.map(entry => entry.versionId), [ candidate.versionId ],
    'the open candidate is named');
  t.equal(waiting.candidates.importing[0]?.unreviewed.markets, 2, 'with how much of it is unreviewed');
  t.same(waiting.alerts, [ 'candidate-awaiting-review' ]);
});

t.test('a run that failed, and one nobody is continuing, each name themselves', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activate(db, versionId);
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date().toISOString()).run();
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  await recordRun(db, { status: 'failed', failed: 1 });
  const failed = await status();
  t.equal(failed.sync.lastRun?.status, 'failed');
  t.same(failed.alerts, [ 'last-sync-failed' ], 'a failed import is one condition');

  /*
   * An invocation that leaves work behind releases its lease, so the ordinary
   * stalled run has no expiry at all — it is stalled because nothing has
   * moved for longer than the hourly trigger would take.
   */
  await db.prepare(`DELETE FROM sync_runs`).run();
  await recordRun(db, { status: 'running', startedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
  const abandoned = await status();
  t.same(abandoned.alerts, [ 'sync-stalled' ], 'a run nobody has continued for hours is another');

  await db.prepare(`DELETE FROM sync_runs`).run();
  await recordRun(db, {
    status:         'running',
    leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    startedAt:      new Date(Date.now() - 60_000).toISOString(),
  });
  t.same((await status()).alerts, [], 'while a run somebody holds the lease on is simply in progress');

  await db.prepare(`DELETE FROM sync_runs`).run();
  await recordRun(db, {
    status:         'running',
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    startedAt:      new Date(Date.now() - 600_000).toISOString(),
  });
  t.same((await status()).alerts, [],
    'and a lease that has just expired is one the next invocation takes over by itself');
});

t.test('the source going unchecked is an alert of its own', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await activate(db, versionId);
  t.equal((await server.fetch('/registry/v1/active')).status, 200);

  const long = new Date(Date.now() - 5 * 86_400_000).toISOString();
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`).bind(long).run();

  const overdue = await status();
  t.ok((overdue.sync.upstreamAgeSeconds ?? 0) > overdue.sync.intervalSeconds * 2,
    'the age is past twice the interval the environment configures');
  t.same(overdue.alerts, [ 'sync-overdue' ]);
});

t.test('the status is behind the admin token', async t => {
  await freshDatabase();
  t.equal((await server.fetch('/registry/v1/admin/status')).status, 401, 'an anonymous caller is refused');
  t.equal(
    (await server.fetch('/registry/v1/admin/status', { method: 'POST', headers: auth, body: '{}' })).status,
    405,
    'and it is a read',
  );
});
