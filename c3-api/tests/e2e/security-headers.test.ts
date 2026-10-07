import t, { Test } from 'tap';
import { makeTestEnv } from '../util/test-env.js';
import C3Api, { Env } from '../../entrypoint.js';
import { corsHeadersFor, legacyCorsHeaders } from '../../src/http/cors.js';
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
  // an administrative route spends from the address limiter before anything else, which has to answer here
  'REGISTRY_ADMIN_AUTH_RATE_LIMITER': { limit: async () => ({ success: true }) },
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

const CORS_HEADER_NAMES = [
  'Access-Control-Allow-Origin',
  'Access-Control-Expose-Headers',
  'Access-Control-Allow-Methods',
  'Access-Control-Allow-Headers',
  'Access-Control-Max-Age',
];

function corsOf(response: Response): Record<string, string> {
  return Object.fromEntries(CORS_HEADER_NAMES.flatMap(name => {
    const value = response.headers.get(name);
    return value === null ? [] : [ [ name, value ] ];
  }));
}

/*
 * A response takes its CORS headers from the router that answered it: the
 * registry sets its own on every registry path — none at all on an
 * administrative one — and the entrypoint sets the legacy routes' on every
 * other path. Both come from cors.ts and neither overwrites the other's, so
 * what cors.ts says for a route is exactly what the route answers with.
 *
 * The values alone cannot show that neither overwrites the other's: the
 * public registry headers are the legacy routes' own, so an entrypoint that
 * set them again over the registry's would leave every value as it found it.
 * So every header set is watched as well, and no CORS header may be set over
 * one the response already carries.
 */
t.test(`every response carries the CORS headers of its route, and no others`, async t => {
  const overwritten: string[] = [];
  const answer = async (path: string, method: string = 'GET') => {
    const { set } = Headers.prototype;
    Headers.prototype.set = function (this: Headers, name: string, value: string) {
      if (/^access-control-/i.test(name) && this.has(name)) {
        overwritten.push(`${method} ${path}: ${name}`);
      }
      set.call(this, name, value);
    };
    try {
      return await C3Api.fetch(new Request(`http://test.local${path}`, { method }), testEnv);
    } finally {
      Headers.prototype.set = set;
    }
  };

  t.same(corsOf(await answer('/not-a-real-endpoint')), legacyCorsHeaders(), 'a legacy route');
  t.same(
    corsOf(await answer('/legacy/mainnet/gas-price', 'OPTIONS')),
    legacyCorsHeaders({ preflight: true }),
    'and the preflight of one',
  );

  // D1 does not exist in Node, so a registry read fails here: with the headers of its route
  const read = await answer('/registry/v1/active');
  t.equal(read.status, 500, 'a public registry read that fails');
  t.same(corsOf(read), corsHeadersFor('/registry/v1/active'), 'carries the public registry headers');
  t.same(
    corsOf(await answer('/registry/v1/active', 'OPTIONS')),
    corsHeadersFor('/registry/v1/active', { preflight: true }),
    'and its preflight the public registry preflight',
  );

  const admin = await answer('/registry/v1/admin/versions');
  t.equal(admin.status, 403, 'an administrative route of an environment without a token');
  t.same(corsOf(admin), {}, 'carries none');
  t.same(corsOf(await answer('/registry/v1/admin/versions', 'OPTIONS')), {}, 'and nor does its preflight');

  for (const response of [ read, admin ]) {
    assertSecurityHeaders(t, response);
  }

  t.same(overwritten, [], 'and no response had a CORS header set over one it already carried');

  t.end();
});
