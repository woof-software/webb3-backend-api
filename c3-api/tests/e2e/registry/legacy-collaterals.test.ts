import t from 'tap';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type {
  ActiveMarketV1,
  LegacyCollateralApplyV1,
  LegacyCollateralDetailV1,
  LegacyCollateralListV1,
  LegacyCollateralResultV1,
  LegacyCollateralReviewV1,
  NetworkV1,
  RetainedLegacyCollateralV1,
} from '../../../lib/model/comet-registry.js';
import { checksumAddress } from '../../../lib/model/comet-registry.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import {
  DecisionList,
  applyLegacyCollaterals,
  writeLegacyCollateral,
  writeLegacyCollateralList,
} from '../../../src/registry/legacy-collateral-repository.js';
import {
  markValidated,
  recordValidationResults,
  snapshotChecksum,
} from '../../../src/registry/repository.js';

import { applyMigrations, foreignKeyViolations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * Legacy collaterals, through the real worker in workerd over local D1: a
 * decision and its audit, idempotency under a race, survival across
 * activations, the database guard against an activation that races a write,
 * and a list of decisions — the seed document of the runbook among them —
 * exported, reviewed and applied through the legacy-collaterals routes.
 *
 * Refusals of malformed requests are in legacy-collateral-routes.test.ts, and
 * what the active reads answer in legacy-collateral-reads.test.ts, which keeps
 * each file's administrative requests well inside the limiter's budget.
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
const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;

// a market of the fixture's mainnet by its deployment key, and a collateral of it by symbol
const comet = (key: string) => mainnet.markets.find(market => market.deploymentKey === key)!.contracts.comet!;
const collateral = (key: string, symbol: string) => mainnet.markets.find(market => market.deploymentKey === key)!
  .collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address;

const USDT  = comet('usdt');
const USDC  = comet('usdc');
const WETH  = comet('weth');
// collateral of the USDT market alone, so a version without it in that market holds no mETH at all
const METH  = collateral('usdt', 'mETH');
// collateral of the USDC, WETH and USDT markets
const WEETH = collateral('usdt', 'weETH');

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

// the fixture without one collateral of one market, which takes it out of that Comet
function withoutCollateral(key: string, address: string): NetworkV1[] {
  return snapshot.networks.map(network => ({
    ...network,
    markets: network.markets.map(market => market.deploymentKey !== key || network.chainId !== 1 ? market : {
      ...market,
      collateralAssets: market.collateralAssets
        .filter(asset => asset.token.address !== address)
        .map((asset, assetIndex) => ({ ...asset, assetIndex })),
    }),
  }));
}

async function switchTo(versionId: string, action: 'activate' | 'rollback' = 'activate'): Promise<void> {
  const response = await server.fetch(`/registry/v1/admin/versions/${versionId}/${action}`, {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ reason: `${action} for a legacy collateral test` }),
  });
  if (response.status !== 200) {
    throw new Error(`${action} of ${versionId} answered ${response.status}`);
  }
}

type Answer<T> = { status: number, header: (name: string) => string | null, body: T };

async function answerOf<T>(response: Response): Promise<Answer<T>> {
  return { status: response.status, header: name => response.headers.get(name), body: await response.json() as T };
}

async function read<T>(path: string, headers: Record<string, string> = auth): Promise<Answer<T>> {
  return answerOf<T>(await server.fetch(path, { headers }) as unknown as Response);
}

const legacyPath = (chainId: number, market: string, token: string) =>
  `/registry/v1/admin/networks/${chainId}/markets/${market}/collaterals/${token}/legacy`;

async function decide(market: string, token: string, body: unknown): Promise<Answer<LegacyCollateralResultV1>> {
  return answerOf<LegacyCollateralResultV1>(await server.fetch(legacyPath(1, market, token), {
    method:  'PATCH',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }) as unknown as Response);
}

async function count(db: D1Database, table: string, where: string = '1 = 1', ...bindings: unknown[]): Promise<number> {
  return await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...bindings).first<number>('n') ?? 0;
}

// the collaterals a public market read flags legacy, by symbol
async function flagged(market: string): Promise<string[]> {
  const { body } = await read<{ market: ActiveMarketV1 }>(`/registry/v1/networks/1/markets/${market}`, {});
  return body.market.collateralAssets.filter(asset => asset.isLegacy).map(asset => asset.token.symbol);
}

t.test('a decision is set, kept, and reversed, with one audit event per change', async t => {
  const env       = await freshEnv();
  const db        = env.APP_DB;
  const versionId = await seedValidated(db);
  await switchTo(versionId);
  const registryVersion = { id: versionId, checksum: snapshot.registryVersion.checksum };

  // checksummed addresses name the same collateral
  const set = await decide(checksumAddress(USDT), checksumAddress(METH), { isLegacy: true, reason: '  Linear COM-18  ' });
  t.equal(set.status, 200);
  t.match(set.body.updatedAt, ISO_TIME);
  t.same(set.body, {
    registryVersion,
    chainId:      1,
    cometAddress: USDT,
    tokenAddress: METH,
    isLegacy:     true,
    changed:      true,
    updatedAt:    set.body.updatedAt,
  }, 'the answer is the decision in force, for the lowercase Comet and token');
  t.equal(set.header('x-registry-version'), versionId, 'and names the version it was checked against');
  t.equal(set.header('access-control-allow-origin'), null, 'an administrative answer carries no CORS header');
  t.same(await flagged(USDT), [ 'mETH' ], 'the market reads flag the collateral at once');

  const again = await decide(USDT, METH, { isLegacy: true, reason: 'again' });
  t.same([ again.body.changed, again.body.isLegacy, again.body.updatedAt ], [ false, true, set.body.updatedAt ],
    'asking for the decision in force changes nothing and keeps its time');

  const undecided = await decide(USDT, WEETH, { isLegacy: false, reason: 'reviewed, still current' });
  t.same([ undecided.body.changed, undecided.body.isLegacy, undecided.body.updatedAt ], [ false, false, null ],
    'a collateral nobody decided about is already not legacy, and has no decision to date');

  const reversed = await decide(USDT, METH, { isLegacy: false, reason: 'listed again' });
  t.same([ reversed.body.changed, reversed.body.isLegacy ], [ true, false ], 'a decision is reversed by the opposite one');
  t.same(await flagged(USDT), [], 'and the market reads stop flagging it');

  const detail = await read<LegacyCollateralDetailV1>(legacyPath(1, USDT, METH));
  t.equal(detail.status, 200);
  t.same(
    {
      inActiveVersion: detail.body.inActiveVersion,
      isLegacy:        detail.body.isLegacy,
      updatedAt:       detail.body.updatedAt,
      updatedBy:       detail.body.updatedBy,
    },
    { inActiveVersion: true, isLegacy: false, updatedAt: reversed.body.updatedAt, updatedBy: actorOf(env) },
    'the collateral reads back with the decision in force and who made it',
  );
  t.same(
    detail.body.events.map(event => [ event.previousIsLegacy, event.isLegacy, event.actor, event.reason ]),
    [
      [ true, false, actorOf(env), 'listed again' ],
      [ null, true,  actorOf(env), 'Linear COM-18' ],
    ],
    'with every change newest first, each with its actor and its trimmed reason',
  );

  t.same(
    (await db.prepare(`SELECT chain_id, comet_address, token_address, is_legacy, updated_at FROM legacy_collaterals`).all()).results,
    [ { chain_id: 1, comet_address: USDT, token_address: METH, is_legacy: 0, updated_at: reversed.body.updatedAt } ],
    'the database holds one row, for the one collateral decided about',
  );
  t.equal(await count(db, 'legacy_collateral_events'), 2, 'and one event per change, none for the requests that changed nothing');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

t.test('identical requests racing for one collateral write one change', async t => {
  const { APP_DB: db } = await freshEnv();
  await switchTo(await seedValidated(db));

  const answers = await Promise.all(Array.from({ length: 5 }, () => decide(USDC, WEETH, { isLegacy: true, reason: 'raced' })));
  t.same(answers.map(answer => answer.status), [ 200, 200, 200, 200, 200 ], 'every request succeeds');
  t.equal(answers.filter(answer => answer.body.changed).length, 1, 'one of them changed the decision');
  t.equal(new Set(answers.map(answer => answer.body.updatedAt)).size, 1, 'and every one answers with the decision it made');
  t.equal(await count(db, 'legacy_collateral_events'), 1, 'which is audited once');
});

t.test('a decision outlives the version it was made under', async t => {
  const env   = await freshEnv();
  const db    = env.APP_DB;
  const first = await seedValidated(db);
  await switchTo(first);

  const meth = await decide(USDT, METH, { isLegacy: true, reason: 'Linear COM-18' });
  t.equal(meth.body.changed, true);

  const second = await seedValidated(db, withoutCollateral('usdt', METH), randomUUID());
  await switchTo(second);

  const exported = await read<LegacyCollateralListV1 & { retained: RetainedLegacyCollateralV1[] }>('/registry/v1/admin/legacy-collaterals');
  t.equal(exported.body.registryVersion?.id, second, 'the export is of the version switched on');
  t.notOk(exported.body.collaterals.some(row => row.cometAddress === USDT && row.tokenAddress === METH),
    'a collateral the version dropped from its Comet is not listed');
  t.same(exported.body.retained, [
    { chainId: 1, cometAddress: USDT, tokenAddress: METH, isLegacy: true, updatedAt: meth.body.updatedAt, updatedBy: actorOf(env) },
  ], 'but its decision is, as one kept until a version brings the collateral back');

  const kept = await read<LegacyCollateralDetailV1>(legacyPath(1, USDT, METH));
  t.same([ kept.status, kept.body.inActiveVersion, kept.body.isLegacy, kept.body.events.length ], [ 200, false, true, 1 ],
    'and the decision and its history stay readable meanwhile');
  t.equal((await decide(USDT, METH, { isLegacy: false, reason: 'listed again' })).status, 404,
    'though it cannot be decided about while the Comet does not take the token');

  await switchTo(first, 'rollback');
  const restored = await read<LegacyCollateralDetailV1>(legacyPath(1, USDT, METH));
  t.same([ restored.status, restored.body.inActiveVersion, restored.body.isLegacy, restored.body.updatedAt ],
    [ 200, true, true, meth.body.updatedAt ],
    'a version that brings the collateral back brings its decision back with it, in force again');
  t.same(await flagged(USDT), [ 'mETH' ], 'and the market reads flag it again');
});

/*
 * A request reads the active version, finds the collateral, and writes. Here
 * the version switches between the two, which the repository's own write is
 * the only place to observe: the trigger checks membership inside the write's
 * transaction, so the event is rolled back with the row.
 */
t.test('an activation that drops the collateral between the read and the write aborts the write', async t => {
  const { APP_DB: db } = await freshEnv();
  await switchTo(await seedValidated(db));
  await switchTo(await seedValidated(db, withoutCollateral('usdt', METH), randomUUID()));

  const change = { chainId: 1, cometAddress: USDT, tokenAddress: METH, actor: 'test-admin', reason: 'raced an activation' } as const;
  await t.rejects(() => writeLegacyCollateral(db, { ...change, isLegacy: true }), { code: 'CONFLICT', message: /left the collateral of/ },
    'a change for a collateral the active version no longer holds is refused');
  t.equal(await count(db, 'legacy_collateral_events'), 0, 'and its event is rolled back with it');
  t.equal(await count(db, 'legacy_collaterals'), 0, 'as is the row');

  await t.rejects(() => writeLegacyCollateral(db, { ...change, isLegacy: false }), { code: 'CONFLICT' },
    'a request that would change nothing is refused too, rather than answered for a version that does not hold the collateral');
});

const REVIEW = '/registry/v1/admin/legacy-collaterals/review';
const APPLY  = '/registry/v1/admin/legacy-collaterals/apply';

async function post<T>(path: string, body: unknown): Promise<Answer<T>> {
  return answerOf<T>(await server.fetch(path, {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }) as unknown as Response);
}

/*
 * The document the runbook gives an operator to apply once per environment:
 * the first JSON block under its heading, read as the operator copies it.
 */
function seedDocument(): LegacyCollateralListV1 {
  const runbook = readFileSync('./REGISTRY_RUNBOOK.md', 'utf8');
  const section = runbook.slice(runbook.indexOf('### The initial list of legacy collaterals'));
  return JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)![1]!);
}

/*
 * The seed document of the runbook applies to the fixture, whose mainnet
 * holds the USDC, WETH, USDT and WBTC markets: exactly as written, with every
 * address resolved, the Comets' deployment keys and the tokens' symbols
 * checked, and nothing else touched. The export is a file review and apply
 * take back as it is.
 */
t.test('the seed document of the runbook is reviewed and applied as one', async t => {
  const env       = await freshEnv();
  const db        = env.APP_DB;
  const versionId = await seedValidated(db);
  await switchTo(versionId);
  const seed = seedDocument();

  t.same(
    seed.collaterals.map(row => `${row.deploymentKey}/${row.symbol}`),
    [
      'usdt/mETH', 'usdt/weETH', 'usdt/sdeUSD', 'usdt/wUSDM', 'usdt/deUSD', 'usdt/USDe',
      'usdc/rsETH', 'usdc/USDe', 'usdc/deUSD', 'usdc/sdeUSD',
      'wbtc/LBTC', 'wbtc/pumpBTC',
    ],
    'the document names the twelve pairs the repository resolves, in the order the frontend lists them',
  );
  t.ok(seed.collaterals.every(row => row.chainId === 1 && row.isLegacy === true), 'all on mainnet, all legacy');

  const review = await post<LegacyCollateralReviewV1>(REVIEW, seed);
  t.equal(review.status, 200);
  t.same(review.body.summary, { change: 12, unchanged: 0, problems: 0 }, 'every pair is a collateral of its Comet, and changes');
  t.equal(await count(db, 'legacy_collateral_events'), 0, 'and the review writes nothing');

  const applied = await post<LegacyCollateralApplyV1>(APPLY, seed);
  t.equal(applied.status, 200);
  t.same(applied.body.summary, { changed: 12, unchanged: 0 }, 'applying writes exactly the reviewed changes');
  t.equal(applied.header('x-registry-version'), versionId);
  t.same(
    (await db.prepare(`SELECT DISTINCT reason FROM legacy_collateral_events`).all<{ reason: string }>()).results?.map(row => row.reason),
    [ seed.reason ],
    'each with the document\'s reason',
  );
  t.same(await flagged(USDT), [ 'wUSDM', 'mETH', 'weETH', 'sdeUSD', 'deUSD', 'USDe' ], 'the USDT market flags its six');
  t.same(await flagged(USDC), [ 'deUSD', 'sdeUSD', 'rsETH', 'USDe' ], 'the USDC market its four, and not its weETH');
  t.same(await flagged(WETH), [], 'and the WETH market, which the list does not name, none');

  const again = await post<LegacyCollateralApplyV1>(APPLY, seed);
  t.same(again.body.summary, { changed: 0, unchanged: 12 }, 'applying the document again changes nothing');
  t.equal(await count(db, 'legacy_collateral_events'), 12, 'and records nothing');

  const exported = await read<LegacyCollateralListV1>('/registry/v1/admin/legacy-collaterals');
  t.equal(exported.status, 200);
  t.equal(exported.header('x-registry-version'), versionId, 'the export names the version it lists');
  t.equal(exported.body.reason, null, 'with a place for the reason of the changes');
  const every = mainnet.markets.flatMap(market => market.collateralAssets.map(asset => `${market.contracts.comet}:${asset.token.address}`));
  t.same(exported.body.collaterals.filter(row => row.chainId === 1).map(row => `${row.cometAddress}:${row.tokenAddress}`).sort(), every.sort(),
    'and every collateral of every market of mainnet, once');
  t.same(exported.body.collaterals.filter(row => row.isLegacy).length, 12, 'twelve of them legacy');
  t.same(exported.body.collaterals.find(row => row.cometAddress === USDT && row.tokenAddress === METH),
    { chainId: 1, cometAddress: USDT, deploymentKey: 'usdt', tokenAddress: METH, symbol: 'mETH', isLegacy: true },
    'each with its market, its symbol, and the decision in force');

  const untouched = await post<LegacyCollateralReviewV1>(REVIEW, exported.body);
  t.equal(untouched.status, 200, 'the export is a list review takes back as it is');
  t.same(untouched.body.summary, { change: 0, unchanged: exported.body.collaterals.length, problems: 0 }, 'and it changes nothing');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

t.test('a list with any problem is refused whole, and its problems are named row by row', async t => {
  const { APP_DB: db } = await freshEnv();
  await switchTo(await seedValidated(db));

  const list = {
    reason:      null,
    collaterals: [
      { chainId: 1,  cometAddress: USDT, deploymentKey: 'usdt', tokenAddress: METH, symbol: 'mETH', isLegacy: true, reason: 'COM-18' },
      { chainId: 10, cometAddress: USDT, tokenAddress: METH, isLegacy: true, reason: 'COM-18' },
      { chainId: 1,  cometAddress: `0x${'0'.repeat(39)}1`, tokenAddress: METH, isLegacy: true, reason: 'COM-18' },
      { chainId: 1,  cometAddress: USDC, tokenAddress: METH, isLegacy: true, reason: 'COM-18' },
      { chainId: 1,  cometAddress: USDC, deploymentKey: 'usdt', tokenAddress: WEETH, isLegacy: true, reason: 'COM-18' },
      { chainId: 1,  cometAddress: WETH, tokenAddress: WEETH, symbol: 'eETH', isLegacy: true, reason: 'COM-18' },
      { chainId: 1,  cometAddress: USDT, tokenAddress: WEETH, isLegacy: true },
    ],
  };
  const review = await post<LegacyCollateralReviewV1>(REVIEW, list);
  t.equal(review.status, 200, 'a review answers with the problems as part of the diff');
  t.same(review.body.collaterals.map(row => [ row.row, row.problem ]), [
    [ 1, null ],
    [ 2, 'chain 10 is not part of the active registry' ],
    [ 3, `0x${'0'.repeat(39)}1 is not a market of the active registry on chain 1` ],
    [ 4, `${METH} is not a collateral of ${USDC} in the active registry on chain 1` ],
    [ 5, `the list names ${USDC} usdt, which the active registry calls usdc` ],
    [ 6, `the list names ${WEETH} eETH, which the active registry calls weETH` ],
    [ 7, `${WEETH} (weETH of usdt) changes, and needs a reason: its own or the list's` ],
  ], 'a missing chain, a missing Comet, a token that Comet does not take, a market and a symbol that are another\'s, and a change without a reason');
  t.equal(review.body.summary.problems, 6);

  const refused = await post<{ error: { code: string, details: { registryVersion: { id: string }, problems: Array<{ row: number }> } } }>(
    APPLY, list);
  t.equal(refused.status, 422, 'apply refuses a list with any problem');
  t.same(refused.body.error.details.problems.map(problem => problem.row), [ 2, 3, 4, 5, 6, 7 ], 'naming every row it refuses');
  t.equal(await count(db, 'legacy_collateral_events'), 0, 'and writes nothing, not even the rows that were fine');
});

/*
 * What a review cannot see: the version switching, or someone else deciding,
 * between the review and the write. The write runs without its review here,
 * which is how such a race reaches it; it writes all of the list or none.
 */
t.test('a list that meets an activation or another decision while it is written writes nothing', async t => {
  const { APP_DB: db } = await freshEnv();
  await switchTo(await seedValidated(db));
  await decide(USDC, WEETH, { isLegacy: true, reason: 'decided before the switch' });
  await switchTo(await seedValidated(db, withoutCollateral('usdt', METH), randomUUID()));
  const events = await count(db, 'legacy_collateral_events');

  const decisions = (rows: Array<[ string, string, boolean, string | null ]>): DecisionList => ({
    reason:    null,
    decisions: rows.map(([ cometAddress, tokenAddress, isLegacy, reason ]) => ({
      chainId:       1,
      cometAddress:  cometAddress as `0x${string}`,
      deploymentKey: null,
      tokenAddress:  tokenAddress as `0x${string}`,
      symbol:        null,
      isLegacy,
      reason,
    })),
  });

  await t.rejects(
    () => writeLegacyCollateralList(db, decisions([ [ USDT, WEETH, true, 'COM-18' ], [ USDT, METH, true, 'COM-18' ] ]), 'test-admin'),
    { code: 'CONFLICT', message: /activated while it was being applied; nothing was written/ },
    'a change for a collateral the active version no longer holds aborts the list',
  );
  await t.rejects(
    () => writeLegacyCollateralList(db, decisions([ [ USDT, WEETH, true, 'COM-18' ], [ USDT, METH, false, null ] ]), 'test-admin'),
    { code: 'CONFLICT', message: /activated while it was being applied/ },
    'and so does a row that changes nothing, once its collateral is gone',
  );
  await t.rejects(
    () => writeLegacyCollateralList(db, decisions([ [ USDT, WEETH, true, 'COM-18' ], [ USDC, WEETH, false, null ] ]), 'test-admin'),
    { code: 'CONFLICT', message: /changed by someone else while it was being applied/ },
    'as does a row without a reason whose decision is not the one the list states',
  );
  t.equal(await count(db, 'legacy_collateral_events'), events, 'none of them wrote anything');
  t.equal(await count(db, 'legacy_collaterals', 'comet_address = ?1', USDT), 0, 'not even the rows that were fine');
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
 * window aborts the list instead of being reverted by it.
 */
t.test('a decision made while a list is being applied aborts the list, rather than being reverted', async t => {
  const { APP_DB: db } = await freshEnv();
  await switchTo(await seedValidated(db));
  const list: DecisionList = {
    reason:    'Linear COM-18',
    decisions: [
      { chainId: 1, cometAddress: USDT, deploymentKey: null, tokenAddress: METH,  symbol: null, isLegacy: true,  reason: null },
      { chainId: 1, cometAddress: USDC, deploymentKey: null, tokenAddress: WEETH, symbol: null, isLegacy: false, reason: null },
    ],
  };
  const racing = beforeFirstBatch(db, () => decide(USDC, WEETH, { isLegacy: true, reason: 'decided meanwhile' }));

  await t.rejects(() => applyLegacyCollaterals(racing, list, 'test-admin'),
    { code: 'CONFLICT', message: /changed by someone else while it was being applied; nothing was written/ });
  t.equal(await count(db, 'legacy_collaterals', 'token_address = ?1', METH), 0, 'nothing of the list is written');
  t.equal(
    await db.prepare(`SELECT is_legacy FROM legacy_collaterals WHERE comet_address = ?1 AND token_address = ?2`).bind(USDC, WEETH).first<number>('is_legacy'),
    1,
    'and the decision made meanwhile stands',
  );
});
