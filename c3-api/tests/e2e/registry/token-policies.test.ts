import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type {
  NetworkV1,
  TokenPoliciesV1,
  TokenPolicyApplyV1,
  TokenPolicyDetailV1,
  TokenPolicyListV1,
  TokenPolicyResultV1,
  TokenPolicyReviewV1,
} from '../../../lib/model/comet-registry.js';
import { checksumAddress } from '../../../lib/model/comet-registry.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import {
  markValidated,
  recordValidationResults,
  snapshotChecksum,
} from '../../../src/registry/repository.js';
import {
  DecisionList,
  applyTokenPolicies,
  writeTokenPolicy,
  writeTokenPolicyList,
} from '../../../src/registry/token-policy-repository.js';

import { applyMigrations, foreignKeyViolations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * Token policies, through the real worker in workerd over local D1: a
 * decision and its audit, idempotency under a race, survival across
 * activations, the database guard against an activation that races a write,
 * and a list of decisions exported, reviewed and applied through the
 * token-policies routes.
 *
 * Refusals of malformed requests are in token-policy-routes.test.ts, which
 * keeps each file's administrative requests well inside the limiter's budget.
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

// tokens of the fixture, as the registry stores them
const WETH  = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WBTC  = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const USDC  = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
// collateral of the mainnet USDT market alone, so a version without that collateral holds no wUSDM at all
const WUSDM = '0x57f5e098cad7a3d1eed53991d4d66c45c9af7812';
// the base of the fixture's one Base market
const AERO  = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

async function freshEnv(): Promise<Env> {
  await server.reset();
  const env = await server.getWorker<Env>().getEnv();
  await applyMigrations(env.APP_DB);
  return env;
}

function actorOf(env: Env): string {
  return env.COMET_REGISTRY_ADMIN_ACTOR ?? `registry-admin:${env.ENVIRONMENT}`;
}

/*
 * Seeds a validated version of the fixture, or of the networks given. A
 * second version needs its own id, and the seed gives it fresh market ids.
 */
async function seedValidated(db: D1Database, networks: NetworkV1[] = snapshot.networks, versionId?: string): Promise<string> {
  const { versionId: id } = await seedCandidate(
    db,
    { ...snapshot, networks },
    versionId === undefined ? {} : { versionId, attempt: 2 },
  );
  await recordValidationResults(db, id, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, id, await snapshotChecksum(networks));
  return id;
}

// the fixture without one collateral token, which takes the token out of the version
function withoutCollateral(address: string): NetworkV1[] {
  return snapshot.networks.map(network => ({
    ...network,
    markets: network.markets.map(market => ({
      ...market,
      collateralAssets: market.collateralAssets.filter(asset => asset.token.address !== address),
    })),
  }));
}

async function switchTo(versionId: string, action: 'activate' | 'rollback' = 'activate'): Promise<void> {
  const response = await server.fetch(`/registry/v1/admin/versions/${versionId}/${action}`, {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ reason: `${action} for a token policy test` }),
  });
  if (response.status !== 200) {
    throw new Error(`${action} of ${versionId} answered ${response.status}`);
  }
}

type Answer<T> = { status: number, header: (name: string) => string | null, body: T };

async function answerOf<T>(response: Response): Promise<Answer<T>> {
  return { status: response.status, header: name => response.headers.get(name), body: await response.json() as T };
}

async function read<T>(path: string): Promise<Answer<T>> {
  return answerOf<T>(await server.fetch(path, { headers: auth }) as unknown as Response);
}

async function decide(chainId: number, token: string, body: unknown): Promise<Answer<TokenPolicyResultV1>> {
  return answerOf<TokenPolicyResultV1>(await server.fetch(`/registry/v1/admin/networks/${chainId}/tokens/${token}/policy`, {
    method:  'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }) as unknown as Response);
}

async function count(db: D1Database, table: string, where: string = '1 = 1', ...bindings: unknown[]): Promise<number> {
  return await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...bindings).first<number>('n') ?? 0;
}

t.test('a decision is set, kept, and reversed, with one audit event per change', async t => {
  const env       = await freshEnv();
  const db        = env.APP_DB;
  const versionId = await seedValidated(db);
  await switchTo(versionId);
  const registryVersion = { id: versionId, checksum: snapshot.registryVersion.checksum };

  const listed = await read<TokenPoliciesV1>('/registry/v1/admin/networks/1/tokens');
  t.equal(listed.status, 200);
  t.same(listed.body.registryVersion, registryVersion, 'the list names the version it lists');
  t.equal(listed.header('x-registry-version'), versionId, 'in its headers too');
  t.equal(listed.body.inActiveVersion, true, 'a chain the version holds');
  const mainnet = new Set(snapshot.networks.find(network => network.chainId === 1)!.markets.flatMap(market => [
    market.baseAsset.token.address,
    ...(market.rewardAsset === null ? [] : [ market.rewardAsset.token.address ]),
    ...market.collateralAssets.map(asset => asset.token.address),
  ]));
  t.same(listed.body.tokens.map(token => token.address).sort(), [ ...mainnet ].sort(), 'every token of the network, once');
  t.ok(listed.body.tokens.every(token => !token.isStrategic && token.updatedAt === null && token.updatedBy === null),
    'and nobody has decided anything about any of them');

  // a checksummed address names the same token
  const set = await decide(1, checksumAddress(WETH), { isStrategic: true, reason: '  approved by governance  ' });
  t.equal(set.status, 200);
  t.match(set.body.updatedAt, ISO_TIME);
  t.same(set.body, {
    registryVersion,
    chainId:      1,
    tokenAddress: WETH,
    isStrategic:  true,
    changed:      true,
    updatedAt:    set.body.updatedAt,
  }, 'the answer is the decision in force, for the lowercase token');
  t.equal(set.header('x-registry-version'), versionId, 'and names the version it was checked against');
  t.equal(set.header('access-control-allow-origin'), null, 'an administrative answer carries no CORS header');

  const again = await decide(1, WETH, { isStrategic: true, reason: 'again' });
  t.same([ again.body.changed, again.body.isStrategic, again.body.updatedAt ], [ false, true, set.body.updatedAt ],
    'asking for the decision in force changes nothing and keeps its time');

  const undecided = await decide(1, WBTC, { isStrategic: false, reason: 'reviewed, not strategic' });
  t.same([ undecided.body.changed, undecided.body.isStrategic, undecided.body.updatedAt ], [ false, false, null ],
    'a token nobody decided about is already not strategic, and has no decision to date');

  const reversed = await decide(1, WETH, { isStrategic: false, reason: 'no longer strategic' });
  t.same([ reversed.body.changed, reversed.body.isStrategic ], [ true, false ], 'a decision is reversed by the opposite one');

  const detail = await read<TokenPolicyDetailV1>(`/registry/v1/admin/networks/1/tokens/${WETH}/policy`);
  t.equal(detail.status, 200);
  t.same(
    {
      inActiveVersion: detail.body.inActiveVersion,
      isStrategic:     detail.body.isStrategic,
      updatedAt:       detail.body.updatedAt,
      updatedBy:       detail.body.updatedBy,
    },
    { inActiveVersion: true, isStrategic: false, updatedAt: reversed.body.updatedAt, updatedBy: actorOf(env) },
    'the token reads back with the decision in force and who made it',
  );
  t.same(
    detail.body.events.map(event => [ event.previousIsStrategic, event.isStrategic, event.actor, event.reason ]),
    [
      [ true, false, actorOf(env), 'no longer strategic' ],
      [ null, true,  actorOf(env), 'approved by governance' ],
    ],
    'with every change newest first, each with its actor and its reason',
  );

  t.same(
    (await db.prepare(`SELECT chain_id, token_address, is_strategic, updated_at FROM token_policies`).all()).results,
    [ { chain_id: 1, token_address: WETH, is_strategic: 0, updated_at: reversed.body.updatedAt } ],
    'the database holds one row, for the one token decided about',
  );
  t.equal(await count(db, 'token_policy_events'), 2, 'and one event per change, none for the requests that changed nothing');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

t.test('identical requests racing for one token write one change', async t => {
  const { APP_DB: db } = await freshEnv();
  await switchTo(await seedValidated(db));

  const answers = await Promise.all(Array.from({ length: 5 }, () => decide(1, USDC, { isStrategic: true, reason: 'raced' })));
  t.same(answers.map(answer => answer.status), [ 200, 200, 200, 200, 200 ], 'every request succeeds');
  t.equal(answers.filter(answer => answer.body.changed).length, 1, 'one of them changed the decision');
  t.equal(new Set(answers.map(answer => answer.body.updatedAt)).size, 1, 'and every one answers with the decision it made');
  t.equal(await count(db, 'token_policy_events'), 1, 'which is audited once');
});

t.test('a decision outlives the version it was made under', async t => {
  const env = await freshEnv();
  const db  = env.APP_DB;
  const first = await seedValidated(db);
  await switchTo(first);

  const weth  = await decide(1, WETH, { isStrategic: true, reason: 'strategic' });
  const wusdm = await decide(1, WUSDM, { isStrategic: true, reason: 'strategic' });
  t.same([ weth.body.changed, wusdm.body.changed ], [ true, true ]);

  const second = await seedValidated(db, withoutCollateral(WUSDM), randomUUID());
  await switchTo(second);

  const listed = await read<TokenPoliciesV1>('/registry/v1/admin/networks/1/tokens');
  t.equal(listed.body.registryVersion.id, second, 'the list is of the version switched on');
  const token = listed.body.tokens.find(entry => entry.address === WETH);
  t.same([ token?.isStrategic, token?.updatedAt ], [ true, weth.body.updatedAt ],
    'a token of both versions keeps its decision and when it was made');
  t.notOk(listed.body.tokens.some(entry => entry.address === WUSDM), 'a token the version dropped is not listed');
  t.same(listed.body.retained, [ { address: WUSDM, isStrategic: true, updatedAt: wusdm.body.updatedAt, updatedBy: actorOf(env) } ],
    'but its decision is, as one kept until a version brings the token back');

  const kept = await read<TokenPolicyDetailV1>(`/registry/v1/admin/networks/1/tokens/${WUSDM}/policy`);
  t.same(
    [ kept.status, kept.body.inActiveVersion, kept.body.isStrategic, kept.body.events.length ],
    [ 200, false, true, 1 ],
    'and the decision and its history stay readable meanwhile',
  );

  const absent = await decide(1, WUSDM, { isStrategic: false, reason: 'not strategic' });
  t.equal(absent.status, 404, 'though it cannot be decided about while the token is not served');

  await switchTo(first, 'rollback');
  const restored = await read<TokenPolicyDetailV1>(`/registry/v1/admin/networks/1/tokens/${WUSDM}/policy`);
  t.same(
    [ restored.status, restored.body.inActiveVersion, restored.body.isStrategic, restored.body.updatedAt ],
    [ 200, true, true, wusdm.body.updatedAt ],
    'a version that brings the token back brings its decision back with it, in force again',
  );
  const relisted = await read<TokenPoliciesV1>('/registry/v1/admin/networks/1/tokens');
  t.same(
    [ relisted.body.tokens.find(entry => entry.address === WUSDM)?.isStrategic, relisted.body.retained ],
    [ true, [] ],
    'listed among the tokens again, and no longer kept apart',
  );
});

t.test('a chain the active version drops keeps its decisions, and still lists them', async t => {
  const env = await freshEnv();
  const db  = env.APP_DB;
  await switchTo(await seedValidated(db));
  const aero = await decide(8453, AERO, { isStrategic: true, reason: 'strategic' });
  await switchTo(await seedValidated(db, snapshot.networks.filter(network => network.chainId !== 8453), randomUUID()));

  const listed = await read<TokenPoliciesV1>('/registry/v1/admin/networks/8453/tokens');
  t.equal(listed.status, 200, 'a chain the version does not hold is listed while a decision is kept for it');
  t.same(
    [ listed.body.inActiveVersion, listed.body.tokens, listed.body.retained ],
    [ false, [], [ { address: AERO, isStrategic: true, updatedAt: aero.body.updatedAt, updatedBy: actorOf(env) } ] ],
    'with no tokens, and the decision it keeps',
  );
  const detail = await read<TokenPolicyDetailV1>(`/registry/v1/admin/networks/8453/tokens/${AERO}/policy`);
  t.same([ detail.status, detail.body.inActiveVersion, detail.body.isStrategic ], [ 200, false, true ],
    'and the decision stays readable');
});

/*
 * A request reads the active version, finds the token, and writes. Here the
 * version switches between the two, which the repository's own write is the
 * only place to observe: the trigger checks membership inside the write's
 * transaction, so the event is rolled back with the row.
 */
t.test('an activation that drops the token between the read and the write aborts the write', async t => {
  const { APP_DB: db } = await freshEnv();
  await switchTo(await seedValidated(db));
  await switchTo(await seedValidated(db, withoutCollateral(WUSDM), randomUUID()));

  const change = { chainId: 1, tokenAddress: WUSDM, actor: 'test-admin', reason: 'raced an activation' } as const;
  await t.rejects(() => writeTokenPolicy(db, { ...change, isStrategic: true }), { code: 'CONFLICT', message: /left the active registry/ },
    'a change for a token the active version no longer holds is refused');
  t.equal(await count(db, 'token_policy_events'), 0, 'and its event is rolled back with it');
  t.equal(await count(db, 'token_policies'), 0, 'as is the row');

  await t.rejects(() => writeTokenPolicy(db, { ...change, isStrategic: false }), { code: 'CONFLICT' },
    'a request that would change nothing is refused too, rather than answered for a version that does not hold the token');
});

const REVIEW = '/registry/v1/admin/token-policies/review';
const APPLY  = '/registry/v1/admin/token-policies/apply';

async function post<T>(path: string, body: unknown): Promise<Answer<T>> {
  return answerOf<T>(await server.fetch(path, {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }) as unknown as Response);
}

/*
 * A list of decisions: exported as a file, edited, reviewed as the diff it
 * would make, and applied in one transaction. The file is the export itself,
 * so nobody writes an address by hand.
 */
t.test('a list of decisions is exported, reviewed, and applied as one', async t => {
  const env       = await freshEnv();
  const db        = env.APP_DB;
  const versionId = await seedValidated(db);
  await switchTo(versionId);
  await decide(1, USDC, { isStrategic: true, reason: 'decided by hand' });

  const exported = await read<TokenPolicyListV1>('/registry/v1/admin/token-policies');
  t.equal(exported.status, 200);
  t.equal(exported.header('x-registry-version'), versionId, 'the export names the version it lists');
  t.same(exported.body.registryVersion, { id: versionId, checksum: snapshot.registryVersion.checksum });
  t.equal(exported.body.reason, null, 'with a place for the reason of the changes');
  const every = snapshot.networks.flatMap(network => [ ...new Set(network.markets.flatMap(market => [
    market.baseAsset.token.address,
    ...(market.rewardAsset === null ? [] : [ market.rewardAsset.token.address ]),
    ...market.collateralAssets.map(asset => asset.token.address),
  ])) ].map(address => `${network.chainId}:${address}`));
  t.same(exported.body.policies.map(row => `${row.chainId}:${row.tokenAddress}`).sort(), every.sort(),
    'and every token of every network of the active version, once');
  t.same(exported.body.policies.find(row => row.chainId === 1 && row.tokenAddress === USDC),
    { chainId: 1, tokenAddress: USDC, symbol: 'USDC', isStrategic: true }, 'each with the decision in force');

  const untouched = await post<TokenPolicyReviewV1>(REVIEW, exported.body);
  t.equal(untouched.status, 200, 'the export is a list review takes back as it is');
  t.same(untouched.body.summary, { change: 0, unchanged: every.length, problems: 0 }, 'and it changes nothing');

  // what an operator does with the file: mark two tokens, unmark one, and give the reason once
  const edited = {
    ...exported.body,
    reason:   'initial approved list',
    policies: exported.body.policies.map(row =>
        row.chainId === 1    && row.tokenAddress === WETH ? { ...row, isStrategic: true }
      : row.chainId === 8453 && row.tokenAddress === AERO ? { ...row, isStrategic: true, reason: 'the base of the Base market' }
      : row.chainId === 1    && row.tokenAddress === USDC ? { ...row, isStrategic: false }
      : row),
  };
  const review = await post<TokenPolicyReviewV1>(REVIEW, edited);
  t.same(review.body.summary, { change: 3, unchanged: every.length - 3, problems: 0 });
  t.same(
    review.body.policies.filter(row => row.action === 'change').map(row => [ row.symbol, row.current, row.requested, row.reason ]),
    // in the export's order: by chain, then by symbol
    [
      [ 'USDC', true,  false, 'initial approved list' ],
      [ 'WETH', false, true,  'initial approved list' ],
      [ 'AERO', false, true,  'the base of the Base market' ],
    ],
    'the review names every change, with the reason it will be recorded with',
  );
  t.equal(await count(db, 'token_policy_events'), 1, 'and writes nothing');

  const applied = await post<TokenPolicyApplyV1>(APPLY, edited);
  t.equal(applied.status, 200);
  t.same(applied.body.summary, { changed: 3, unchanged: every.length - 3 }, 'applying writes exactly the reviewed changes');
  t.equal(applied.header('x-registry-version'), versionId);
  t.same(
    (await db.prepare(
      `SELECT chain_id, token_address, previous_is_strategic, is_strategic, actor, reason FROM token_policy_events
       WHERE reason <> 'decided by hand' ORDER BY rowid`
    ).all()).results?.length,
    3,
    'one event per change',
  );
  t.same(
    (await db.prepare(`SELECT chain_id, token_address, is_strategic FROM token_policies ORDER BY chain_id, token_address`).all()).results,
    [
      { chain_id: 1,    token_address: USDC, is_strategic: 0 },
      { chain_id: 1,    token_address: WETH, is_strategic: 1 },
      { chain_id: 8453, token_address: AERO, is_strategic: 1 },
    ],
    'and the decisions are what the list says',
  );

  const again = await post<TokenPolicyApplyV1>(APPLY, edited);
  t.same(again.body.summary, { changed: 0, unchanged: every.length }, 'applying the same list again changes nothing');
  t.equal(await count(db, 'token_policy_events'), 4, 'and records nothing');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

t.test('a list with any problem is refused whole, and its problems are named row by row', async t => {
  const { APP_DB: db } = await freshEnv();
  await switchTo(await seedValidated(db));

  const list = {
    reason:   null,
    policies: [
      { chainId: 1,  tokenAddress: WETH, symbol: 'WETH', isStrategic: true, reason: 'approved' },
      { chainId: 1,  tokenAddress: `0x${'0'.repeat(39)}1`, isStrategic: true, reason: 'approved' },
      { chainId: 10, tokenAddress: USDC, isStrategic: true, reason: 'approved' },
      { chainId: 1,  tokenAddress: WBTC, symbol: 'WETH', isStrategic: true, reason: 'approved' },
      { chainId: 1,  tokenAddress: USDC, isStrategic: true },
      { chainId: 1,  tokenAddress: AERO.replace('0x9', '0x8'), isStrategic: false },
    ],
  };
  const review = await post<TokenPolicyReviewV1>('/registry/v1/admin/token-policies/review', list);
  t.equal(review.status, 200, 'a review answers with the problems as part of the diff');
  t.same(review.body.policies.map(row => [ row.row, row.problem ]), [
    [ 1, null ],
    [ 2, `0x${'0'.repeat(39)}1 is not a token of the active registry on chain 1` ],
    [ 3, 'chain 10 is not part of the active registry' ],
    [ 4, `the list names ${WBTC} WETH, which the active registry calls WBTC` ],
    [ 5, `${USDC} (USDC) changes, and needs a reason: its own or the list's` ],
    [ 6, `${AERO.replace('0x9', '0x8')} is not a token of the active registry on chain 1` ],
  ], 'a missing token, a missing chain, a symbol that names another token, and a change without a reason');
  t.equal(review.body.summary.problems, 5);

  const refused = await post<{ error: { code: string, details: { registryVersion: { id: string }, problems: Array<{ row: number }> } } }>(
    APPLY, list);
  t.equal(refused.status, 422, 'apply refuses a list with any problem');
  t.same(refused.body.error.details.problems.map(problem => problem.row), [ 2, 3, 4, 5, 6 ], 'naming every row it refuses');
  t.equal(await count(db, 'token_policy_events'), 0, 'and writes nothing, not even the rows that were fine');
});

/*
 * What a review cannot see: the version switching, or someone else deciding,
 * between the review and the write. The write runs without its review here,
 * which is how such a race reaches it; it writes all of the list or none.
 */
t.test('a list that meets an activation or another decision while it is written writes nothing', async t => {
  const { APP_DB: db } = await freshEnv();
  await switchTo(await seedValidated(db));
  await decide(1, WUSDM, { isStrategic: true, reason: 'decided before the switch' });
  await switchTo(await seedValidated(db, withoutCollateral(WUSDM), randomUUID()));
  const events = await count(db, 'token_policy_events');

  const decisions = (rows: Array<[ string, boolean, string | null ]>) => ({
    reason:    null,
    decisions: rows.map(([ tokenAddress, isStrategic, reason ]) => ({
      chainId: 1, tokenAddress: tokenAddress as `0x${string}`, symbol: null, isStrategic, reason,
    })),
  });

  await t.rejects(
    () => writeTokenPolicyList(db, decisions([ [ WETH, true, 'approved' ], [ WUSDM, false, 'withdrawn' ] ]), 'test-admin'),
    { code: 'CONFLICT', message: /activated while it was being applied; nothing was written/ },
    'a change for a token the active version no longer holds aborts the list',
  );
  await t.rejects(
    () => writeTokenPolicyList(db, decisions([ [ WETH, true, 'approved' ], [ WUSDM, true, null ] ]), 'test-admin'),
    { code: 'CONFLICT', message: /activated while it was being applied/ },
    'and so does a row that changes nothing, once its token is gone',
  );
  await t.rejects(
    () => writeTokenPolicyList(db, decisions([ [ WETH, true, 'approved' ], [ WBTC, true, null ] ]), 'test-admin'),
    { code: 'CONFLICT', message: /changed by someone else while it was being applied/ },
    'as does a row without a reason whose decision is not the one the list states',
  );
  t.equal(await count(db, 'token_policy_events'), events, 'none of them wrote anything');
  t.equal(await count(db, 'token_policies', 'token_address = ?1', WETH), 0, 'not even the rows that were fine');
});

/*
 * The database a request writes through, with `meanwhile` run once just
 * before its first batch: after what the request read, and before it writes.
 */
function beforeFirstBatch(db: D1Database, meanwhile: () => Promise<unknown>): D1Database {
  let pending: (() => Promise<unknown>) | null = meanwhile;
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (pending !== null) {
            const run = pending;
            pending = null;
            await run();
          }
          return await (value as D1Database['batch']).call(target, statements);
        };
      }
      return typeof(value) === 'function' ? value.bind(target) : value;
    },
  });
}

/*
 * Between apply's own comparison and its write. A row that comparison found
 * unchanged is asserted rather than written, so a decision made in that
 * window aborts the list instead of being reverted by it — with the reason
 * given once for the whole list, as the runbook has it.
 */
t.test('a decision made while a list is being applied aborts the list, rather than being reverted', async t => {
  const { APP_DB: db } = await freshEnv();
  await switchTo(await seedValidated(db));
  const list: DecisionList = {
    reason:    'initial approved list',
    decisions: [
      { chainId: 1, tokenAddress: WETH, symbol: null, isStrategic: true,  reason: null },
      { chainId: 1, tokenAddress: WBTC, symbol: null, isStrategic: false, reason: null },
    ],
  };
  const racing = beforeFirstBatch(db, () => decide(1, WBTC, { isStrategic: true, reason: 'governance vote 42' }));

  await t.rejects(() => applyTokenPolicies(racing, list, 'test-admin'),
    { code: 'CONFLICT', message: /changed by someone else while it was being applied; nothing was written/ });
  t.equal(await count(db, 'token_policies', 'token_address = ?1', WETH), 0, 'nothing of the list is written');
  t.equal(await db.prepare(`SELECT is_strategic FROM token_policies WHERE token_address = ?1`).bind(WBTC).first<number>('is_strategic'), 1,
    'and the decision made meanwhile stands');
});
