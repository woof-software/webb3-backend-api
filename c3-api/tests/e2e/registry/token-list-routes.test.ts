import t from 'tap';

import type { TokenListV1 } from '../../../lib/model/comet-registry.js';

import { freshActive } from '../../util/registry-admin.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { registryHarness } from '../../util/registry-harness.js';

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
const harness = await registryHarness({ vars: { NODE_PROXY_HOST: '127.0.0.1:1', NODE_PROXY_KEY: '' } });
const { server } = harness;

const snapshot = loadRegistrySnapshotFixture();
const SCROLL   = 534352;

type ErrorBody = { error: { code: string, message: string, details?: { registryVersion?: { id: string } } } };

const tokensPath = (chainId: string | number, query = '') => `/registry/v1/networks/${chainId}/tokens${query}`;

t.test('a chain whose collateral cannot be read is still listed, failing open', async t => {
  const { versionId } = await freshActive(harness, { activate: true });

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
    { registryVersion: { id: versionId, checksum: snapshot.registryVersion.checksum }, chainId: SCROLL, thresholdUsd: '250000', ruleVersion: 2, block: null },
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

t.test('a request the list cannot answer is refused, with CORS', async t => {
  const { versionId } = await freshActive(harness, { activate: true });

  for (const chainId of [ '0', '-1', 'scroll-mainnet', '1.5' ]) {
    t.equal((await server.fetch(tokensPath(chainId))).status, 400, `chain id ${chainId} is refused`);
  }
  for (const query of [ '?visibleOnly=', '?visibleOnly=TRUE', '?visibleOnly=1', '?visibleOnly=true&visibleOnly=false', '?visibleOnly=true&visibleOnly=true' ]) {
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
  await freshActive(harness, { activate: false });

  const response = await server.fetch(tokensPath(SCROLL));
  t.equal(response.status, 503);
  t.equal((await response.json() as ErrorBody).error.code, 'REGISTRY_NOT_ACTIVE');
});

/*
 * Without its decisions the list would hide a strategic token below the
 * threshold, so a list that cannot read them is not answered at all.
 */
t.test('a database without the token policy migration says so', async t => {
  await freshActive(harness, { activate: true, through: '0004' });

  const response = await server.fetch(tokensPath(SCROLL));
  t.equal(response.status, 503);
  const body = await response.json() as ErrorBody;
  t.equal(body.error.code, 'UPSTREAM_UNAVAILABLE');
  t.match(body.error.message, /apply the D1 migrations/, 'naming the remedy');
});
