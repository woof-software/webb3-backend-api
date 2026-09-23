import fetch      from './lib/request-counting-fetch.js';
import Quota      from './lib/quota.js';
import * as Flags from './lib/flags.js';
import * as Debug from './lib/debug-log.js';

import { route }      from './src/router.js';
import * as Evaluator from './src/evaluator.js';

import { EXPOSED_HEADERS, isAdminRoute } from './src/http/cors.js';
import { isRegistryPath } from './src/registry/router.js';
import { runRegistrySync } from './src/registry/scheduled.js';

import * as v2           from './lib/computations/v2.js';
import * as evm          from './lib/computations/evm.js';
import * as comet        from './lib/computations/comet.js';
import * as market       from './lib/computations/market.js';
import * as rewards      from './lib/computations/rewards.js';
import * as account      from './lib/computations/account.js';
import * as defisaver    from './lib/computations/defisaver.js';
import * as governance   from './lib/computations/governance.js';
import * as cometRewards from './lib/computations/comet-rewards.js';
import * as sleuthQuery  from './lib/computations/sleuth/sleuth-query.js';

/*
 * worker-to-worker service bindings configured in wrangler.toml must be
 * added here as optional fields pointing to service binding objects
 */
interface ServiceBindings {
  node_provider_proxy?: { fetch: (typeof self.fetch) }
}

/*
 * Workers rate limiting binding (`ratelimits` in wrangler.toml). Declared
 * here because installs through the workspace preinstall resolve
 * @cloudflare/workers-types 3.x, which has no rate limit type.
 */
interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface Env extends Flags.Env, ServiceBindings {
  kv_mainnet:   KVNamespace,
  kv_testnet:   KVNamespace,
  // versioned comet registry snapshot cache and last-valid fallback
  kv_registry:  KVNamespace,
  // application database shared by all D1-backed features
  APP_DB:       D1Database,
  // registry admin writes, keyed per authenticated actor and route family
  REGISTRY_ADMIN_RATE_LIMITER: RateLimiter,
  ENVIRONMENT:  string,
  /*
   * seed for memory cache, useful for testing where we need independent
   * memory caches for each test suite
   */
  MEMORY_CACHE_SEED: string,
  TALLY_API_KEY: string,
  BLOCK_NATIVE_API_KEY?: string,
  V3_API_HOST: string,
  NODE_PROXY_HOST: string,
  NODE_PROXY_KEY: string,

  /*
   * comet registry source, sync, and cache settings; numeric values are
   * strings, as in wrangler.toml
   */
  COMET_SOURCE_REPOSITORY: string,
  COMET_SOURCE_REF: string,
  COMET_UPSTREAM_CHECK_INTERVAL_S: string,
  COMET_SYNC_MARKETS_PER_INVOCATION: string,
  COMET_SYNC_LEASE_SECONDS: string,
  REGISTRY_SNAPSHOT_CACHE_TTL_S: string,
  REGISTRY_STALE_FALLBACK_MAX_S: string,
  // the operator identity recorded in audit rows, never taken from a request
  COMET_REGISTRY_ADMIN_ACTOR?: string,
  // comet registry secrets, never set in wrangler.toml
  COMET_REGISTRY_ADMIN_TOKEN_HASH?: string,
  COMET_GITHUB_TOKEN?: string,

  /*
   * for worker-to-worker requests we need to override fetch() requests to
   * the corresponding URL to instead invoke the service binding directly
   */
  URL_SERVICE_BINDING_OVERRIDES?: Array<{
    host:    string,
    binding: (keyof ServiceBindings),
  }>,
  // debug configuration
  DEBUG?:       string,
  DEBUG_DEPTH?: string,
  DEBUG_LEVEL?: string,
  // quota configuration
  QUOTA_SUBREQUESTS?: number;
  QUOTA_CACHE_OPERATIONS?: number;
}

export { Env, ServiceBindings };

/*
 * CORS headers shared between the preflight and the main response
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  /*
   * Every route that resolves a market names the registry version it was
   * computed from, and says when that version came from the cache because
   * the database could not be reached. A browser client can only read those
   * headers if the response exposes them, and the list is the registry's own
   * so the two routers cannot drift apart.
   */
  'Access-Control-Expose-Headers': EXPOSED_HEADERS,
};

/*
 * security headers applied to every response, per security team recommendation
 */
const SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security':    'max-age=63072000; includeSubDomains; preload',
  'Content-Security-Policy':      "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options':       'nosniff',
  'X-Frame-Options':              'DENY',
  'Referrer-Policy':              'no-referrer',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    /*
     * The registry answers its own preflight, because its administrative
     * routes must not advertise cross-origin access the way the public
     * routes do.
     */
    if (request.method === 'OPTIONS' && !isRegistryPath(pathname)) {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          // preflight-only: advertise the methods the API supports
          'Access-Control-Allow-Methods': 'GET',
          ...SECURITY_HEADERS,
        },
      });
    }
    const quota = Quota.initialize({
      // cache resources: 1000 ops, regardless of reads or writes
      ops:    env.QUOTA_CACHE_OPERATIONS ?? Infinity,
      reads:  env.QUOTA_CACHE_OPERATIONS ?? Infinity,
      writes: env.QUOTA_CACHE_OPERATIONS ?? Infinity,
      // http resources: 1000 subrequests via fetch(..)
      subrequests: env.QUOTA_SUBREQUESTS ?? Infinity,
    });
    fetch.configure(env, quota);
    fetch.resetCount();
    const debug = Debug.MakeLogger([]).configure(env);
    const flags = Flags.parse(env);
    const context: Evaluator.Context = { env, debug, flags };
    const response = await route(
      request,
      context,
      Evaluator.preInstantiate(quota, context, {
        ...evm.applyIndexBias(
          Flags.defaults(flags).ethComputationIndexBias,
          evm
        ),
        ...v2,
        ...comet,
        ...market,
        ...account,
        ...rewards,
        ...defisaver,
        ...governance,
        ...cometRewards,
        ...sleuthQuery,
      }),
    );
    /*
     * Security headers apply everywhere. The wildcard CORS header does not:
     * an authenticated administrative write must not be readable by a script
     * on any origin, so those routes keep the headers their own router set.
     */
    const headers = isAdminRoute(pathname)
      ? SECURITY_HEADERS
      : { ...CORS_HEADERS, ...SECURITY_HEADERS };
    for (const [name, value] of Object.entries(headers)) {
      response.headers.set(name, value);
    }
    return response;
  },

  /*
   * cron entry point for the resumable comet registry sync: one invocation
   * imports a bounded number of markets and leaves the rest to the next one,
   * resuming from the checkpoints it finds in APP_DB
   */
  async scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    /*
     * The import brings its own fetch rather than configuring the shared
     * request-counting one: it runs past the end of this handler, and a
     * request arriving meanwhile would reset that counter and quota.
     */
    context.waitUntil(runRegistrySync(env));
  },
};
