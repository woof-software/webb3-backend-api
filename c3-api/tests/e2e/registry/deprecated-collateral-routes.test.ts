import t from 'tap';

import { activateVersion } from '../../../src/registry/repository.js';

import { loadRegistrySnapshotFixture, seedCandidate, validateSeeded } from '../../util/registry-fixture.js';
import { registryHarness } from '../../util/registry-harness.js';
import { ADMIN_TOKEN } from '../../util/test-env.js';

/*
 * What the deprecated collateral routes refuse, through the real worker: a
 * caller without the token, a malformed request, a chain, a Comet or a
 * collateral the active registry does not hold, a registry with nothing
 * active, and a database without the migration. Every refusal writes nothing.
 *
 * The token list is among the reads refused for a missing migration, and it
 * values collateral beside reading its decisions, so the node is one that
 * refuses every connection: a developer's .dev.vars may name a real one.
 */
const harness = await registryHarness({
  admin: true,
  vars:  { NODE_PROXY_HOST: '127.0.0.1:1', NODE_PROXY_KEY: '' },
});
const { server } = harness;

const snapshot = loadRegistrySnapshotFixture();
const auth     = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };
const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;
const market   = (key: string) => mainnet.markets.find(entry => entry.deploymentKey === key)!;
const USDT     = market('usdt').contracts.comet!;
const USDC     = market('usdc').contracts.comet!;
// collateral of the USDT market alone
const METH     = market('usdt').collateralAssets.find(asset => asset.token.symbol === 'mETH')!.token.address;
// the base of the USDC market, which no market of the fixture takes as collateral there
const USDC_TOKEN = market('usdc').baseAsset.token.address;

type ErrorBody = { error: { code: string, message: string, details?: { registryVersion?: { id: string }, problems?: string[] } } };

async function freshDatabase(
  { activate, through }: { activate: boolean, through?: string },
): Promise<{ db: D1Database, versionId: string }> {
  const db = await harness.freshDatabase({ through });
  const { versionId } = await seedCandidate(db, snapshot);
  await validateSeeded(db, versionId);
  if (activate) {
    await activateVersion(db, { versionId, action: 'activate', actor: 'test-seed', reason: 'seeded for a deprecated collateral test' });
  }
  return { db, versionId };
}

const deprecatedPath = (chainId: string | number, comet: string, token: string) =>
  `/registry/v1/admin/networks/${chainId}/markets/${comet}/collaterals/${token}/deprecated`;

function send(method: string, path: string, body: unknown, headers: Record<string, string> = auth) {
  return server.fetch(path, {
    method,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body:    typeof(body) === 'string' ? body : JSON.stringify(body),
  });
}

async function written(db: D1Database): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM deprecated_collateral_events`).first<number>('n') ?? 0)
       + (await db.prepare(`SELECT COUNT(*) AS n FROM deprecated_collaterals`).first<number>('n') ?? 0);
}

const EXPORT = '/registry/v1/admin/deprecated-collaterals';
const REVIEW = '/registry/v1/admin/deprecated-collaterals/review';
const APPLY  = '/registry/v1/admin/deprecated-collaterals/apply';

t.test('the deprecated collateral routes are behind the token and closed to browsers', async t => {
  const { db } = await freshDatabase({ activate: true });

  const anonymous = await send('PATCH', deprecatedPath(1, USDT, METH), { isDeprecated: true, reason: 'x' }, {});
  t.equal(anonymous.status, 401, 'a change without the token is refused');
  t.equal(anonymous.headers.get('access-control-allow-origin'), null, 'without a CORS header');
  t.equal((await server.fetch(deprecatedPath(1, USDT, METH))).status, 401, 'and so is a read of one collateral');
  t.equal((await server.fetch(EXPORT)).status, 401, 'an export');
  t.equal((await send('POST', APPLY, { collaterals: [] }, {})).status, 401, 'and an apply');

  const wrongVerb = await send('POST', deprecatedPath(1, USDT, METH), {});
  t.equal(wrongVerb.status, 405, 'a decision is changed with PATCH');
  t.equal(wrongVerb.headers.get('allow'), 'GET, PATCH, OPTIONS', 'and the refusal says which verbs the path takes');
  const wrongListVerb = await server.fetch(APPLY, { headers: auth });
  t.equal(wrongListVerb.status, 405, 'a list is applied with POST');
  t.equal(wrongListVerb.headers.get('allow'), 'POST, OPTIONS');

  const preflight = await server.fetch(deprecatedPath(1, USDT, METH), { method: 'OPTIONS' });
  t.equal(preflight.status, 204);
  t.equal(preflight.headers.get('access-control-allow-origin'), null, 'a preflight advertises nothing to a browser');

  t.equal(await written(db), 0, 'nothing was written');
});

/*
 * Until migration 0007 these routes were …/legacy and
 * /admin/legacy-collaterals, with isLegacy. API.md and the runbook tell a
 * caller of the old ones that they are gone, so nothing may answer them in
 * place of the new ones, nor take the old flag.
 */
t.test('the paths and the flag of legacy collaterals are not taken any more', async t => {
  const { db } = await freshDatabase({ activate: true });
  const oldPath = `/registry/v1/admin/networks/1/markets/${USDT}/collaterals/${METH}/legacy`;
  const oldList = { collaterals: [ { chainId: 1, cometAddress: USDT, tokenAddress: METH, isLegacy: true } ] };

  for (const [ name, response ] of [
    [ 'a read of one collateral', await server.fetch(oldPath, { headers: auth }) ],
    [ 'a change',                 await send('PATCH', oldPath, { isLegacy: true, reason: 'COM-18' }) ],
    [ 'the export',               await server.fetch('/registry/v1/admin/legacy-collaterals', { headers: auth }) ],
    [ 'review',                   await send('POST', '/registry/v1/admin/legacy-collaterals/review', oldList) ],
    [ 'apply',                    await send('POST', '/registry/v1/admin/legacy-collaterals/apply', oldList) ],
  ] as const) {
    t.equal(response.status, 404, `${name} at the old path is not found`);
    const body = await response.json() as ErrorBody;
    t.equal(body.error.code, 'NOT_FOUND');
    t.match(body.error.message, /^no registry route matches \/registry\/v1\/admin\/.*legacy/, 'as a path no route takes');
  }

  const flag = await send('PATCH', deprecatedPath(1, USDT, METH), { isLegacy: true, reason: 'COM-18' });
  t.equal(flag.status, 400, 'a change that sends the old flag is refused');
  t.match((await flag.json() as ErrorBody).error.message, /unexpected properties: isLegacy/);

  const row = await send('POST', REVIEW, oldList);
  t.equal(row.status, 400, 'and so is a list whose rows send it');
  t.same((await row.json() as ErrorBody).error.details?.problems,
    [ 'row 1 has unexpected properties: isLegacy', 'row 1: isDeprecated must be a boolean' ]);

  t.equal(await written(db), 0, 'nothing was written');
});

t.test('a decision about a collateral is checked before anything is written', async t => {
  const { db, versionId } = await freshDatabase({ activate: true });
  const valid = { isDeprecated: true, reason: 'Linear COM-18' };

  // the path is read the same way by the read and the change, so it is probed through the read
  for (const chainId of [ '0', '-1', 'mainnet', '1.5', '01', '9007199254740993' ]) {
    const refused = await server.fetch(deprecatedPath(chainId, USDT, METH), { headers: auth });
    t.equal(refused.status, 400, `chain id ${chainId} is refused`);
    t.equal((await refused.json() as ErrorBody).error.message, `${chainId} is not a chain id`);
  }
  for (const address of [ 'usdt', `${USDT}00` ]) {
    t.equal((await server.fetch(deprecatedPath(1, address, METH), { headers: auth })).status, 400, `Comet ${address} is refused`);
    t.equal((await server.fetch(deprecatedPath(1, USDT, address), { headers: auth })).status, 400, `token ${address} is refused`);
  }

  const bodies: Array<[ string, unknown, RegExp ]> = [
    [ 'an empty body',                 {},                                                /isDeprecated must be a boolean/ ],
    [ 'a value that is not a boolean', { isDeprecated: 'true', reason: 'x' },                 /isDeprecated must be a boolean/ ],
    [ 'a missing reason',              { isDeprecated: true },                                /reason/ ],
    [ 'a blank reason',                { isDeprecated: true, reason: '   ' },                 /reason/ ],
    [ 'an unbounded reason',           { isDeprecated: true, reason: 'x'.repeat(1001) },      /reason/ ],
    [ 'an actor of its own',           { isDeprecated: true, reason: 'x', actor: 'someone' }, /unexpected properties: actor/ ],
    [ 'a reason that starts with NUL', { isDeprecated: true, reason: '\u0000COM-18' },        /cannot contain a NUL character/ ],
    [ 'malformed JSON',                '{',                                               /not valid JSON/ ],
  ];
  for (const [ name, body, message ] of bodies) {
    const response = await send('PATCH', deprecatedPath(1, USDT, METH), body);
    t.equal(response.status, 400, `${name} is refused`);
    t.match((await response.json() as ErrorBody).error.message, message);
  }

  const chain = await send('PATCH', deprecatedPath(10, USDT, METH), valid);
  t.equal(chain.status, 404, 'a chain the active registry does not hold is not found');
  const chainBody = await chain.json() as ErrorBody;
  t.match(chainBody.error.message, /chain 10 is not part of the active registry/);
  t.equal(chainBody.error.details?.registryVersion?.id, versionId, 'and the refusal names the version it was decided against');
  t.equal(chain.headers.get('x-registry-version'), versionId, 'in its headers too');

  const testnet = await send('PATCH', deprecatedPath(11155111, USDT, METH), valid);
  t.equal(testnet.status, 404, 'nor is a testnet, which the registry does not import');

  const comet = await send('PATCH', deprecatedPath(1, `0x${'0'.repeat(39)}1`, METH), valid);
  t.equal(comet.status, 404, 'nor a Comet no market of the chain has');
  t.match((await comet.json() as ErrorBody).error.message, /is not a market of the active registry on chain 1/);

  for (const [ name, cometAddress, token ] of [
    [ 'a token another market takes', USDC, METH ],
    [ 'the market\'s base',           USDC, USDC_TOKEN ],
  ] as const) {
    const response = await send('PATCH', deprecatedPath(1, cometAddress, token), valid);
    t.equal(response.status, 404, `nor ${name}, which is no collateral of the Comet`);
    t.match((await response.json() as ErrorBody).error.message, new RegExp(`${token} is not a collateral of ${cometAddress}`));
  }

  t.equal((await server.fetch(deprecatedPath(1, USDC, METH), { headers: auth })).status, 404,
    'nor the history of a collateral nobody decided about and the active version does not hold');

  t.equal(await written(db), 0, 'none of it wrote anything');
});

t.test('without an active version there is no collateral to decide about', async t => {
  const { db } = await freshDatabase({ activate: false });
  const list = { collaterals: [ { chainId: 1, cometAddress: USDT, tokenAddress: METH, isDeprecated: true, reason: 'COM-18' } ] };

  for (const [ name, response ] of [
    [ 'a change', await send('PATCH', deprecatedPath(1, USDT, METH), { isDeprecated: true, reason: 'COM-18' }) ],
    [ 'a read',   await server.fetch(deprecatedPath(1, USDT, METH), { headers: auth }) ],
    [ 'export',   await server.fetch(EXPORT, { headers: auth }) ],
    [ 'review',   await send('POST', REVIEW, list) ],
    [ 'apply',    await send('POST', APPLY, list) ],
  ] as const) {
    t.equal(response.status, 503, `${name} answers 503 without an active version`);
    t.equal((await response.json() as ErrorBody).error.code, 'REGISTRY_NOT_ACTIVE', 'with the versionless code');
    t.equal(response.headers.get('x-registry-version'), null, 'and no version it could name');
  }
  t.equal(await written(db), 0, 'nothing was written');
});

/*
 * A list is checked the same way by review and apply, so the shape is probed
 * through review, which spends no write budget, and once through apply.
 */
t.test('a list of decisions is checked completely before anything is read or written', async t => {
  const { db } = await freshDatabase({ activate: true });
  const row = { chainId: 1, cometAddress: USDT, tokenAddress: METH, isDeprecated: true };

  const shapes: Array<[ string, unknown, RegExp ]> = [
    [ 'a body without collaterals',     { reason: 'x' },                                   /collaterals must be a list of 1 to 500 decisions/ ],
    [ 'an empty list',                  { collaterals: [] },                               /collaterals must be a list of 1 to 500 decisions/ ],
    [ 'a list longer than 500',         { collaterals: Array.from({ length: 501 }, () => row) }, /collaterals must be a list of 1 to 500 decisions/ ],
    [ 'a property of its own',          { collaterals: [ row ], actor: 'someone' },        /unexpected properties: actor/ ],
    [ 'the token policies\' list',      { policies: [ row ] },                             /unexpected properties: policies/ ],
    [ 'a list reason that is not text', { reason: 5, collaterals: [ row ] },               /the list of deprecated collaterals is invalid/ ],
  ];
  for (const [ name, body, message ] of shapes) {
    const response = await send('POST', REVIEW, body);
    t.equal(response.status, 400, `${name} is refused`);
    t.match((await response.json() as ErrorBody).error.message, message);
  }

  const rows = await send('POST', REVIEW, {
    reason:      '\u0000COM-18',
    retained:    [ { anything: 'is not read' } ],
    collaterals: [
      'mETH',
      { ...row, note: 'x' },
      { chainId: '1', cometAddress: 'usdt', tokenAddress: '0x12', deploymentKey: 5, symbol: 5, isDeprecated: 'yes', reason: ' ' },
      { ...row, reason: 'x'.repeat(1001) },
      row,
      { ...row, cometAddress: USDT.toUpperCase().replace('0X', '0x'), tokenAddress: METH.toUpperCase().replace('0X', '0x') },
    ],
  });
  t.equal(rows.status, 400, 'a list with malformed rows is refused');
  t.same((await rows.json() as ErrorBody).error.details?.problems, [
    'reason cannot contain a NUL character',
    'row 1 must be an object',
    'row 2 has unexpected properties: note',
    'row 3: chainId must be a positive integer',
    'row 3: cometAddress must be an address',
    'row 3: deploymentKey must be null or a string',
    'row 3: tokenAddress must be an address',
    'row 3: symbol must be null or a string',
    'row 3: isDeprecated must be a boolean',
    'row 3: reason must be null or a non-empty string of at most 1000 characters',
    'row 4: reason must be null or a non-empty string of at most 1000 characters',
    `row 6 repeats row 5 (chain 1, ${USDT}, ${METH})`,
  ], 'naming every problem of every row at once, a repeated collateral in any case included, and reading nothing of what is retained');

  t.equal((await send('POST', APPLY, { collaterals: [ { ...row, isDeprecated: 'yes' } ] })).status, 400, 'apply checks a list the same way');

  /*
   * A reviewed list may carry a reason on every row, which is more than an
   * ordinary command's body allows: these routes take up to a mebibyte.
   */
  const collaterals = Array.from({ length: 80 }, (_, index) => ({ ...row, chainId: index + 1, isDeprecated: false, reason: 'r'.repeat(1000) }));
  t.ok(JSON.stringify({ collaterals }).length > 64 * 1024, 'a list past the ordinary 64 KiB');
  t.equal((await send('POST', REVIEW, { collaterals })).status, 200, 'is read, and reviewed');

  t.equal(await written(db), 0, 'none of it wrote anything');
});

/*
 * A release deployed before its migration finds the deprecated collateral
 * tables missing, and every route that reads them says so, with what to do
 * about it: the administrative routes, the active reads and the token list.
 * A database migrated through 0006 holds them under the names 0007 changes,
 * which this release does not read, so it is one without them too.
 */
t.test('a database without the deprecated collateral migration says so', async t => {
  for (const through of [ '0005', '0006' ]) {
    await freshDatabase({ activate: true, through });

    for (const [ name, response ] of [
      [ 'the export',          await server.fetch(EXPORT, { headers: auth }) ],
      [ 'a change',            await send('PATCH', deprecatedPath(1, USDT, METH), { isDeprecated: true, reason: 'COM-18' }) ],
      [ 'the bootstrap read',  await server.fetch('/registry/v1/active') ],
      [ 'the market list',     await server.fetch('/registry/v1/networks/1/markets') ],
      [ 'a market',            await server.fetch(`/registry/v1/networks/1/markets/${USDT}`) ],
      [ 'the token list',      await server.fetch('/registry/v1/networks/1/tokens') ],
    ] as const) {
      t.equal(response.status, 503, `through ${through}: ${name} answers 503`);
      const body = await response.json() as ErrorBody;
      t.equal(body.error.code, 'UPSTREAM_UNAVAILABLE');
      t.match(body.error.message, /apply the D1 migrations/, 'naming the remedy');
    }
    t.equal((await server.fetch('/registry/v1/networks')).status, 200, 'while a read that marks no collateral answers as before');
  }
});
