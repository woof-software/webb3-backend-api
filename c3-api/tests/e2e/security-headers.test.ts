import t, { Test } from 'tap';
import { makeTestEnv } from '../util/test-env.js';
import C3Api, { Env } from '../../entrypoint.js';
import '../../shim/node-self.js';

/*
 * The security headers the security team recommended be present on every
 * response from the worker. Kept in sync with SECURITY_HEADERS in
 * entrypoint.ts.
 */
const EXPECTED_SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security':    'max-age=63072000; includeSubDomains; preload',
  'Content-Security-Policy':      "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options':       'nosniff',
  'X-Frame-Options':              'DENY',
  'Referrer-Policy':              'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

const testEnv: Env = makeTestEnv({
  'MEMORY_CACHE_SEED': 'security-headers',
});

function assertSecurityHeaders(t: Test, response: Response) {
  for (const [ name, value ] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
    t.equal(
      response.headers.get(name),
      value,
      `response has expected '${name}' header`,
    );
  }
}

t.test(`OPTIONS preflight response includes security headers`, async t => {
  const request  = new Request(`http://test.local/legacy/mainnet/gas-price`, {
    method: 'OPTIONS',
  });
  const response = await C3Api.fetch(request, testEnv);

  t.equal(response.status, 204, 'preflight returns 204');
  t.equal(
    response.headers.get('Access-Control-Allow-Origin'),
    '*',
    'preflight allows cross-origin requests',
  );
  assertSecurityHeaders(t, response);

  t.end();
});

/*
 * The registry answers its own preflight, because its administrative routes
 * must not advertise cross-origin access. Everything else is answered here,
 * and the two predicates have to agree exactly: a path one skips and the
 * other does not claim would be answered by neither.
 */
t.test(`a path that only looks like a registry path still gets a preflight`, async t => {
  for (const path of [ '/registry/v1x', '/registry/v1beta/markets', '/registry', '/registry/v2/active' ]) {
    const response = await C3Api.fetch(new Request(`http://test.local${path}`, { method: 'OPTIONS' }), testEnv);

    t.equal(response.status, 204, `${path} is answered as a preflight`);
    t.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
    t.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET');
  }

  t.end();
});

t.test(`GET response includes security headers`, async t => {
  // an unknown path resolves to a deterministic 404 without any network
  // calls, which is sufficient to exercise the main response branch.
  const request  = new Request(`http://test.local/not-a-real-endpoint`);
  const response = await C3Api.fetch(request, testEnv);

  t.equal(response.status, 404, 'unknown route returns 404');
  t.equal(
    response.headers.get('Access-Control-Allow-Origin'),
    '*',
    'response allows cross-origin requests',
  );
  assertSecurityHeaders(t, response);

  t.end();
});
