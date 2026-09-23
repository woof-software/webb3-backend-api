import t from 'tap';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';

import { applyMigrations } from '../../util/d1.js';

/*
 * What protects the administrative API, exercised through the worker: the
 * token, the limiter, and the size of what a caller may send.
 *
 * The registry's admin routes can rebuild and switch what every market route
 * serves, so the interesting cases are the ones where something is refused:
 * an answer that is refused cheaply, refused before it says anything about
 * the registry, and refused the same way whatever the caller guessed.
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

const auth = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

t.test('the token is what the routes are behind, and nothing else', async t => {
  await freshDatabase();

  const cases: Array<[ string, Record<string, string> | undefined ]> = [
    [ 'no header',        undefined ],
    [ 'another scheme',   { 'Authorization': `Basic ${ADMIN_TOKEN}` } ],
    [ 'an empty token',   { 'Authorization': 'Bearer ' } ],
    [ 'the token hash',   { 'Authorization': `Bearer ${await sha256Hex(ADMIN_TOKEN)}` } ],
    [ 'a prefix of it',   { 'Authorization': `Bearer ${ADMIN_TOKEN.slice(0, -1)}` } ],
  ];
  for (const [ name, headers ] of cases) {
    const response = await server.fetch('/registry/v1/admin/status', headers === undefined ? {} : { headers });
    t.equal(response.status, 401, `${name} is refused`);
    const body = await response.json() as { error: { code: string, message: string } };
    t.equal(body.error.code, 'UNAUTHORIZED', 'with one code for every way of getting it wrong');
    t.notMatch(body.error.message, /registry-admin-token/, 'and nothing of what was presented');
  }

  t.equal((await server.fetch('/registry/v1/admin/status', { headers: auth })).status, 200,
    'the token itself is accepted');
});

t.test('an administrative body is bounded', async t => {
  await freshDatabase();

  const oversized = JSON.stringify({ reason: 'x'.repeat(70 * 1024) });
  const response = await server.fetch('/registry/v1/admin/sync', {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    oversized,
  });
  t.equal(response.status, 400, 'a body past the limit is refused');
  t.match((await response.json() as { error: { message: string } }).error.message, /exceeds \d+ bytes/);

  const wrongType = await server.fetch('/registry/v1/admin/sync', {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'text/plain' },
    body:    'reason=x',
  });
  t.equal(wrongType.status, 400, 'and so is a body that is not JSON');

  /*
   * An unauthenticated oversized body is refused as an unauthenticated
   * request, not as an oversized one: the token is checked first, so nothing
   * about the routes is learned by sending garbage at them.
   */
  const anonymous = await server.fetch('/registry/v1/admin/sync', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    oversized,
  });
  t.equal(anonymous.status, 401);
});

/*
 * The limiter is permissive abuse protection, not the concurrency authority —
 * that is the D1 sync lock. What matters here is that it is wired at all,
 * that it counts per route family, and that it answers with a code a script
 * can back off on.
 */
t.test('administrative requests are rate limited per route family', async t => {
  await freshDatabase();

  const LIMIT = 30;
  let refused: { json: () => Promise<unknown> } | null = null;
  let allowed = 0;
  for (let attempt = 0; attempt < LIMIT + 5; attempt++) {
    const response = await server.fetch('/registry/v1/admin/status', { headers: auth });
    if (response.status === 429) {
      refused = response as unknown as { json: () => Promise<unknown> };
      break;
    }
    t.equal(response.status, 200);
    allowed += 1;
  }

  t.not(refused, null, 'the limiter refuses a caller that keeps going');
  if (refused === null) {
    return;
  }
  t.ok(allowed <= LIMIT, `it allowed ${allowed} reads, which is within the configured ${LIMIT}`);
  const body = await refused.json() as { error: { code: string } };
  t.equal(body.error.code, 'RATE_LIMITED', 'with the code a script backs off on');

  /*
   * Reads and activations are counted separately, so a monitor polling the
   * status cannot lock an operator out of switching a version on. The
   * activation below is refused for its own reason, which is what proves the
   * limiter let it through.
   */
  const activation = await server.fetch('/registry/v1/admin/versions/00000000-0000-4000-8000-000000000000/activate', {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ reason: 'not this one' }),
  });
  t.equal(activation.status, 404, 'another family still answers, on its own merits');
});
