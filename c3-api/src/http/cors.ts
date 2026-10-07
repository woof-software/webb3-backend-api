/*
 * Route-aware CORS, decided here for every route of the worker.
 *
 * The legacy routes answer every origin, and the public registry reads are
 * the same kind of public data, so they keep that. The administrative routes
 * do not: they are authenticated writes, and a browser on any origin must not
 * be able to make them on an operator's behalf. They answer no CORS headers
 * at all, which is what keeps a cross-origin script from reading a response
 * even if it manages to send the request.
 *
 * Each response takes them from one place: the registry router sets them on
 * a registry path, and the entrypoint on every other path. Neither sets the
 * other's, so what this module says for a route is what the route answers
 * with.
 */
/*
 * The version headers are the contract a browser client reads: which version
 * answered, and whether the answer came from the cache because the database
 * could not be reached. A response that does not expose them leaves a
 * cross-origin client unable to see either, and it would take a stale answer
 * for a current one.
 *
 * The ETag too: the preflight allows If-None-Match, and a script that keeps
 * its own copy of a snapshot can only send the tag back if it can read it.
 */
const EXPOSED_HEADERS = 'ETag, X-Registry-Version, X-Registry-Checksum, X-Registry-Stale';


const PUBLIC_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':   '*',
  'Access-Control-Expose-Headers': EXPOSED_HEADERS,
};

const PUBLIC_PREFLIGHT: Record<string, string> = {
  ...PUBLIC_CORS,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Max-Age':       '86400',
};

// the legacy routes take GET alone, and their preflight says no more
const LEGACY_PREFLIGHT: Record<string, string> = {
  ...PUBLIC_CORS,
  'Access-Control-Allow-Methods': 'GET',
};

function isAdminRoute(pathname: string): boolean {
  return pathname.startsWith('/registry/v1/admin');
}

/*
 * The CORS headers a response on this registry path may carry. An
 * administrative path yields none, and the caller must not add any.
 */
function corsHeadersFor(pathname: string, { preflight = false }: { preflight?: boolean } = {}): Record<string, string> {
  if (isAdminRoute(pathname)) {
    return {};
  }
  return preflight ? { ...PUBLIC_PREFLIGHT } : { ...PUBLIC_CORS };
}

/*
 * The CORS headers of a legacy route. They are the public registry reads'
 * own: a legacy route that resolves a market names the version it was
 * computed from in the same headers, and a browser has to be able to read
 * them there too.
 */
function legacyCorsHeaders({ preflight = false }: { preflight?: boolean } = {}): Record<string, string> {
  return preflight ? { ...LEGACY_PREFLIGHT } : { ...PUBLIC_CORS };
}

export { corsHeadersFor, isAdminRoute, legacyCorsHeaders };
