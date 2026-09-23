import type { Env } from '../../entrypoint.js';

import { cacheStatus } from './cache.js';
import type { CacheDeps } from './cache.js';

/*
 * One document that says whether the registry is healthy, for an operator
 * looking and for a monitor polling.
 *
 * It is deliberately one request: the things that go wrong here are spread
 * across the version table, the run table and the cache, and an alert built
 * from three endpoints is an alert nobody builds. What it reports is the
 * state; `alerts` is that state reduced to the names of the conditions worth
 * waking someone for, so a check can be "alerts is empty" without teaching
 * the monitor the registry's rules.
 */
type Alert =
  | 'no-active-version'
  | 'candidate-awaiting-review'
  | 'last-sync-failed'
  | 'sync-overdue'
  | 'sync-stalled'
  | 'snapshot-not-cached'
  | 'cache-unreadable';

type RegistryStatus = {
  environment: string,
  checkedAt:   string,
  active: {
    versionId:   string,
    checksum:    string,
    activatedAt: string | null,
    activatedBy: string | null,
    ageSeconds:  number | null,
  } | null,
  cache: {
    snapshotCached:    boolean,
    pointerAgeSeconds: number | null,
    readable:          boolean,
  },
  sync: {
    lastRun: {
      id:             string,
      status:         string,
      outcome:        string | null,
      startedAt:      string,
      completedAt:    string | null,
      ageSeconds:     number,
      failedCount:    number,
      expectedCount:  number,
      completedCount: number,
      lastError:      string | null,
      leaseExpiresAt: string | null,
    } | null,
    upstreamCheckedAt: string | null,
    upstreamAgeSeconds: number | null,
    intervalSeconds:    number,
  },
  candidates: {
    importing: Array<{
      versionId:  string,
      attempt:    number,
      createdAt:  string,
      unreviewed: { networks: number, markets: number },
    }>,
    invalid: number,
  },
  alerts: Alert[],
};

type StateRow = {
  active_version_id:        string | null,
  last_upstream_checked_at: string | null,
};

type ActiveRow = {
  id:          string,
  checksum:    string,
  activated_at: string | null,
  actor:        string | null,
};

type RunRow = {
  id: string, status: string, outcome: string | null, started_at: string,
  completed_at: string | null, failed_count: number, expected_count: number,
  completed_count: number, last_error: string | null, lease_expires_at: string | null,
};

type CandidateRow = { id: string, attempt: number, created_at: string, status: string };

type CountRow = { version_id: string, markets?: number, networks?: number };

// at most this many open drafts are listed; there is never more than a handful in a healthy environment
const MAX_CANDIDATES = 20;

function countsBy(rows: CountRow[] | undefined, field: 'markets' | 'networks'): Map<string, number> {
  return new Map((rows ?? []).map(row => [ row.version_id, row[field] ?? 0 ]));
}

function ageOf(timestamp: string | null, now: Date): number | null {
  if (timestamp === null) {
    return null;
  }
  const at = Date.parse(timestamp);
  return Number.isFinite(at) ? Math.round((now.getTime() - at) / 1000) : null;
}

function intervalOf(env: Env): number {
  const configured = Number(env.COMET_UPSTREAM_CHECK_INTERVAL_S);
  return Number.isInteger(configured) && configured > 0 ? configured : 86400;
}

/*
 * How long a run may sit untouched before nobody is continuing it. The Cron
 * fires hourly, so two hours without an item moving means the trigger is not
 * firing, or every invocation fails before it claims anything.
 */
const STALLED_AFTER_SECONDS = 2 * 60 * 60;

/*
 * A run nobody is continuing. Two shapes of it: a lease still held but
 * expired, which the next invocation takes over by itself, and — the
 * ordinary one — a lease released at the end of an invocation that left work
 * behind, which has no expiry at all. Both are stalled only once nothing has
 * moved for long enough that the next invocation should have come and gone.
 */
function stalled(run: RunRow | null, lastItemAt: string | null, now: Date): boolean {
  if (run === null || run.status !== 'running') {
    return false;
  }
  const expiry = run.lease_expires_at === null ? null : Date.parse(run.lease_expires_at);
  if (expiry !== null && Number.isFinite(expiry) && expiry >= now.getTime()) {
    // somebody holds the lease and is importing right now
    return false;
  }
  const idle = ageOf(lastItemAt ?? run.started_at, now);
  return idle !== null && idle > STALLED_AFTER_SECONDS;
}

async function registryStatus(env: Env, deps: CacheDeps): Promise<RegistryStatus> {
  const now = deps.now?.() ?? new Date();
  const db  = deps.db;

  const [ state, active, run, candidates, unreviewedMarkets, unreviewedNetworks, lastItem, invalid ] = await db.batch([
    db.prepare(`SELECT active_version_id, last_upstream_checked_at FROM registry_state WHERE singleton_id = 1`),
    db.prepare(
      `SELECT version.id AS id, version.snapshot_checksum AS checksum,
              activation.created_at AS activated_at, activation.actor AS actor
       FROM registry_state AS state
       JOIN registry_versions AS version ON version.id = state.active_version_id
       LEFT JOIN registry_activations AS activation
         ON activation.registry_version_id = version.id
        AND activation.created_at = (
          SELECT MAX(created_at) FROM registry_activations WHERE registry_version_id = version.id
        )
       WHERE state.singleton_id = 1`
    ),
    db.prepare(
      `SELECT id, status, outcome, started_at, completed_at, failed_count, expected_count,
              completed_count, last_error, lease_expires_at
       FROM sync_runs ORDER BY started_at DESC LIMIT 1`
    ),
    /*
     * The open candidates, bounded: an environment that has accumulated
     * drafts must not turn the status into the most expensive read in the
     * API, on an endpoint a monitor polls.
     */
    db.prepare(
      `SELECT id, attempt, created_at, status FROM registry_versions
       WHERE status = 'importing' ORDER BY created_at DESC LIMIT ?1`
    ).bind(MAX_CANDIDATES),
    db.prepare(
      `SELECT market.registry_version_id AS version_id, COUNT(*) AS markets
       FROM markets AS market
       JOIN registry_versions AS version ON version.id = market.registry_version_id
       WHERE version.status = 'importing' AND market.reviewed = 0
       GROUP BY market.registry_version_id`
    ),
    db.prepare(
      `SELECT network.registry_version_id AS version_id, COUNT(*) AS networks
       FROM registry_networks AS network
       JOIN registry_versions AS version ON version.id = network.registry_version_id
       WHERE version.status = 'importing' AND network.reviewed = 0
       GROUP BY network.registry_version_id`
    ),
    db.prepare(
      `SELECT MAX(updated_at) AS last_item_at FROM sync_run_items
       WHERE sync_run_id = (SELECT id FROM sync_runs ORDER BY started_at DESC LIMIT 1)`
    ),
    db.prepare(`SELECT COUNT(*) AS count FROM registry_versions WHERE status = 'invalid'`),
  ]);

  const stateRow     = (state.results?.[0] ?? null) as StateRow | null;
  const activeRow    = (active.results?.[0] ?? null) as ActiveRow | null;
  const runRow       = (run.results?.[0] ?? null) as RunRow | null;
  const importing    = (candidates.results ?? []) as CandidateRow[];
  const invalidCount = ((invalid.results?.[0] ?? { count: 0 }) as { count: number }).count;

  const pointer = activeRow === null ? null : { id: activeRow.id, checksum: activeRow.checksum };
  const cache   = await cacheStatus(deps, pointer);

  const upstreamAge = ageOf(stateRow?.last_upstream_checked_at ?? null, now);
  const interval    = intervalOf(env);

  const marketsOpen  = countsBy(unreviewedMarkets.results as CountRow[] | undefined, 'markets');
  const networksOpen = countsBy(unreviewedNetworks.results as CountRow[] | undefined, 'networks');
  const unreviewed   = importing.map(candidate => ({
    versionId:  candidate.id,
    attempt:    candidate.attempt,
    createdAt:  candidate.created_at,
    unreviewed: {
      networks: networksOpen.get(candidate.id) ?? 0,
      markets:  marketsOpen.get(candidate.id) ?? 0,
    },
  }));

  const alerts: Alert[] = [];
  if (!cache.readable) {
    // the namespace did not answer: there is no cache, and no fallback either
    alerts.push('cache-unreadable');
  }
  if (pointer === null) {
    alerts.push('no-active-version');
  } else if (cache.readable && !cache.snapshotCached) {
    /*
     * The bytes of the active version are not cached, so every cold isolate
     * hydrates the snapshot out of D1 again. It is not an outage; it is the
     * warm-up having failed or expired, and it is the first thing to look at
     * when D1 reads climb.
     */
    alerts.push('snapshot-not-cached');
  }
  if (unreviewed.length > 0 && runRow?.status !== 'running') {
    alerts.push('candidate-awaiting-review');
  }
  if (runRow?.status === 'failed') {
    alerts.push('last-sync-failed');
  }
  if (stalled(runRow, (lastItem.results?.[0] as { last_item_at: string | null } | undefined)?.last_item_at ?? null, now)) {
    alerts.push('sync-stalled');
  }
  /*
   * Discovery is due once per interval; twice that without a check means the
   * Cron has not run, or every invocation has failed before recording one.
   */
  if (upstreamAge === null || upstreamAge > interval * 2) {
    alerts.push('sync-overdue');
  }

  return {
    environment: env.ENVIRONMENT,
    checkedAt:   now.toISOString(),
    active: activeRow === null ? null : {
      versionId:   activeRow.id,
      checksum:    activeRow.checksum,
      activatedAt: activeRow.activated_at,
      activatedBy: activeRow.actor,
      ageSeconds:  ageOf(activeRow.activated_at, now),
    },
    cache,
    sync: {
      lastRun: runRow === null ? null : {
        id:             runRow.id,
        status:         runRow.status,
        outcome:        runRow.outcome,
        startedAt:      runRow.started_at,
        completedAt:    runRow.completed_at,
        ageSeconds:     ageOf(runRow.completed_at ?? runRow.started_at, now) ?? 0,
        failedCount:    runRow.failed_count,
        expectedCount:  runRow.expected_count,
        completedCount: runRow.completed_count,
        lastError:      runRow.last_error,
        leaseExpiresAt: runRow.lease_expires_at,
      },
      upstreamCheckedAt:  stateRow?.last_upstream_checked_at ?? null,
      upstreamAgeSeconds: upstreamAge,
      intervalSeconds:    interval,
    },
    candidates: { importing: unreviewed, invalid: invalidCount },
    alerts,
  };
}

export type { Alert, RegistryStatus };
export { registryStatus };
