/*
 * Route-aware CORS.
 *
 * The legacy routes answer every origin, and the public registry reads are
 * the same kind of public data, so they keep that. The administrative routes
 * do not: they are authenticated writes, and a browser on any origin must not
 * be able to make them on an operator's behalf. They answer no CORS headers
 * at all, which is what keeps a cross-origin script from reading a response
 * even if it manages to send the request.
 */
const PUBLIC_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
};

const PUBLIC_PREFLIGHT: Record<string, string> = {
  ...PUBLIC_CORS,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Max-Age':       '86400',
};

function isAdminRoute(pathname: string): boolean {
  return pathname.startsWith('/registry/v1/admin');
}

/*
 * The CORS headers a response on this path may carry. An administrative path
 * yields none, and the caller must not add any.
 */
function corsHeadersFor(pathname: string, { preflight = false }: { preflight?: boolean } = {}): Record<string, string> {
  if (isAdminRoute(pathname)) {
    return {};
  }
  return preflight ? { ...PUBLIC_PREFLIGHT } : { ...PUBLIC_CORS };
}

export { PUBLIC_CORS, PUBLIC_PREFLIGHT, corsHeadersFor, isAdminRoute };
