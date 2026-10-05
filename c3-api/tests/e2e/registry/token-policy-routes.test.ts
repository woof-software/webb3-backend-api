import t from 'tap';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import {
  activateVersion,
  markValidated,
  recordValidationResults,
  snapshotChecksum,
} from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * What the token policy routes refuse, through the real worker: a caller
 * without the token, a malformed request, a chain or a token the active
 * registry does not hold, and a registry with nothing active. Every refusal
 * writes nothing.
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
const WETH     = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

// the same address in another case, which names the same token
const checksumOf = (address: string) => address.slice(0, 2) + address.slice(2).toUpperCase();

type ErrorBody = { error: { code: string, message: string, details?: { registryVersion?: { id: string } } } };

async function freshDatabase(
  { activate, through }: { activate: boolean, through?: string },
): Promise<{ db: D1Database, versionId: string }> {
  await server.reset();
  const { APP_DB: db } = await server.getWorker<Env>().getEnv();
  await applyMigrations(db, undefined, through === undefined ? {} : { through });
  const { versionId } = await seedCandidate(db, snapshot);
  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, await snapshotChecksum(snapshot.networks));
  if (activate) {
    await activateVersion(db, { versionId, action: 'activate', actor: 'test-seed', reason: 'seeded for a policy test' });
  }
  return { db, versionId };
}

function patch(path: string, body: unknown, headers: Record<string, string> = auth) {
  return server.fetch(path, {
    method:  'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body:    typeof(body) === 'string' ? body : JSON.stringify(body),
  });
}

async function written(db: D1Database): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM token_policy_events`).first<number>('n') ?? 0)
       + (await db.prepare(`SELECT COUNT(*) AS n FROM token_policies`).first<number>('n') ?? 0);
}

const policyPath = (chainId: string | number, token: string) => `/registry/v1/admin/networks/${chainId}/tokens/${token}/policy`;

t.test('the policy routes are behind the token and closed to browsers', async t => {
  const { db } = await freshDatabase({ activate: true });

  const anonymous = await patch(policyPath(1, WETH), { isStrategic: true, reason: 'x' }, {});
  t.equal(anonymous.status, 401, 'a change without the token is refused');
  t.equal(anonymous.headers.get('access-control-allow-origin'), null, 'without a CORS header');
  t.equal((await server.fetch('/registry/v1/admin/networks/1/tokens')).status, 401, 'and so is a read');
  t.equal((await server.fetch(policyPath(1, WETH))).status, 401, 'of one token as well');

  const wrongVerb = await server.fetch(policyPath(1, WETH), { method: 'POST', headers: auth, body: '{}' });
  t.equal(wrongVerb.status, 405, 'a policy is changed with PATCH');
  t.equal(wrongVerb.headers.get('allow'), 'GET, PATCH, OPTIONS', 'and the refusal says which verbs the path takes');

  const preflight = await server.fetch(policyPath(1, WETH), { method: 'OPTIONS' });
  t.equal(preflight.status, 204);
  t.equal(preflight.headers.get('access-control-allow-origin'), null, 'a preflight advertises nothing to a browser');

  t.equal(await written(db), 0, 'nothing was written');
});

t.test('a policy request is checked before anything is written', async t => {
  const { db, versionId } = await freshDatabase({ activate: true });
  const valid = { isStrategic: true, reason: 'approved' };

  for (const chainId of [ '0', '-1', 'mainnet', '1.5', '9007199254740993' ]) {
    t.equal((await patch(policyPath(chainId, WETH), valid)).status, 400, `chain id ${chainId} is refused`);
  }
  for (const token of [ 'weth', '0x1234', `0x${'g'.repeat(40)}`, `${WETH}00` ]) {
    t.equal((await patch(policyPath(1, token), valid)).status, 400, `address ${token} is refused`);
  }

  const bodies: Array<[ string, unknown, RegExp ]> = [
    [ 'an empty body',                 {},                                                   /isStrategic must be a boolean/ ],
    [ 'a value that is not a boolean', { isStrategic: 'true', reason: 'approved' },          /isStrategic must be a boolean/ ],
    [ 'a missing reason',              { isStrategic: true },                                /reason/ ],
    [ 'a blank reason',                { isStrategic: true, reason: '   ' },                 /reason/ ],
    [ 'an unbounded reason',           { isStrategic: true, reason: 'x'.repeat(1001) },      /reason/ ],
    [ 'an actor of its own',           { isStrategic: true, reason: 'x', actor: 'someone' }, /unexpected properties: actor/ ],
    // SQLite would read it as empty, and refuse it with a database error rather than this answer
    [ 'a reason that starts with NUL', { isStrategic: true, reason: '\u0000approved' },      /cannot contain a NUL character/ ],
    [ 'malformed JSON',                '{',                                                  /not valid JSON/ ],
  ];
  for (const [ name, body, message ] of bodies) {
    const response = await patch(policyPath(1, WETH), body);
    t.equal(response.status, 400, `${name} is refused`);
    t.match((await response.json() as ErrorBody).error.message, message);
  }

  const chain = await patch(policyPath(10, WETH), valid);
  t.equal(chain.status, 404, 'a chain the active registry does not hold is not found');
  const chainBody = await chain.json() as ErrorBody;
  t.match(chainBody.error.message, /chain 10 is not part of the active registry/);
  t.equal(chainBody.error.details?.registryVersion?.id, versionId, 'and the refusal names the version it was decided against');
  t.equal(chain.headers.get('x-registry-version'), versionId, 'in its headers too');

  const token = await patch(policyPath(1, `0x${'0'.repeat(39)}1`), valid);
  t.equal(token.status, 404, 'nor is a token it does not hold');
  t.match((await token.json() as ErrorBody).error.message, /is not a token of the active registry on chain 1/);

  t.equal((await server.fetch('/registry/v1/admin/networks/10/tokens', { headers: auth })).status, 404,
    'the tokens of an unknown chain are not found either');
  t.equal((await server.fetch(policyPath(1, `0x${'0'.repeat(39)}1`), { headers: auth })).status, 404,
    'nor the history of a token nobody decided about and the active version does not hold');

  t.equal(await written(db), 0, 'none of it wrote anything');
});

t.test('without an active version there is no token to decide about', async t => {
  const { db } = await freshDatabase({ activate: false });

  const change = await patch(policyPath(1, WETH), { isStrategic: true, reason: 'approved' });
  t.equal(change.status, 503);
  t.equal((await change.json() as ErrorBody).error.code, 'REGISTRY_NOT_ACTIVE', 'with the versionless code');
  t.equal(change.headers.get('x-registry-version'), null, 'and no version it could name');

  for (const path of [ '/registry/v1/admin/networks/1/tokens', policyPath(1, WETH) ]) {
    const response = await server.fetch(path, { headers: auth });
    t.equal(response.status, 503, `${path} says the same`);
  }
  t.equal(await written(db), 0, 'nothing was written');
});

function post(path: string, body: unknown, headers: Record<string, string> = auth) {
  return server.fetch(path, {
    method:  'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body:    typeof(body) === 'string' ? body : JSON.stringify(body),
  });
}

const REVIEW = '/registry/v1/admin/token-policies/review';
const APPLY  = '/registry/v1/admin/token-policies/apply';

/*
 * A list is checked the same way by review and apply, so the shape is probed
 * through review, which spends no write budget, and once through apply.
 */
t.test('a list of decisions is checked completely before anything is read or written', async t => {
  const { db } = await freshDatabase({ activate: true });
  const row = { chainId: 1, tokenAddress: WETH, isStrategic: true };

  const shapes: Array<[ string, unknown, RegExp ]> = [
    [ 'a body without policies',        { reason: 'x' },                               /policies must be a list of 1 to 500 decisions/ ],
    [ 'an empty list',                  { policies: [] },                              /policies must be a list of 1 to 500 decisions/ ],
    [ 'a list longer than 500',         { policies: Array.from({ length: 501 }, () => row) }, /policies must be a list of 1 to 500 decisions/ ],
    [ 'a property of its own',          { policies: [ row ], actor: 'someone' },       /unexpected properties: actor/ ],
    [ 'a list reason that is not text', { reason: 5, policies: [ row ] },              /the list of token policies is invalid/ ],
    [ 'a bare array',                   [ row ],                                       /must be a JSON object/ ],
  ];
  for (const [ name, body, message ] of shapes) {
    const response = await post(REVIEW, body);
    t.equal(response.status, 400, `${name} is refused`);
    t.match((await response.json() as ErrorBody).error.message, message);
  }

  const rows = await post(REVIEW, {
    reason: '\u0000approved',
    policies: [
      'WETH',
      { ...row, note: 'x' },
      { chainId: '1', tokenAddress: '0x12', isStrategic: 'yes', symbol: 5, reason: ' ' },
      { ...row, reason: 'x'.repeat(1001) },
      row,
      { ...row, tokenAddress: checksumOf(WETH) },
    ],
  });
  t.equal(rows.status, 400, 'a list with malformed rows is refused');
  const problems = (await rows.json() as { error: { details: { problems: string[] } } }).error.details.problems;
  t.same(problems, [
    'reason cannot contain a NUL character',
    'row 1 must be an object',
    'row 2 has unexpected properties: note',
    'row 3: chainId must be a positive integer',
    'row 3: tokenAddress must be an address',
    'row 3: symbol must be null or a string',
    'row 3: isStrategic must be a boolean',
    'row 3: reason must be null or a non-empty string of at most 1000 characters',
    'row 4: reason must be null or a non-empty string of at most 1000 characters',
    `row 6 repeats row 5 (chain 1, ${WETH})`,
  ], 'naming every problem of every row at once, a repeated token in any case included');

  const applied = await post(APPLY, { policies: [ { ...row, isStrategic: 'yes' } ] });
  t.equal(applied.status, 400, 'apply checks a list the same way');

  /*
   * A reviewed list may carry a reason on every row, which is more than an
   * ordinary command's body allows: these routes take up to a mebibyte.
   */
  const policies = Array.from({ length: 80 }, (_, index) => ({
    chainId: index + 1, tokenAddress: WETH, isStrategic: false, reason: 'r'.repeat(1000),
  }));
  t.ok(JSON.stringify({ policies }).length > 64 * 1024, 'a list past the ordinary 64 KiB');
  const long = await post(REVIEW, { policies });
  t.equal(long.status, 200, 'is read, and reviewed');
  t.equal((await post(APPLY, { policies })).status, 422, 'and by apply, which refuses it for its rows, not for its size');

  t.equal(await written(db), 0, 'none of it wrote anything');
});

t.test('the list routes are behind the token, and answer only for an active version', async t => {
  const { db } = await freshDatabase({ activate: false });
  const list = { policies: [ { chainId: 1, tokenAddress: WETH, isStrategic: true, reason: 'approved' } ] };

  t.equal((await post(APPLY, list, {})).status, 401, 'an anonymous apply is refused');
  t.equal((await server.fetch('/registry/v1/admin/token-policies')).status, 401, 'and so is an anonymous export');
  const wrongVerb = await server.fetch(APPLY, { headers: auth });
  t.equal(wrongVerb.status, 405, 'a list is applied with POST');
  t.equal(wrongVerb.headers.get('allow'), 'POST, OPTIONS');

  for (const [ name, response ] of [
    [ 'export', await server.fetch('/registry/v1/admin/token-policies', { headers: auth }) ],
    [ 'review', await post(REVIEW, list) ],
    [ 'apply',  await post(APPLY, list) ],
  ] as const) {
    t.equal(response.status, 503, `${name} answers 503 without an active version`);
    t.equal((await response.json() as ErrorBody).error.code, 'REGISTRY_NOT_ACTIVE');
  }
  t.equal(await written(db), 0, 'nothing was written');
});

/*
 * A release deployed before its migration finds the token policy tables
 * missing. That is said, with what to do about it, rather than answered as an
 * internal error only the logs explain.
 */
t.test('a database without the token policy migration says so', async t => {
  await freshDatabase({ activate: true, through: '0003' });

  for (const [ name, response ] of [
    [ 'the export',     await server.fetch('/registry/v1/admin/token-policies', { headers: auth }) ],
    [ 'a policy change', await patch(policyPath(1, WETH), { isStrategic: true, reason: 'approved' }) ],
  ] as const) {
    t.equal(response.status, 503, `${name} answers 503`);
    const body = await response.json() as ErrorBody;
    t.equal(body.error.code, 'UPSTREAM_UNAVAILABLE');
    t.match(body.error.message, /apply the D1 migrations/, 'naming the remedy');
  }
});
