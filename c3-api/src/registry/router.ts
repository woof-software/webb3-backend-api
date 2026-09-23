import type { Env } from '../../entrypoint.js';

import { corsHeadersFor, isAdminRoute } from '../http/cors.js';
import { ApiError, ApiErrorCode, errorBody, isApiError } from '../http/errors.js';
import { jsonResponse } from '../http/json.js';

import { routeAdmin } from './admin-router.js';
import type { CacheDeps, CachedSnapshot } from './cache.js';
import { activeSnapshot, cacheDepsOf, warmSnapshot } from './cache.js';
import { RegistryErrorCode, isRegistryError } from './errors.js';
import { RegistryContext } from './handlers.js';
import { routePublic } from './public-router.js';

/*
 * The registry entry point: everything under /registry/v1 is answered here,
 * including its errors and its CORS headers, and nothing else is.
 *
 * Errors become the versioned envelope rather than propagating: an unhandled
 * throw would otherwise reach the legacy 500 path, which returns the message
 * it carried, and a D1 or upstream message must never leave the worker.
 */
const PREFIX = '/registry/v1';

/*
 * Whether a path is the registry's to answer. The entrypoint and this router
 * must agree exactly: a path one claims and the other does not would be
 * answered by neither, which is how a preflight ends up as a bare 404.
 */
function isRegistryPath(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

function maxAgeOf(env: Env): number {
  return cacheDepsOf(env).ttlSeconds;
}

/*
 * The cache one request reads the active version through. It is built per
 * request and asked at most once, so two handlers of one response cannot be
 * served different versions.
 */
function activeReader(env: Env, debug: NonNullable<CacheDeps['debug']>): () => Promise<CachedSnapshot | null> {
  const deps = cacheDepsOf(env, debug);
  let pending: Promise<CachedSnapshot | null> | null = null;
  return () => pending ??= activeSnapshot(deps);
}

/*
 * How a registry failure is answered. A caller asked for something the
 * registry cannot do (400/409/422), or an upstream this worker depends on did
 * not answer (503). Anything unmapped is treated as upstream trouble rather
 * than a client mistake, because the registry's own errors are all about
 * sources it does not control.
 */
const ERROR_STATUS: Partial<Record<RegistryErrorCode, ApiErrorCode>> = {
  OVERLAY_INVALID:             'BAD_REQUEST',
  OVERLAY_MISSING:             'UNPROCESSABLE',
  OVERLAY_FEED_UNREADABLE:     'UNPROCESSABLE',
  CANDIDATE_STATE_CONFLICT:    'CONFLICT',
  SYNC_ALREADY_RUNNING:        'CONFLICT',
  SOURCE_CONFIGURATION_INVALID:'UNPROCESSABLE',
  SOURCE_REF_UNRESOLVED:       'UNPROCESSABLE',
  SOURCE_COMMIT_UNREACHABLE:   'UNPROCESSABLE',
  ROOT_PATH_INVALID:           'UNPROCESSABLE',
  ROOT_NETWORK_UNSUPPORTED:    'UNPROCESSABLE',
  ROOT_DOCUMENT_INVALID:       'UNPROCESSABLE',
  ROOT_DUPLICATE:              'UNPROCESSABLE',
};

function asApiError(error: unknown): ApiError | null {
  if (isApiError(error)) {
    return error;
  }
  if (!isRegistryError(error)) {
    return null;
  }
  return new ApiError(ERROR_STATUS[error.code] ?? 'UPSTREAM_UNAVAILABLE', error.message, { code: error.code });
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
  { debug }: { debug: { error: (...parameters: unknown[]) => unknown } },
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  if (!isRegistryPath(pathname)) {
    return null;
  }

  const cors = corsHeadersFor(pathname);
  if (request.method === 'OPTIONS') {
    // administrative routes answer no CORS headers, so a preflight there
    // tells a browser nothing it could use
    return withHeaders(new Response(null, { status: 204 }), corsHeadersFor(pathname, { preflight: true }));
  }

  const requestId = crypto.randomUUID();
  const context: RegistryContext = {
    db:     env.APP_DB,
    actor:  env.COMET_REGISTRY_ADMIN_ACTOR ?? `registry-admin:${env.ENVIRONMENT}`,
    debug,
    active: activeReader(env, debug),
    /*
     * Warming is an optimization, and an optimization may not fail a command
     * that has already committed: an activation whose pointer has moved must
     * not answer 500 because KV or D1 hiccuped afterwards.
     */
    warm: async versionId => {
      try {
        await warmSnapshot(cacheDepsOf(env, debug), versionId);
      } catch (error) {
        debug.error(`registry snapshot not warmed`, { versionId, error });
      }
    },
  };

  try {
    const response = isAdminRoute(pathname)
      ? await routeAdmin(request, env, context, pathname)
      : await routePublic(request, context, pathname, { maxAge: maxAgeOf(env) });
    if (response === null) {
      throw new ApiError('NOT_FOUND', `no registry route matches ${pathname}`);
    }
    return withHeaders(response, cors);
  } catch (error) {
    const apiError = asApiError(error);
    if (apiError !== null) {
      return withHeaders(
        jsonResponse(errorBody(apiError, requestId), { status: apiError.status }),
        { ...cors, ...apiError.headers },
      );
    }
    /*
     * Anything else is a bug or an upstream failure this route did not
     * anticipate. The client gets the request id and nothing more; the
     * detail goes to the logs.
     */
    debug.error(`registry route failed`, { requestId, pathname, error });
    return withHeaders(
      jsonResponse(
        errorBody(new ApiError('INTERNAL', `the request could not be completed`), requestId),
        { status: 500 },
      ),
      cors,
    );
  }
}

export { PREFIX, isRegistryPath, routeRegistry };
