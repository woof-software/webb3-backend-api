import t from 'tap';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type { TokenListV1 } from '../../../lib/model/comet-registry.js';
import {
  activateVersion,
  markValidated,
  recordValidationResults,
  snapshotChecksum,
} from '../../../src/registry/repository.js';
import { setTokenPolicy } from '../../../src/registry/token-policy-repository.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * The token list through the real worker, with a node that refuses every
 * connection, so no collateral can be read: what the list answers then is the
 * fail-open half of the rule — a token whose value is unknown is shown, one
 * without collateral is worth nothing — and everything else the route
 * promises does not depend on the node at all.
 *
 * The node is set here rather than taken from wrangler.toml: a developer's
 * .dev.vars may name a real one, and the harness's own vars win over it.
 */
const server = createTestHarness({
  workers: [ {
    configPath: './wrangler.toml',
    vars:       { NODE_PROXY_HOST: '127.0.0.1:1', NODE_PROXY_KEY: '' },
  } ],
});

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();
const SCROLL   = 534352;
const scroll   = snapshot.networks.find(network => network.chainId === SCROLL)!.markets[0]!;
const COMP     = scroll.rewardAsset!.token.address;

type ErrorBody = { error: { code: string, message: string, details?: { registryVersion?: { id: string } } } };

const tokensPath = (chainId: string | number, query = '') => `/registry/v1/networks/${chainId}/tokens${query}`;

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
    await activateVersion(db, { versionId, action: 'activate', actor: 'test-seed', reason: 'seeded for a token list test' });
  }
  return { db, versionId };
}

async function list(query = ''): Promise<TokenListV1> {
  const response = await server.fetch(tokensPath(SCROLL, query));
  if (response.status !== 200) {
    throw new Error(`the token list answered ${response.status}: ${await response.text()}`);
  }
  return await response.json() as TokenListV1;
}

const decide = (db: D1Database, isStrategic: boolean) => setTokenPolicy(db, {
  chainId:      SCROLL,
  tokenAddress: COMP,
  isStrategic,
  actor:        'test',
  reason:       'decided for a token list test',
});

t.test('a chain whose collateral cannot be read is still listed, failing open', async t => {
  const { versionId } = await freshDatabase({ activate: true });

  const response = await server.fetch(tokensPath(SCROLL));
  t.equal(response.status, 200, 'a node that does not answer is not a failure of the list');
  t.equal(response.headers.get('cache-control'), 'public, max-age=30', 'it is kept briefly');
  t.equal(response.headers.get('etag'), null, 'and never by its version: values change every minute');
  t.equal(response.headers.get('x-registry-version'), versionId, 'it names the version that listed the tokens');
  t.equal(response.headers.get('x-registry-checksum'), snapshot.registryVersion.checksum);
  t.equal(response.headers.get('access-control-allow-origin'), '*', 'a browser on any origin may read it');
  t.match(response.headers.get('access-control-expose-headers'), /X-Registry-Version/, 'with the version headers');

  const body = await response.json() as TokenListV1;
  t.same(
    { registryVersion: body.registryVersion, chainId: body.chainId, thresholdUsd: body.thresholdUsd, ruleVersion: body.ruleVersion, block: body.block },
    { registryVersion: { id: versionId, checksum: snapshot.registryVersion.checksum }, chainId: SCROLL, thresholdUsd: '250000', ruleVersion: 1, block: null },
    'the latest block could not be read',
  );
  t.same(
    body.tokens.map(token => [ token.symbol, token.roles, token.collateralValueStatus, token.collateralValueUsd, token.isVisible, token.visibilityReason ]),
    [
      [ 'COMP',   [ 'reward' ],     'fresh',       '0',  false, 'below_threshold' ],
      [ 'USDC',   [ 'base' ],       'fresh',       '0',  false, 'below_threshold' ],
      [ 'WETH',   [ 'collateral' ], 'unavailable', null, true,  'data_unavailable' ],
      [ 'wstETH', [ 'collateral' ], 'unavailable', null, true,  'data_unavailable' ],
    ],
    'a token no market takes as collateral is worth nothing; one whose collateral is unknown is shown',
  );
  const weth = body.tokens.find(token => token.symbol === 'WETH')!;
  t.same(
    { valueAt: weth.valueAt, valueBlock: weth.valueBlock, staleAgeSeconds: weth.staleAgeSeconds, exceptions: weth.exceptions, isStrategic: weth.isStrategic },
    { valueAt: null, valueBlock: null, staleAgeSeconds: null, exceptions: [], isStrategic: false },
    'an unknown value is said to be unknown, never zero',
  );
  t.ok(body.tokens.every(token => token.address === token.address.toLowerCase()), 'addresses are lowercase');
});

t.test('a strategic token is shown whatever its value, and the next request sees a decision', async t => {
  const { db } = await freshDatabase({ activate: true });

  t.same((await list('?visibleOnly=true')).tokens.map(token => token.symbol), [ 'WETH', 'wstETH' ],
    'visibleOnly lists what discovery shows');

  await decide(db, true);
  const decided = await list();
  const comp = decided.tokens.find(token => token.symbol === 'COMP')!;
  t.same([ comp.isStrategic, comp.isVisible, comp.visibilityReason, comp.collateralValueUsd ], [ true, true, 'strategic', '0' ],
    'a strategic token is shown, and its value is still told');
  t.same((await list('?visibleOnly=true')).tokens.map(token => token.symbol), [ 'COMP', 'WETH', 'wstETH' ]);
  t.equal((await list('?visibleOnly=false')).tokens.length, 4, 'visibleOnly=false lists every token');

  await decide(db, false);
  t.same((await list('?visibleOnly=true')).tokens.map(token => token.symbol), [ 'WETH', 'wstETH' ],
    'a decision taken back is seen at once: decisions are read on every request');
});

t.test('a request the list cannot answer is refused, with CORS', async t => {
  const { versionId } = await freshDatabase({ activate: true });

  for (const chainId of [ '0', '-1', 'scroll-mainnet', '1.5' ]) {
    t.equal((await server.fetch(tokensPath(chainId))).status, 400, `chain id ${chainId} is refused`);
  }
  for (const query of [ '?visibleOnly=', '?visibleOnly=TRUE', '?visibleOnly=1', '?visibleOnly=true&visibleOnly=false' ]) {
    const response = await server.fetch(tokensPath(SCROLL, query));
    t.equal(response.status, 400, `${query} is refused`);
    t.match((await response.json() as ErrorBody).error.message, /visibleOnly must be true or false/);
  }

  const unknown = await server.fetch(tokensPath(10));
  t.equal(unknown.status, 404, 'a chain the active registry does not hold is not found');
  const unknownBody = await unknown.json() as ErrorBody;
  t.match(unknownBody.error.message, /chain 10 is not part of the active registry/);
  t.equal(unknownBody.error.details?.registryVersion?.id, versionId, 'and the refusal names the version it was decided against');
  t.equal(unknown.headers.get('x-registry-version'), versionId, 'in its headers too');
  t.equal(unknown.headers.get('access-control-allow-origin'), '*', 'a browser may read a refusal');

  const wrongVerb = await server.fetch(tokensPath(SCROLL), { method: 'POST', body: '{}' });
  t.equal(wrongVerb.status, 405);
  t.equal(wrongVerb.headers.get('allow'), 'GET, HEAD, OPTIONS');

  const head = await server.fetch(tokensPath(SCROLL), { method: 'HEAD' });
  t.equal(head.status, 200, 'HEAD is answered');
  t.equal(head.headers.get('cache-control'), 'public, max-age=30');

  const preflight = await server.fetch(tokensPath(SCROLL), { method: 'OPTIONS' });
  t.equal(preflight.status, 204);
  t.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
});

t.test('without an active version there is nothing to list', async t => {
  await freshDatabase({ activate: false });

  const response = await server.fetch(tokensPath(SCROLL));
  t.equal(response.status, 503);
  t.equal((await response.json() as ErrorBody).error.code, 'REGISTRY_NOT_ACTIVE');
});

/*
 * Without its decisions the list would hide a strategic token below the
 * threshold, so a list that cannot read them is not answered at all.
 */
t.test('a database without the token policy migration says so', async t => {
  await freshDatabase({ activate: true, through: '0004' });

  const response = await server.fetch(tokensPath(SCROLL));
  t.equal(response.status, 503);
  const body = await response.json() as ErrorBody;
  t.equal(body.error.code, 'UPSTREAM_UNAVAILABLE');
  t.match(body.error.message, /apply the D1 migrations/, 'naming the remedy');
});
