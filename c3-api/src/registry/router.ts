import type { Env } from '../../entrypoint.js';

import { corsHeadersFor, isAdminRoute } from '../http/cors.js';
import { ApiError, ApiErrorCode, FailureLog, failureResponse, isApiError } from '../http/errors.js';

import { routeAdmin } from './admin-router.js';
import type { CacheDeps, CachedSnapshot } from './cache.js';
import { activeSnapshot, cacheDepsOf, isUnreachable, versionSnapshot, warmSnapshot } from './cache.js';
import { RegistryErrorCode, isRegistryError } from './errors.js';
import { RegistryContext } from './handlers.js';
import { routePublic } from './public-router.js';
import { isRegistryUnavailable, unavailableError } from './request-catalog.js';
import type { RequestCatalog } from './request-catalog.js';
import { TokenCollateralDeps, maxStaleMinutesOf } from './token-collateral.js';

/*
 * The registry entry point: everything under /registry/v1 is answered here,
 * including its errors and its CORS headers, and nothing else is.
 *
 * Errors become the versioned envelope rather than propagating: an unhandled
 * throw would otherwise reach the legacy 500 path, and a D1 or upstream
 * message must never leave the worker.
 */
const PREFIX = '/registry/v1';

/*
 * Whether a path is the registry's to answer, with its preflight and its CORS
 * headers. The entrypoint asks this same function before it answers a
 * preflight or sets CORS headers itself: a path one claimed and the other did
 * not would be answered by neither, which is how a preflight ends up as a
 * bare 404, or would carry CORS headers this router did not decide.
 */
function isRegistryPath(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

/*
 * A trailing slash names the same resource, so a path is matched without it,
 * as the legacy routes match theirs: `/registry/v1/active/` is the snapshot,
 * not a 404.
 */
function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/*
 * The cache one request reads the active version through. It is built per
 * request and asked at most once, so two handlers of one response cannot be
 * served different versions.
 */
function activeReader(deps: CacheDeps): () => Promise<CachedSnapshot | null> {
  let pending: Promise<CachedSnapshot | null> | null = null;
  return () => pending ??= activeSnapshot(deps);
}

/*
 * How a registry failure is answered. Only a source or a node provider that
 * did not answer is a 503, worth trying again. Everything else the registry
 * refuses for what was asked of it, or for what the source or the chain said,
 * and asking again changes neither. The map is total, so a code added to
 * RegistryErrorCode is given its status here before the worker builds.
 */
const ERROR_STATUS: Record<RegistryErrorCode, ApiErrorCode> = {
  SOURCE_CONFIGURATION_INVALID: 'UNPROCESSABLE',
  SOURCE_REF_UNRESOLVED:        'UNPROCESSABLE',
  SOURCE_COMMIT_UNREACHABLE:    'UNPROCESSABLE',
  SOURCE_REQUEST_FAILED:        'UPSTREAM_UNAVAILABLE',
  SOURCE_RESPONSE_INVALID:      'UNPROCESSABLE',
  SOURCE_TREE_TRUNCATED:        'UNPROCESSABLE',
  SOURCE_CONTENT_TOO_LARGE:     'UNPROCESSABLE',
  SOURCE_BLOB_MISMATCH:         'UNPROCESSABLE',
  ROOT_PATH_INVALID:            'UNPROCESSABLE',
  ROOT_NETWORK_UNSUPPORTED:     'UNPROCESSABLE',
  ROOT_DOCUMENT_INVALID:        'UNPROCESSABLE',
  ROOT_DUPLICATE:               'UNPROCESSABLE',
  CHAIN_REQUEST_FAILED:         'UPSTREAM_UNAVAILABLE',
  CHAIN_RESPONSE_INVALID:       'UNPROCESSABLE',
  CHAIN_CALL_REVERTED:          'UNPROCESSABLE',
  CHAIN_CONTRACT_MISSING:       'UNPROCESSABLE',
  OVERLAY_INVALID:              'BAD_REQUEST',
  OVERLAY_FEED_UNREADABLE:      'UNPROCESSABLE',
  CANDIDATE_STATE_CONFLICT:     'CONFLICT',
  SYNC_ALREADY_RUNNING:         'CONFLICT',
};

/*
 * A release that reached an environment before its token policy migration
 * finds those tables missing. The remedy is known and is an operator's, so it
 * is said, rather than answered as an internal error only the logs explain.
 * Any other table missing is a fault like the rest, and stays a 500.
 */
function missingSchema(error: unknown): boolean {
  return /no such table: token_polic/i.test(String(error));
}

/*
 * What a failure means to a client, or null for a fault the client is told
 * nothing about. A registry error keeps its own code in `details.code`, under
 * the class of answer in `error.code`.
 */
function asApiError(error: unknown): ApiError | null {
  if (isApiError(error)) {
    return error;
  }
  if (isRegistryError(error)) {
    return new ApiError(ERROR_STATUS[error.code], error.message, { code: error.code });
  }
  if (isRegistryUnavailable(error)) {
    return unavailableError(error);
  }
  /*
   * A database that could not be reached, wherever a route read it, is the
   * registry being unavailable: a 503 whichever route found out. One that
   * answered with a fault is not this, and stays a 500.
   */
  if (isUnreachable(error)) {
    return new ApiError('UPSTREAM_UNAVAILABLE', `a service the registry depends on did not answer`);
  }
  if (missingSchema(error)) {
    return new ApiError(
      'UPSTREAM_UNAVAILABLE',
      `the database is missing tables this release needs: apply the D1 migrations to this environment`,
    );
  }
  return null;
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
  for (const [ name, value ] of Object.entries(headers)) {
    response.headers.set(name, value);
  }
  return response;
}

async function routeRegistry(
  request: Request,
  env: Env,
  { debug, requestId, registry, evaluator, waitUntil }: {
    debug:      FailureLog,
    // the id the entrypoint gave the request, which its error answer and its log lines carry
    requestId:  string,
    // the registry version of the request, shared with every other route that reads it
    registry:   RequestCatalog,
    // an evaluator for the token list's collateral reads, batching every read of a chain
    evaluator:  TokenCollateralDeps['evaluator'],
    // keeps the token list's valuation alive past the answer of the request that started it
    waitUntil:  TokenCollateralDeps['waitUntil'],
  },
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!isRegistryPath(path)) {
    return null;
  }
  const pathname = withoutTrailingSlash(path);

  const cors = corsHeadersFor(pathname);
  if (request.method === 'OPTIONS') {
    // administrative routes answer no CORS headers, so a preflight there
    // tells a browser nothing it could use
    return withHeaders(new Response(null, { status: 204 }), corsHeadersFor(pathname, { preflight: true }));
  }

  const deps = cacheDepsOf(env, debug);
  const context: RegistryContext = {
    db:      env.APP_DB,
    actor:   env.COMET_REGISTRY_ADMIN_ACTOR ?? `registry-admin:${env.ENVIRONMENT}`,
    requestId,
    debug,
    active:  activeReader(deps),
    version: versionId => versionSnapshot(deps, versionId),
    /*
     * Warming is an optimization, and an optimization may not fail a command
     * that has already committed: an activation whose pointer has moved must
     * not answer 500 because KV or D1 hiccuped afterwards.
     */
    warm: async versionId => {
      try {
        await warmSnapshot(deps, versionId);
      } catch (error) {
        debug.warn(`registry snapshot not warmed`, { versionId, error });
      }
    },
    catalog: registry,
    tokens: {
      frame:           { apiHost: env.V3_API_HOST, nodeHost: env.NODE_PROXY_HOST, nodeKey: env.NODE_PROXY_KEY },
      evaluator,
      kv:              networkEnv => env[`kv_${networkEnv}`],
      maxStaleMinutes: maxStaleMinutesOf(env),
      now:             () => new Date(),
      debug,
      waitUntil,
    },
  };

  try {
    const response = isAdminRoute(pathname)
      ? await routeAdmin(request, env, context, pathname)
      : await routePublic(request, context, pathname, { maxAge: deps.ttlSeconds });
    if (response === null) {
      throw new ApiError('NOT_FOUND', `no registry route matches ${pathname}`);
    }
    return withHeaders(response, cors);
  } catch (error) {
    return failureResponse(asApiError(error), error, {
      requestId,
      pathname,
      debug,
      label:   'registry route',
      headers: cors,
    });
  }
}

export { ERROR_STATUS, asApiError, isRegistryPath, routeRegistry };
