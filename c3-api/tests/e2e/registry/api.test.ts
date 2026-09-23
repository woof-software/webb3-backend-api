import t from 'tap';

import { randomUUID } from 'node:crypto';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import {
  markValidated,
  recordValidationResults,
  snapshotChecksum,
} from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * The registry HTTP API, served by the real worker in workerd over local D1.
 *
 * These tests go through the router the way a client does, so they cover what
 * unit tests of the handlers cannot: the dispatch order against the legacy
 * four-segment matcher, the CORS and security headers the entrypoint adds,
 * authentication, and the error envelope.
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';

/*
 * The worker stores only the hash of the admin token, so the harness is given
 * the hash as a secret and the tests present the token itself.
 */
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

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

/*
 * Seeds the fixture as a validated version. Activation goes through the API
 * itself wherever a test is about activation.
 */
async function seedValidated(db: D1Database, versionId?: string): Promise<string> {
  const { versionId: id } = await seedCandidate(db, snapshot, versionId === undefined ? {} : { versionId, attempt: 2 });
  await recordValidationResults(db, id, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, id, await snapshotChecksum(snapshot.networks));
  return id;
}

type AdminRequest = { method: string, headers: Record<string, string>, body: string };

function admin(path: string, body: unknown = {}, token: string = ADMIN_TOKEN): [ string, AdminRequest ] {
  return [ path, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  } ];
}

t.test('the bootstrap read serves the active snapshot, or says there is none', async t => {
  const db = await freshDatabase();

  const missing = await server.fetch('/registry/v1/active');
  t.equal(missing.status, 503, 'without an active version the registry says so');
  const error = await missing.json() as { error: { code: string, requestId: string } };
  t.equal(error.error.code, 'REGISTRY_NOT_ACTIVE', 'with the versionless error code');
  t.match(error.error.requestId, /^[0-9a-f-]{36}$/, 'and a request id to correlate with the logs');
  t.equal(missing.headers.get('x-registry-version'), null, 'and no version headers: there is no version');

  const versionId = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'first activation' }));

  const response = await server.fetch('/registry/v1/active');
  t.equal(response.status, 200);
  t.equal(response.headers.get('x-registry-version'), versionId, 'the response names the version that answered');
  t.equal(response.headers.get('x-registry-checksum'), snapshot.registryVersion.checksum);
  t.equal(response.headers.get('access-control-allow-origin'), '*', 'public reads stay readable cross-origin');
  t.equal(response.headers.get('x-content-type-options'), 'nosniff', 'and keep the security headers');

  const body = await response.json() as typeof snapshot;
  t.equal(body.schemaVersion, 1);
  t.equal(body.registryVersion.id, versionId);
  t.same(body.networks, snapshot.networks, 'the payload is the snapshot that was stored');
});

t.test('a snapshot is cacheable by version and checksum', async t => {
  const db        = await freshDatabase();
  const versionId = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'activate' }));

  const first = await server.fetch('/registry/v1/active');
  const etag  = first.headers.get('etag');
  t.match(etag, /^"v1-snapshot-[0-9a-f-]+-[0-9a-f]{64}"$/,
    'the ETag identifies schema, representation, version, and checksum');
  t.match(first.headers.get('cache-control'), /max-age=300/, 'with the configured cache lifetime');

  /*
   * These routes serve different bodies from one version, so an ETag that
   * named the version alone would let a conditional request for one be
   * answered 304 while the client holds another's body.
   */
  const otherRoutes = await Promise.all([
    server.fetch('/registry/v1/networks'),
    server.fetch('/registry/v1/networks/1/markets'),
  ]);
  const etags = otherRoutes.map(response => response.headers.get('etag'));
  t.equal(new Set([ etag, ...etags ]).size, 3, 'each representation has its own ETag');

  for (const [ index, path ] of [ '/registry/v1/networks', '/registry/v1/networks/1/markets' ].entries()) {
    const crossed = await server.fetch(path, { headers: { 'If-None-Match': etag! } });
    t.equal(crossed.status, 200, `${path} does not accept the snapshot ETag`);
    const own = await server.fetch(path, { headers: { 'If-None-Match': etags[index]! } });
    t.equal(own.status, 304, `${path} accepts its own`);
  }

  const repeat = await server.fetch('/registry/v1/active', { headers: { 'If-None-Match': etag! } });
  t.equal(repeat.status, 304, 'an unchanged version answers 304');
  t.equal(repeat.headers.get('x-registry-version'), versionId, 'and still names the version');

  const stale = await server.fetch('/registry/v1/active', { headers: { 'If-None-Match': '"v1-other-version"' } });
  t.equal(stale.status, 200, 'a different ETag gets the body');
});

t.test('the convenience reads serve the same objects as the snapshot', async t => {
  const db        = await freshDatabase();
  const versionId = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'activate' }));

  const networks = await (await server.fetch('/registry/v1/networks')).json() as {
    registryVersion: { id: string, checksum: string },
    networks: Array<{ chainId: number, markets?: unknown }>,
  };
  t.same(networks.registryVersion, { id: versionId, checksum: snapshot.registryVersion.checksum });
  t.same(networks.networks.map(network => network.chainId), snapshot.networks.map(network => network.chainId), 'in chain id order');
  t.equal(networks.networks[0]!.markets, undefined, 'the summary leaves markets to the market routes');

  const markets = await (await server.fetch('/registry/v1/networks/1/markets')).json() as {
    chainId: number, markets: Array<{ deploymentKey: string }>,
  };
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  t.equal(markets.chainId, 1);
  t.same(
    markets.markets.map(market => market.deploymentKey),
    mainnet.markets.map(market => market.deploymentKey),
    'markets keep the snapshot order',
  );

  const comet  = mainnet.markets[0]!.contracts.comet!;
  const market = await (await server.fetch(`/registry/v1/networks/1/markets/${comet}`)).json() as {
    market: { deploymentKey: string },
  };
  t.equal(market.market.deploymentKey, mainnet.markets[0]!.deploymentKey, 'a market is addressed by its Comet');

  const mixedCase = await server.fetch(`/registry/v1/networks/1/markets/${comet.toUpperCase().replace('0X', '0x')}`);
  t.equal(mixedCase.status, 200, 'and the address is matched case-insensitively');

  t.equal((await server.fetch('/registry/v1/networks/999/markets')).status, 404, 'an unknown chain is a 404');
  t.equal((await server.fetch('/registry/v1/networks/1/markets/0x1234')).status, 400, 'a malformed address is a 400');
  t.equal((await server.fetch(`/registry/v1/networks/1/markets/${'0x' + '9'.repeat(40)}`)).status, 404, 'an unknown market is a 404');
  t.equal((await server.fetch('/registry/v1/unknown')).status, 404, 'an unknown registry route is a 404');
  const wrongMethod = await server.fetch('/registry/v1/active', { method: 'POST' });
  t.equal(wrongMethod.status, 405, 'a public read refuses other methods');
  t.equal(wrongMethod.headers.get('allow'), 'GET, HEAD, OPTIONS', 'and says which ones it takes');
  t.equal(
    ((await wrongMethod.json()) as { error: { code: string } }).error.code,
    'METHOD_NOT_ALLOWED',
    'with a code that distinguishes it from a malformed request',
  );
});

/*
 * A disabled market is part of the stored version and visible to an operator,
 * but no public read may offer one: the market route refuses it and the
 * request catalog does not materialize it, so listing it would advertise
 * something unusable.
 */
t.test('a disabled market is not served by any public read', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await db.prepare(
    `UPDATE markets SET status = 'disabled'
     WHERE registry_version_id = ?1 AND deployment_key = 'weth'`
  ).bind(versionId).run();
  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, 'f'.repeat(64));
  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'activate' }));

  const weth = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
  const active = await (await server.fetch('/registry/v1/active')).json() as typeof snapshot;
  const mainnet = active.networks.find(network => network.chainId === 1)!;
  t.notOk(mainnet.markets.some(market => market.deploymentKey === 'weth'), 'the snapshot read leaves it out');

  const markets = await (await server.fetch('/registry/v1/networks/1/markets')).json() as {
    markets: Array<{ deploymentKey: string }>,
  };
  t.notOk(markets.markets.some(market => market.deploymentKey === 'weth'), 'and so does the market list');
  t.equal((await server.fetch(`/registry/v1/networks/1/markets/${weth}`)).status, 404,
    'while the market route already refused it');
});

t.test('a retained version can be refetched by id', async t => {
  const db      = await freshDatabase();
  const first   = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${first}/activate`, { reason: 'activate' }));
  const second  = await seedValidated(db, randomUUID());
  await server.fetch(...admin(`/registry/v1/admin/versions/${second}/activate`, { reason: 'activate the second' }));

  const pinned = await server.fetch(`/registry/v1/versions/${first}`);
  t.equal(pinned.status, 200, 'the version a session pinned is still served');
  const body = await pinned.json() as typeof snapshot;
  t.equal(body.registryVersion.id, first, 'even though another version is active');

  t.equal((await server.fetch(`/registry/v1/versions/${randomUUID()}`)).status, 404, 'an unknown version is a 404');
});

t.test('administrative routes are authenticated and closed to browsers', async t => {
  const db        = await freshDatabase();
  const versionId = await seedValidated(db);

  const anonymous = await server.fetch(`/registry/v1/admin/versions/${versionId}`);
  t.equal(anonymous.status, 401, 'an unauthenticated read is refused');
  t.equal(anonymous.headers.get('access-control-allow-origin'), null, 'and carries no CORS header');
  t.equal(anonymous.headers.get('x-content-type-options'), 'nosniff', 'but keeps the security headers');

  const wrongToken = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'x' }, 'not-the-token'));
  t.equal(wrongToken.status, 401, 'a wrong token is refused');

  const wrongMethod = await server.fetch(`/registry/v1/admin/versions/${versionId}`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body:    '{}',
  });
  t.equal(wrongMethod.status, 405, 'an administrative path refuses another verb');
  t.equal(wrongMethod.headers.get('allow'), 'GET, OPTIONS', 'and says which one it takes');

  /*
   * Which administrative paths exist, and which verbs they take, is behind the
   * token as well: an anonymous caller is told the same thing everywhere.
   */
  const anonymousMethod = await server.fetch(`/registry/v1/admin/versions/${versionId}`, { method: 'POST', body: '{}' });
  t.equal(anonymousMethod.status, 401, 'without a token a wrong verb is refused as anything else is');
  t.equal(anonymousMethod.headers.get('allow'), null, 'and nothing says which verbs the path takes');

  const preflight = await server.fetch(`/registry/v1/admin/versions/${versionId}/activate`, { method: 'OPTIONS' });
  t.equal(preflight.status, 204);
  t.equal(preflight.headers.get('access-control-allow-origin'), null, 'an admin preflight advertises nothing');

  const publicPreflight = await server.fetch('/registry/v1/active', { method: 'OPTIONS' });
  t.equal(publicPreflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS', 'a public preflight does');

  const detail = await server.fetch(`/registry/v1/admin/versions/${versionId}`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  });
  t.equal(detail.status, 200, 'an authenticated read is served');
  const body = await detail.json() as { version: { id: string, status: string }, validation: { attempt: number } };
  t.equal(body.version.id, versionId);
  t.equal(body.version.status, 'validated');
  t.equal(body.validation.attempt, 1, 'with the validation attempt that decided it');
});

t.test('activation and rollback are idempotent and audited', async t => {
  const db     = await freshDatabase();
  const first  = await seedValidated(db);
  const second = await seedValidated(db, randomUUID());

  const activated = await server.fetch(...admin(`/registry/v1/admin/versions/${first}/activate`, { reason: 'first' }));
  t.equal(activated.status, 200);
  const result = await activated.json() as {
    action: string, changed: boolean, activationId: string | null,
    previousVersionId: string | null, targetVersionId: string,
  };
  t.equal(result.changed, true);
  t.equal(result.action, 'activate');
  t.equal(result.previousVersionId, null, 'the first activation has no predecessor');
  t.ok(result.activationId, 'and writes an audit row');

  const again = await server.fetch(...admin(`/registry/v1/admin/versions/${first}/activate`, { reason: 'again' }));
  const repeat = await again.json() as { changed: boolean, activationId: string | null };
  t.equal(repeat.changed, false, 'activating the active version changes nothing');
  t.equal(repeat.activationId, null, 'and writes no audit row');

  await server.fetch(...admin(`/registry/v1/admin/versions/${second}/activate`, { reason: 'second' }));
  const rolledBack = await server.fetch(...admin(`/registry/v1/admin/versions/${first}/rollback`, { reason: 'restore' }));
  const rollback = await rolledBack.json() as { action: string, previousVersionId: string | null, changed: boolean };
  t.equal(rollback.action, 'rollback');
  t.equal(rollback.previousVersionId, second, 'rollback records what it replaced');
  t.equal(rollback.changed, true);

  const active = await (await server.fetch('/registry/v1/active')).json() as typeof snapshot;
  t.equal(active.registryVersion.id, first, 'and the registry serves the restored version');

  const history = await db.prepare(
    `SELECT action FROM registry_activations ORDER BY rowid`
  ).all<{ action: string }>();
  t.same((history.results ?? []).map(row => row.action), [ 'activate', 'activate', 'rollback' ], 'every change is audited once');
});

t.test('administrative commands validate their bodies', async t => {
  const db        = await freshDatabase();
  const versionId = await seedValidated(db);

  const noReason = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, {}));
  t.equal(noReason.status, 400, 'a change without a reason is refused');

  const extra = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'x', actor: 'someone' }));
  t.equal(extra.status, 400, 'an actor cannot be supplied by the caller');
  const body = await extra.json() as { error: { message: string } };
  t.match(body.error.message, /unexpected properties: actor/);

  const malformed = await server.fetch(`/registry/v1/admin/versions/${versionId}/activate`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body:    '{',
  });
  t.equal(malformed.status, 400, 'a malformed body is refused');

  const unknown = randomUUID();
  const activating = await server.fetch(...admin(`/registry/v1/admin/versions/${unknown}/activate`, { reason: 'x' }));
  t.equal(activating.status, 404, 'activating an unknown version is not found, as reading it is');
  const restoring = await server.fetch(...admin(`/registry/v1/admin/versions/${unknown}/rollback`, { reason: 'x' }));
  t.equal(restoring.status, 404, 'and so is restoring one');

  const { versionId: importing } = await seedCandidate(await freshDatabase(), snapshot);
  const conflict = await server.fetch(...admin(`/registry/v1/admin/versions/${importing}/activate`, { reason: 'x' }));
  t.equal(conflict.status, 409, 'while one that exists but is not validated is a conflict');

  /*
   * A held import leaves the commit unimported until somebody acts on the
   * candidate, so it is a decision like pinning a commit, and the audit has
   * to say whose decision it was. The body is refused before anything is
   * asked of the source.
   */
  const held = await server.fetch(...admin('/registry/v1/admin/sync', { holdForReview: true }));
  t.equal(held.status, 400, 'holding a candidate open for review needs a reason');
  t.match((await held.json() as { error: { message: string } }).error.message, /reason/);
  const notBoolean = await server.fetch(...admin('/registry/v1/admin/sync', { holdForReview: 'yes', reason: 'x' }));
  t.equal(notBoolean.status, 400, 'and it is a boolean');
});

function put(path: string, body: unknown): [ string, AdminRequest ] {
  return [ path, {
    method:  'PUT',
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  } ];
}

t.test('an overlay is replaced completely, and only while importing', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);

  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const current = {
    displayName:               mainnet.displayName,
    assetDisplayOverrides:     mainnet.presentation.assetDisplayOverrides,
    unwrappedCollateralAssets: mainnet.presentation.unwrappedCollateralAssets,
    priceExceptions:           mainnet.priceExceptions,
  };

  const unchanged = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/networks/1/overlay`,
    { reason: 'no change', overlay: current },
  ));
  t.equal(unchanged.status, 200);
  const idempotent = await unchanged.json() as { changed: boolean, overlayEventId: string | null };
  t.equal(idempotent.changed, false, 'an identical replacement changes nothing');
  t.equal(idempotent.overlayEventId, null, 'and writes no audit event');

  const renamed = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/networks/1/overlay`,
    { reason: 'rename the network', overlay: { ...current, displayName: 'Ethereum Mainnet' } },
  ));
  const applied = await renamed.json() as { changed: boolean, overlayEventId: string, snapshotChecksum: string | null };
  t.equal(applied.changed, true, 'a reviewed change is applied');
  t.ok(applied.overlayEventId, 'with an audit event');
  t.equal(applied.snapshotChecksum, null, 'and the snapshot checksum is cleared until validation recomputes it');

  const stored = await db.prepare(
    `SELECT display_name FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1`
  ).bind(versionId).first<string>('display_name');
  t.equal(stored, 'Ethereum Mainnet', 'the stored network carries the reviewed name');

  const event = await db.prepare(
    `SELECT scope_type, scope_key, actor, reason, previous_digest, new_digest
     FROM registry_overlay_events WHERE registry_version_id = ?1`
  ).bind(versionId).first<{ scope_type: string, scope_key: string, actor: string, reason: string, previous_digest: string, new_digest: string }>();
  t.equal(event?.scope_type, 'network');
  t.equal(event?.scope_key, '1');
  t.equal(event?.reason, 'rename the network', 'the event records why');
  t.not(event?.previous_digest, event?.new_digest, 'and which overlay replaced which');

  const dropped = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/networks/1/overlay`,
    { reason: 'drop the exceptions', overlay: { ...current, priceExceptions: [] } },
  ));
  t.equal(dropped.status, 200);
  t.equal(
    await db.prepare(`SELECT COUNT(*) AS n FROM network_price_exceptions WHERE registry_version_id = ?1`)
      .bind(versionId).first<number>('n'),
    0,
    'a replacement states the whole overlay, so an omitted exception is removed',
  );

  const invalid = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/networks/1/overlay`,
    { reason: 'bad', overlay: { ...current, sortOrder: 2 } },
  ));
  t.equal(invalid.status, 400, 'an unknown overlay key is refused');

  /*
   * An import writes every network it reaches, reviewed or not, so a chain
   * missing here is one this candidate has not reached: the answer is to let
   * the import continue, and the route says so.
   */
  const unimportedChain = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/networks/999/overlay`,
    { reason: 'x', overlay: current },
  ));
  t.equal(unimportedChain.status, 404, 'a chain the version has not imported is a 404');
  t.match(
    ((await unimportedChain.json()) as { error: { message: string } }).error.message,
    /not been imported into this registry version yet/,
  );
});

/*
 * The overlay of a stored market reads back in the form its PUT takes, so a
 * market can be changed from what it carries, and a similar market is a
 * template for describing a new one.
 */
t.test('a market overlay reads back in the form it is written in', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  const auth = { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } };
  const path = `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`;

  const response = await server.fetch(path, auth);
  t.equal(response.status, 200);
  const read = await response.json() as { versionId: string, scope: string, reviewed: boolean, overlay: Record<string, unknown> };
  t.same({ versionId: read.versionId, scope: read.scope, reviewed: read.reviewed }, { versionId, scope: '1/usdc', reviewed: true });
  t.equal(read.overlay.contractName, 'cUSDCv3');

  const written = await server.fetch(...put(path, { reason: 'write back what was read', overlay: read.overlay }));
  t.equal(written.status, 200, 'the document it answers is one the PUT accepts');
  t.equal((await written.json() as { changed: boolean }).changed, false, 'and it changes nothing');

  await db.prepare(
    `UPDATE markets SET status = 'disabled', is_default = 0, reviewed = 0 WHERE registry_version_id = ?1 AND deployment_key = 'weth'`
  ).bind(versionId).run();
  const unreviewed = await (await server.fetch(`/registry/v1/admin/versions/${versionId}/markets/1/weth/overlay`, auth))
    .json() as { reviewed: boolean, overlay: { status: string } };
  t.same([ unreviewed.reviewed, unreviewed.overlay.status ], [ false, 'disabled' ],
    'a market nobody has reviewed answers with what its import wrote, and says so');

  t.equal((await server.fetch(`/registry/v1/admin/versions/${versionId}/markets/1/nope/overlay`, auth)).status, 404);
  t.equal((await server.fetch(path)).status, 401, 'and the route is authenticated');
  const wrongMethod = await server.fetch(path, { method: 'POST', headers: auth.headers });
  t.equal(wrongMethod.status, 405);
  t.equal(wrongMethod.headers.get('allow'), 'PUT, GET, OPTIONS', 'the path takes both verbs');
});

t.test('a market overlay carries the reviewed decisions', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);

  const market  = snapshot.networks.find(network => network.chainId === 1)!.markets
    .find(entry => entry.deploymentKey === 'usdc')!;
  const overlay = {
    displayName:          market.displayName,
    contractName:         market.contractName,
    slug:                 market.slug,
    isInstitutional:      market.isInstitutional,
    isDefault:            market.isDefault,
    status:               market.status,
    creationBlock:        market.creationBlock,
    collateralValueQuote: market.collateralValueQuote,
    capabilities:         market.capabilities,
    baseAsset: {
      displayName:         market.baseAsset.displayName,
      isWrappedNative:     market.baseAsset.isWrappedNative,
      usdPriceFeedAddress: market.baseAsset.usdPriceFeed?.address ?? null,
    },
    rewardPriceFeed: market.rewardAsset?.priceFeed === null || market.rewardAsset === null
      ? null
      : { address: market.rewardAsset.priceFeed.address, quote: market.rewardAsset.priceFeedQuote },
  };

  const unchanged = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`,
    { reason: 'no change', overlay },
  ));
  t.equal((await unchanged.json() as { changed: boolean }).changed, false, 'the stored overlay round trips');

  const deprecated = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`,
    { reason: 'deprecate the market', overlay: { ...overlay, status: 'deprecated', isDefault: false } },
  ));
  t.equal(deprecated.status, 200);
  const stored = await db.prepare(
    `SELECT status, is_default, display_name FROM markets WHERE registry_version_id = ?1 AND deployment_key = 'usdc' AND network_id = (
       SELECT id FROM registry_networks WHERE registry_version_id = ?1 AND chain_id = 1
     )`
  ).bind(versionId).first<{ status: string, is_default: number }>();
  t.equal(stored?.status, 'deprecated', 'the market is stored as reviewed');
  t.equal(stored?.is_default, 0);

  const missingKey = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`,
    { reason: 'incomplete', overlay: { ...overlay, capabilities: { rewards: true } } },
  ));
  t.equal(missingKey.status, 400, 'a partial overlay is refused');

  const unimported = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/nope/overlay`,
    { reason: 'x', overlay },
  ));
  t.equal(unimported.status, 404, 'a market the version has not imported is a 404');

  /*
   * A market written without a review is disabled and marked so. The version
   * says which ones are left, which is what an operator works through before
   * a version of a new environment can be offered.
   */
  await db.prepare(
    `UPDATE markets SET status = 'disabled', is_default = 0, reviewed = 0
     WHERE registry_version_id = ?1 AND deployment_key = 'weth'`
  ).bind(versionId).run();
  const detail = await (await server.fetch(`/registry/v1/admin/versions/${versionId}`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  })).json() as { unreviewed: { networks: number[], markets: string[] } };
  t.same(detail.unreviewed, { networks: [], markets: [ '1/weth' ] }, 'the version lists what nobody has reviewed');

  const weth = snapshot.networks.find(network => network.chainId === 1)!.markets
    .find(entry => entry.deploymentKey === 'weth')!;
  const reviewedWeth = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/weth/overlay`,
    { reason: 'review the market the import could not decide about', overlay: {
      displayName:          weth.displayName,
      contractName:         weth.contractName,
      slug:                 weth.slug,
      isInstitutional:      weth.isInstitutional,
      isDefault:            false,
      status:               'enabled',
      creationBlock:        weth.creationBlock,
      collateralValueQuote: weth.collateralValueQuote,
      capabilities:         weth.capabilities,
      baseAsset: {
        displayName:         weth.baseAsset.displayName,
        isWrappedNative:     weth.baseAsset.isWrappedNative,
        usdPriceFeedAddress: weth.baseAsset.usdPriceFeed?.address ?? null,
      },
      rewardPriceFeed: weth.rewardAsset?.priceFeed === null || weth.rewardAsset === null
        ? null
        : { address: weth.rewardAsset.priceFeed.address, quote: weth.rewardAsset.priceFeedQuote },
    } },
  ));
  t.equal(reviewedWeth.status, 200, 'reviewing it edits the rows the import wrote');
  const after = await (await server.fetch(`/registry/v1/admin/versions/${versionId}`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  })).json() as { unreviewed: { networks: number[], markets: string[] } };
  t.same(after.unreviewed.markets, [], 'and takes it off the list');

  /*
   * A feed the version already knows needs no chain read — but only on its
   * own network. The AERO feed below is stored for chain 8453; naming the
   * same address on chain 1 is a different contract, so its scale has to come
   * from chain 1, and with no node provider in this harness that read fails
   * rather than silently reusing the other chain's decimals.
   */
  const crossChain = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`,
    { reason: 'a feed address that exists on another chain', overlay: {
      ...overlay,
      status:    'enabled',
      isDefault: true,
      baseAsset: { ...overlay.baseAsset, usdPriceFeedAddress: '0xdb7edfa090061d9367cbeaf6be16ecbde596676c' },
    } },
  ));
  t.equal(crossChain.status, 503, 'the decimals are read from the market\'s own chain, not from another version row');

  // a terminal version is not writable
  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, await snapshotChecksum(snapshot.networks));
  const terminal = await server.fetch(...put(
    `/registry/v1/admin/versions/${versionId}/markets/1/usdc/overlay`,
    { reason: 'too late', overlay },
  ));
  t.equal(terminal.status, 409, 'a validated version can no longer be changed');
});

/*
 * Everything else about a version is read by its id, so an operator who has
 * run a few imports needs something that says which ids exist.
 */
t.test('the versions there are can be listed, newest first', async t => {
  const db = await freshDatabase();

  const empty = await (await server.fetch('/registry/v1/admin/versions', { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } })).json() as {
    activeVersionId: string | null, versions: unknown[],
  };
  t.same(empty, { activeVersionId: null, versions: [] }, 'an environment with no versions lists none');

  const active = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${active}/activate`, { reason: 'bringing it up' }));

  const candidate = await seedCandidate(db, snapshot, { versionId: randomUUID(), attempt: 2 });

  const listed = await (await server.fetch('/registry/v1/admin/versions', { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } })).json() as {
    activeVersionId: string,
    versions: Array<{
      id: string, status: string, attempt: number, isActive: boolean, snapshotChecksum: string | null,
      createdAt: string, validatedAt: string | null,
    }>,
  };
  t.equal(listed.activeVersionId, active, 'the listing names the version that is on');
  t.same(listed.versions.map(version => version.id).sort(), [ active, candidate.versionId ].sort(),
    'and every version there is');
  t.same(
    listed.versions.find(version => version.id === active),
    {
      id:               active,
      status:           'validated',
      attempt:          1,
      isActive:         true,
      sourceRepository: snapshot.registryVersion.sourceRepository.toLowerCase(),
      sourceCommitSha:  snapshot.registryVersion.sourceCommitSha,
      snapshotChecksum: snapshot.registryVersion.checksum,
      createdAt:        listed.versions.find(version => version.id === active)!.createdAt,
      validatedAt:      listed.versions.find(version => version.id === active)!.validatedAt,
      createdBy:        'test-seed',
    } as never,
    'with what each version was built from and what became of it',
  );

  const importing = await (await server.fetch('/registry/v1/admin/versions?status=importing', {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  })).json() as { versions: Array<{ id: string }> };
  t.same(importing.versions.map(version => version.id), [ candidate.versionId ], 'the listing filters by status');

  const one = await (await server.fetch('/registry/v1/admin/versions?limit=1', {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  })).json() as { versions: unknown[] };
  t.equal(one.versions.length, 1, 'and is bounded');

  for (const query of [ '?status=nonsense', '?limit=0', '?limit=1000', '?limit=half' ]) {
    t.equal(
      (await server.fetch(`/registry/v1/admin/versions${query}`, { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } })).status,
      400,
      `${query} is refused`,
    );
  }
  t.equal((await server.fetch('/registry/v1/admin/versions')).status, 401, 'the listing is behind the token');
});

t.test('a sync run reports its checkpoints without its lease owner', async t => {
  const db    = await freshDatabase();
  const runId = randomUUID();
  const now   = new Date().toISOString();

  await db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, trigger_kind, requested_by, status,
       lease_owner, lease_generation, lease_expires_at, expected_count, started_at
     ) VALUES (?1, ?2, 'main', 'scheduled', 'registry-cron', 'running', 'secret-owner-token', 1, ?3, 1, ?3)`
  ).bind(runId, 'a'.repeat(40), now).run();
  await db.prepare(
    `INSERT INTO sync_run_items (
       id, sync_run_id, root_path, source_blob_sha, root_checksum,
       upstream_network_key, deployment_key, status, attempts, claim_owner, claim_generation, last_error, created_at, updated_at
     ) VALUES (?1, ?2, 'deployments/mainnet/usdc/roots.json', ?3, ?4, 'mainnet', 'usdc', 'failed', 1, 'secret-owner-token', 1, 'CHAIN_REQUEST_FAILED: a node provider request failed', ?5, ?5)`
  ).bind(randomUUID(), runId, 'b'.repeat(40), '0'.repeat(64), now).run();

  const response = await server.fetch(`/registry/v1/admin/sync-runs/${runId}`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  });
  t.equal(response.status, 200);
  const body = await response.json() as { syncRun: Record<string, unknown>, items: Array<Record<string, unknown>> };
  t.equal(body.syncRun.status, 'running');
  t.equal(body.syncRun.expectedCount, 1);
  t.equal(body.items.length, 1);
  t.equal(body.items[0]!.status, 'failed');
  t.equal(body.items[0]!.lastError, 'CHAIN_REQUEST_FAILED: a node provider request failed', 'a checkpoint reports its diagnostic');

  const serialized = JSON.stringify(body);
  t.notMatch(serialized, /secret-owner-token/, 'but the lease and claim owners never leave the worker');
  t.ok(body.syncRun.leaseExpiresAt, 'while the expiry, which says when the run is resumable, does');

  t.equal(
    (await server.fetch(`/registry/v1/admin/sync-runs/${randomUUID()}`, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
    })).status,
    404,
  );
});

/*
 * What the chain said about a market can only be checked while it is being
 * imported. Validating the stored candidate afterwards must not lose it: the
 * schema reads the latest attempt alone, so an attempt without those checks
 * would let a candidate the import found wrong become validated.
 */
t.test('validating a candidate again keeps what the import heard from the chain', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);
  await recordValidationResults(db, versionId, 1, [
    { check_name: 'base-asset-matches-chain', scope: 'market:1/usdc', passed: 0, details: { chain: 'another token' } },
    { check_name: 'single-default-market',    scope: 'global',        passed: 1 },
  ]);

  const response = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, {}));
  t.equal(response.status, 422, 'a candidate the import found wrong cannot be validated');
  const result = await response.json() as {
    version: { status: string },
    summary: { attempt: number, failed: number, checks: Array<{ name: string, scope: string, passed: boolean }> },
  };
  t.equal(result.version.status, 'invalid');
  t.equal(result.summary.attempt, 2, 'the attempt is a new one');
  t.ok(
    result.summary.checks.some(check => check.name === 'base-asset-matches-chain' && !check.passed),
    'carrying forward the chain check that failed',
  );
});

t.test('validation can be re-run through the API', async t => {
  const db = await freshDatabase();
  const { versionId } = await seedCandidate(db, snapshot);

  const withReason = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, { reason: 'review' }));
  t.equal(withReason.status, 400, 'validation takes no reason: it decides nothing, and would only discard one');

  const validated = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, {}));
  t.equal(validated.status, 200, 'a complete candidate validates');
  const result = await validated.json() as {
    version: { status: string, checksum: string }, changed: boolean, summary: { failed: number, passed: number },
  };
  t.equal(result.version.status, 'validated');
  t.equal(result.version.checksum, snapshot.registryVersion.checksum, 'and reports the snapshot checksum');
  t.equal(result.changed, true);
  t.equal(result.summary.failed, 0);
  t.ok(result.summary.passed > 0, 'with the checks that decided it');

  const again = await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/validate`, {}));
  const repeat = await again.json() as { changed: boolean, version: { status: string } };
  t.equal(again.status, 200);
  t.equal(repeat.changed, false, 'revalidating a validated version changes nothing');
  t.equal(repeat.version.status, 'validated');
});

/*
 * The shadow comparison as an operator reads it: against the active version
 * by default, or against a validated candidate before activating it.
 */
/*
 * Before a newer version is switched on, the question is what switching
 * changes. The candidate is readable while it still imports, because that is
 * when a market the source added is described, from the facts its import read.
 */
t.test('what a candidate changes against the active version is served while it imports', async t => {
  const db = await freshDatabase();
  const auth = { headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` } };

  const activeId = await seedValidated(db);
  await server.fetch(...admin(`/registry/v1/admin/versions/${activeId}/activate`, { reason: 'activate' }));

  const next    = structuredClone(snapshot);
  const mainnet = next.networks.find(network => network.chainId === 1)!;
  mainnet.markets = mainnet.markets.filter(market => market.deploymentKey !== 'wbtc');
  const weth = mainnet.markets.find(market => market.deploymentKey === 'weth')!;
  weth.creationBlock = weth.creationBlock + 1;
  const { versionId } = await seedCandidate(db, next, { versionId: randomUUID(), attempt: 2 });
  await db.prepare(
    `UPDATE markets SET status = 'disabled', reviewed = 0 WHERE registry_version_id = ?1 AND deployment_key = 'usdt'`
  ).bind(versionId).run();

  const response = await server.fetch(`/registry/v1/admin/versions/${versionId}/changes`, auth);
  t.equal(response.status, 200);
  const changes = await response.json() as {
    status: string, comparedWith: string,
    markets: { added: unknown[], removed: string[], changed: Array<{ scope: string, field: string, before: unknown, after: unknown }> },
  };
  t.equal(changes.status, 'importing', 'a candidate that still imports is comparable');
  t.equal(changes.comparedWith, activeId, 'against the version that is on');
  t.same(changes.markets.removed, [ '1/wbtc' ], 'the market it drops');
  t.same(
    changes.markets.changed.filter(change => change.scope === '1/weth'),
    [ { scope: '1/weth', field: 'creationBlock', before: weth.creationBlock - 1, after: weth.creationBlock } ],
    'and what it changes on a market that stays',
  );
  t.ok(changes.markets.changed.some(change => change.scope === '1/usdt' && change.field === 'status'),
    'including a market written unreviewed, which the version no longer offers');

  t.equal((await server.fetch(`/registry/v1/admin/versions/${randomUUID()}/changes`, auth)).status, 404,
    'a version that does not exist has nothing to compare');
  t.equal((await server.fetch(`/registry/v1/admin/versions/${versionId}/changes`)).status, 401,
    'and the route is authenticated');
});

t.test('the shadow comparison is served for the active version, and for a candidate by id', async t => {
  const db = await freshDatabase();

  const withoutActive = await server.fetch('/registry/v1/admin/shadow', {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  });
  t.equal(withoutActive.status, 503, 'with no active version there is nothing to compare');

  const versionId = await seedValidated(db);
  const candidate = await server.fetch(`/registry/v1/admin/versions/${versionId}/shadow`, {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  });
  t.equal(candidate.status, 200, 'a validated candidate is comparable before it is activated');
  const before = await candidate.json() as {
    agrees: boolean,
    shadow: { versionId: string, registryMarkets: number, onlyInRegistry: string[], differences: unknown[] },
  };
  t.equal(before.shadow.versionId, versionId, 'the report names the version it compared');
  t.equal(before.shadow.registryMarkets, 6);
  t.same(before.shadow.onlyInRegistry, [], 'the constants describe every market of the fixture');
  t.equal(before.agrees, false, 'which the fixture does not fully agree with');
  t.ok(before.shadow.differences.length > 0, 'and the report says where');

  await server.fetch(...admin(`/registry/v1/admin/versions/${versionId}/activate`, { reason: 'activate' }));
  const active = await server.fetch('/registry/v1/admin/shadow', {
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
  });
  t.equal(active.status, 200);
  t.equal(active.headers.get('x-registry-version'), versionId, 'the active comparison names the version too');
  t.equal(active.headers.get('access-control-allow-origin'), null, 'and stays out of reach of a browser');

  t.equal(
    (await server.fetch(`/registry/v1/admin/versions/${randomUUID()}/shadow`, {
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` },
    })).status,
    404,
    'a version that was never validated has no snapshot to compare',
  );
  t.equal((await server.fetch('/registry/v1/admin/shadow')).status, 401, 'and the route is authenticated');
});
