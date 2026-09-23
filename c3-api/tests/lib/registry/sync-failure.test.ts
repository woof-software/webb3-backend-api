import t from 'tap';

import { ApiError } from '../../../src/http/errors.js';
import { syncFailure } from '../../../src/registry/admin-router.js';
import { RegistryError } from '../../../src/registry/errors.js';

/*
 * What an administrative sync answers when the invocation failed. A script
 * retries a 503, so only a failure worth retrying may be one: a request the
 * registry refuses, or a candidate that failed its checks, fails the same way
 * every time.
 */
t.test('a registry error is answered as every route answers it', async t => {
  const unreachable = new RegistryError('SOURCE_COMMIT_UNREACHABLE', 'the commit is not on the tracked ref');
  const error = syncFailure({ status: 'failed', processed: 0, reason: 'SOURCE_COMMIT_UNREACHABLE: …', error: unreachable });

  t.equal(error, unreachable, 'the router maps it by its code, to 422 for this one');
});

t.test('a candidate that failed its checks is refused with the ids to inspect it by', async t => {
  const error = syncFailure({
    status: 'failed', processed: 0, runId: 'run-1', versionId: 'version-1', reason: 'validation failed',
  }) as ApiError;

  t.ok(error instanceof ApiError);
  t.equal(error.status, 422, 'not a 503 a script would retry');
  t.equal(error.message, 'validation failed');
  t.same(error.details, { syncRunId: 'run-1', registryVersionId: 'version-1' });
});

t.test('anything else is a source that did not answer', async t => {
  const error = syncFailure({ status: 'failed', processed: 0, reason: 'an unexpected error interrupted the import' }) as ApiError;

  t.equal(error.status, 503);
  t.equal(error.message, 'an unexpected error interrupted the import');
});
