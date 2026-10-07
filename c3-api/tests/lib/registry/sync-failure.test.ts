import t from 'tap';

import { randomUUID } from 'node:crypto';

import C3Api, { type Env } from '../../../entrypoint.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import { ApiError } from '../../../src/http/errors.js';
import { syncAnswer, syncFailure } from '../../../src/registry/admin-router.js';
import { CHECK_KEY } from '../../../src/registry/drift.js';
import { RegistryError } from '../../../src/registry/errors.js';
import { ERROR_STATUS, asApiError } from '../../../src/registry/router.js';
import { runRegistrySync } from '../../../src/registry/scheduled.js';

import { MemoryKv } from '../../util/kv.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { makeTestEnv } from '../../util/test-env.js';

import '../../../shim/node-self.js';

/*
 * What an administrative sync answers when the invocation failed. A script
 * retries a 503, so only a failure worth retrying may be one: a request the
 * registry refuses, a source that answered with something it cannot use, or
 * a candidate that failed its checks, fails the same way every time.
 */
t.test('a registry error is answered by its code, and only a carrier that did not answer is a 503', async t => {
  for (const [ code, status ] of [
    [ 'SOURCE_COMMIT_UNREACHABLE', 422 ],
    [ 'SOURCE_TREE_TRUNCATED',     422 ],
    [ 'SOURCE_CONTENT_TOO_LARGE',  422 ],
    [ 'SOURCE_RESPONSE_INVALID',   422 ],
    [ 'CHAIN_CALL_REVERTED',       422 ],
    [ 'CHAIN_RESPONSE_INVALID',    422 ],
    [ 'SYNC_ALREADY_RUNNING',      409 ],
    [ 'SOURCE_REQUEST_FAILED',     503 ],
    [ 'CHAIN_REQUEST_FAILED',      503 ],
  ] as const) {
    const error  = new RegistryError(code, 'what the registry says');
    const answer = asApiError(syncFailure({ kind: 'failed', processed: 0, reason: `${code}: …`, error }));
    t.equal(answer?.status, status, `${code} is answered ${status}`);
    t.same(answer?.details, { code }, 'with the registry\'s own code in its details');
  }

  const retried = Object.entries(ERROR_STATUS)
    .filter(([ , answer ]) => answer === 'UPSTREAM_UNAVAILABLE')
    .map(([ code ]) => code);
  t.same(retried.sort(), [ 'CHAIN_REQUEST_FAILED', 'SOURCE_REQUEST_FAILED' ], 'and no other code is one a script would retry');
});

t.test('a candidate that failed its checks is refused with the ids to inspect it by', async t => {
  const error = syncFailure({
    kind: 'invalid', processed: 0, runId: 'run-1', versionId: 'version-1', reason: 'validation failed',
  }) as ApiError;

  t.ok(error instanceof ApiError);
  t.equal(error.status, 422, 'not a 503 a script would retry');
  t.equal(error.message, 'validation failed');
  t.same(error.details, { syncRunId: 'run-1', registryVersionId: 'version-1' });
});

t.test('anything else is a service that did not answer', async t => {
  const error = syncFailure({ kind: 'failed', processed: 0, reason: 'the import was interrupted by a service that did not answer' }) as ApiError;

  t.equal(error.status, 503);
  t.equal(error.message, 'the import was interrupted by a service that did not answer');
});

/*
 * What an invocation that did not fail is answered as. The kind of the
 * result decides it, and nothing else: a held candidate completed its import
 * as a validated one did, and says it is held, however many of its checks
 * failed — none, too.
 */
t.test('a sync is answered by what its invocation did', async t => {
  const progress = { runId: 'run-1', versionId: 'version-1', processed: 0, expected: 2, completed: 2, outstanding: 0 };
  const answers = {
    idle:      syncAnswer({ kind: 'idle', processed: 0, reason: 'upstream was checked recently' }),
    running:   syncAnswer({ ...progress, kind: 'running', processed: 1, completed: 1, outstanding: 1 }),
    held:      syncAnswer({ ...progress, kind: 'held', checksFailed: 0, reason: 'every root is imported' }),
    imported:  syncAnswer({ ...progress, kind: 'imported' }),
    unchanged: syncAnswer({ kind: 'unchanged', versionId: 'version-1', processed: 0, reason: 'the commit is already imported' }),
  };

  t.same(answers.idle, { status: 'idle', outcome: null, heldForReview: false, checksFailed: 0 });
  t.same(answers.running, { status: 'running', outcome: null, heldForReview: false, checksFailed: 0 },
    'an import with work left has no outcome yet');
  t.same(answers.held, { status: 'completed', outcome: 'imported', heldForReview: true, checksFailed: 0 },
    'a held candidate whose every check passed is held all the same');
  t.same(answers.imported, { status: 'completed', outcome: 'imported', heldForReview: false, checksFailed: 0 });
  t.same(answers.unchanged, { status: 'completed', outcome: 'no_change', heldForReview: false, checksFailed: 0 });
  t.equal(
    syncAnswer({ ...progress, kind: 'held', checksFailed: 3, reason: 'every root is imported; 3 of its checks failed' }).checksFailed,
    3,
    'and one whose checks failed says how many',
  );
});

// a database whose every statement fails as `message` says
function failingDatabase(message: string): D1Database {
  const fail = () => { throw new Error(message); };
  return { prepare: fail, batch: fail, exec: fail, dump: fail } as unknown as D1Database;
}

// what the sync wrote to console.error, for the length of a test
function captureErrors(t: { teardown: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...parameters: unknown[]) => { lines.push(parameters.map(String).join(' ')); };
  t.teardown(() => { console.error = error; });
  return lines;
}

// what the sync wrote to console.warn, for the length of a test
function captureWarnings(t: { teardown: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...parameters: unknown[]) => { lines.push(parameters.map(String).join(' ')); };
  t.teardown(() => { console.warn = warn; });
  return lines;
}

/*
 * A sync runs unattended, so its failures are written down in stage and
 * production too, where DEBUG is empty. A fault is told apart from a service
 * that did not answer: only the second is a failure worth retrying.
 */
t.test('a fault is raised and logged whole, whatever DEBUG says', async t => {
  const errors = captureErrors(t);
  const env = makeTestEnv({ DEBUG: '', APP_DB: failingDatabase('D1_ERROR: no such table: sync_runs: SQLITE_ERROR') });

  await t.rejects(runRegistrySync(env), { message: /no such table/ }, 'the route answers it as an internal error');
  t.ok(errors.some(line => line.includes('registry sync failed unexpectedly')), 'it is logged with DEBUG empty');
  t.ok(errors.some(line => line.includes('no such table: sync_runs')), 'with the error itself');
});

t.test('a database restarted under the request did not answer: 503, not a fault', async t => {
  captureErrors(t);
  const env = makeTestEnv({ DEBUG: '', APP_DB: failingDatabase('D1_ERROR: D1 DB reset because its code was updated.') });

  const result = await runRegistrySync(env);
  t.equal(result.kind, 'failed');
  t.equal(result.kind === 'failed' && (syncFailure(result) as ApiError).status, 503, 'D1 says to retry it, so a script may');
});

t.test('a service that did not answer is a failed invocation, logged with what failed', async t => {
  const errors = captureErrors(t);
  const env = makeTestEnv({ DEBUG: '', APP_DB: failingDatabase('D1_ERROR: Network connection lost.') });

  const result = await runRegistrySync(env);
  t.same(result, { kind: 'failed', processed: 0, reason: 'the import was interrupted by a service that did not answer' });
  t.equal(result.kind === 'failed' && (syncFailure(result) as ApiError).status, 503, 'which a script may retry');
  t.ok(errors.some(line => line.includes('Network connection lost')), 'and the log says which service it was');
});

/*
 * A sync a person asked for, refused for what it asked or for what the source
 * answered, is answered with why, and is theirs to act on: the log has it as
 * a warning, under the id of that answer. The same refusal met by the
 * schedule is told to nobody but the log, and is an error; so is a service
 * that did not answer, whoever asked.
 */
t.test('a refusal a person is answered with is a warning, under the id of the answer', async t => {
  const errors    = captureErrors(t);
  const warnings  = captureWarnings(t);
  const requestId = randomUUID();
  // a configuration the import refuses before it asks anything of anyone
  const env = makeTestEnv({ DEBUG: '', COMET_SYNC_LEASE_SECONDS: 'a while' });

  const asked = await runRegistrySync(env, { requestedBy: 'registry-admin:test' }, { requestId });
  t.equal(asked.kind === 'failed' && asked.error?.code, 'SOURCE_CONFIGURATION_INVALID', 'the request is refused');
  t.ok(warnings.some(line => line.includes('registry sync refused')), 'and the log has it as a warning');
  t.ok(warnings.some(line => line.includes(requestId)), 'under the id of the answer');
  t.same(errors, [], 'and not as an error: nothing failed');

  await runRegistrySync(env);
  t.ok(errors.some(line => line.includes('registry sync failed')), 'the schedule meeting the same refusal is an error');

  errors.length = 0;
  const down = makeTestEnv({ DEBUG: '', APP_DB: failingDatabase('D1_ERROR: Network connection lost.') });
  await runRegistrySync(down, { requestedBy: 'registry-admin:test' }, { requestId });
  t.ok(errors.some(line => line.includes('registry sync failed')), 'and so is a service that did not answer, whoever asked');
  t.ok(errors.some(line => line.includes(requestId)), 'under the id of the answer');
});

/*
 * Through the administrative route: a sync sent while another invocation
 * imports is refused with 409, which is routine while the hourly import runs,
 * and the log line about it carries the request id the answer names.
 */
t.test('an administrative sync refused while another imports is logged under its request id', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  // another invocation, importing right now under a live lease
  await registry.db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, trigger_kind, requested_by, status,
       lease_owner, lease_expires_at, expected_count, started_at
     ) VALUES (?1, ?2, 'main', 'scheduled', 'registry-cron', 'running', ?3, ?4, 1, ?5)`
  ).bind(randomUUID(), 'a'.repeat(40), randomUUID(), new Date(Date.now() + 900_000).toISOString(), new Date().toISOString()).run();

  const errors   = captureErrors(t);
  const warnings = captureWarnings(t);
  const env = makeTestEnv({
    DEBUG:                            '',
    MEMORY_CACHE_SEED:                'registry-sync-failure',
    APP_DB:                           registry.db,
    COMET_REGISTRY_ADMIN_TOKEN_HASH:  await sha256Hex('registry-admin-token-for-tests'),
    REGISTRY_ADMIN_RATE_LIMITER:      { limit: async () => ({ success: true }) },
    REGISTRY_ADMIN_AUTH_RATE_LIMITER: { limit: async () => ({ success: true }) },
  });
  const response = await C3Api.fetch(new Request('https://api.test.local/registry/v1/admin/sync', {
    method:  'POST',
    headers: { 'Authorization': 'Bearer registry-admin-token-for-tests', 'Content-Type': 'application/json' },
    body:    '{}',
  }), env);

  t.equal(response.status, 409);
  const { error } = await response.json() as { error: { requestId: string, details: { code: string } } };
  t.equal(error.details.code, 'SYNC_ALREADY_RUNNING');
  t.ok(warnings.some(line => line.includes(error.requestId)), 'the log line about the refusal carries the id of the answer');
  t.same(errors, [], 'and it is a warning: nothing failed');
});

/*
 * The Cron as the platform runs it, scheduled for `scheduledTime`: whether
 * the handler failed, and whether it asked not to be run again.
 */
async function cron(env: Env, scheduledTime = Date.now()): Promise<{ outcome: 'ok' | 'exception', error?: unknown, noRetry: boolean }> {
  let noRetry = false;
  const work: Array<Promise<unknown>> = [];
  const controller = { cron: '0 * * * *', scheduledTime, noRetry: () => { noRetry = true; } };
  const context    = { waitUntil: (promise: Promise<unknown>) => { work.push(promise); }, passThroughOnException: () => {} };
  try {
    await C3Api.scheduled(controller as unknown as ScheduledController, env, context as unknown as ExecutionContext);
    return { outcome: 'ok', noRetry };
  } catch (error) {
    return { outcome: 'exception', error, noRetry };
  } finally {
    await Promise.allSettled(work);
  }
}

/*
 * The Cron's outcome is the import's. One that failed — here a database that
 * did not answer — fails the Cron, so the Cron's metrics and past events show
 * it, where a success only the log contradicted showed nothing; a fault fails
 * it as before. Neither is run again by the platform: the next hourly
 * invocation resumes from the checkpoints.
 */
t.test('a Cron whose import failed fails, and is not run again', async t => {
  captureErrors(t);
  captureWarnings(t);

  const down = await cron(makeTestEnv({ DEBUG: '', APP_DB: failingDatabase('D1_ERROR: Network connection lost.') }));
  t.equal(down.outcome, 'exception', 'an import a database did not answer fails the Cron');
  t.match(String(down.error), /registry sync failed: the import was interrupted by a service that did not answer/,
    'saying why, as the import answers it');
  t.equal(down.noRetry, true, 'and asks not to be run again');

  const fault = await cron(makeTestEnv({ DEBUG: '', APP_DB: failingDatabase('D1_ERROR: no such table: sync_runs: SQLITE_ERROR') }));
  t.same([ fault.outcome, fault.noRetry ], [ 'exception', true ], 'a fault fails it too');

  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  /*
   * Discovery asks the source once a day, and the version on is held against
   * the chain as often: a check of each recorded now leaves this invocation
   * nothing to do, and nothing to ask of the network.
   */
  const now = Date.now();
  await registry.db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1 WHERE singleton_id = 1`)
    .bind(new Date(now).toISOString()).run();
  const checked     = { versionId: registry.versionId, checkedAt: new Date(now).toISOString(), drifts: [], unreadable: [] };
  const kv_registry = MemoryKv({ seed: { [CHECK_KEY]: checked } });
  const idle = await cron(makeTestEnv({ DEBUG: '', APP_DB: registry.db, kv_registry }), now);
  t.same([ idle.outcome, idle.noRetry ], [ 'ok', true ], 'while an invocation that had nothing to do succeeds');
  t.same(await kv_registry.get(CHECK_KEY, 'json'), checked, 'without reading the chain it checked this hour');
});

/*
 * An administrative sync can start its run while the Cron is asking GitHub
 * for the commit to import, and the one running slot then refuses the Cron's
 * run. That is the Cron finding another invocation importing, as it does when
 * it finds the run before it asks anything: it has nothing to do this hour,
 * and which of the two reached the slot first is no failure. A person whose
 * request loses the same race is told that a sync is running, as before.
 */
t.test('a Cron that loses the running slot to an administrative sync has nothing to do, and succeeds', async t => {
  const errors = captureErrors(t);
  captureWarnings(t);
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const db = registry.db;

  // GitHub, with an administrative sync starting its run, under its own live lease, while the ref is asked for
  const commit = 'c'.repeat(40);
  let started: string | null = null;
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const { url } = new Request(input, init);
    if (url.endsWith('/commits/main')) {
      started = randomUUID();
      await db.prepare(
        `INSERT INTO sync_runs (
           id, source_commit_sha, tracked_ref, trigger_kind, requested_by, status,
           lease_owner, lease_expires_at, expected_count, started_at
         ) VALUES (?1, ?2, 'main', 'manual', 'registry-admin:operator', 'running', ?3, ?4, 1, ?5)`
      ).bind(started, commit, randomUUID(), new Date(Date.now() + 900_000).toISOString(), new Date().toISOString()).run();
      return new Response(commit);
    }
    if (url.includes('/git/trees/')) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: [ { path: 'deployments/mainnet/usdc/roots.json', type: 'blob', sha: 'd'.repeat(40), size: 100 } ],
      }));
    }
    throw new TypeError('fetch failed');
  }) as unknown as typeof globalThis.fetch;
  t.teardown(() => { globalThis.fetch = fetchBefore; });
  const env = makeTestEnv({ DEBUG: '', APP_DB: db });
  // the run that won the slot finishes, or is gone, before the next case races for it again
  const another = () => db.prepare(`DELETE FROM sync_runs WHERE id = ?1`).bind(started).run();

  const scheduled = await cron(env);
  t.same([ scheduled.outcome, scheduled.noRetry ], [ 'ok', true ], 'the Cron succeeds');
  t.same(errors, [], 'and nothing is logged as a failure');

  await another();
  const result = await runRegistrySync(env);
  t.same(result, { kind: 'idle', runId: started, processed: 0, reason: 'another invocation is importing right now' },
    'its answer names the run that is importing, as one found before discovery does');

  await another();
  const asked = await runRegistrySync(env, { requestedBy: 'registry-admin:test' });
  t.equal(asked.kind === 'failed' && asked.error?.code, 'SYNC_ALREADY_RUNNING', 'a person who asked is told a sync is running');
  t.equal(asked.kind === 'failed' && asApiError(syncFailure(asked))?.status, 409, 'with a 409');
});
