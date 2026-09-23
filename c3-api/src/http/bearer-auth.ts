import { sha256Hex } from '../../lib/hash.js';

import { ApiError } from './errors.js';

/*
 * Bearer authentication for the administrative registry routes.
 *
 * The worker stores only the SHA-256 of the admin token, so a leaked
 * configuration does not hand over the token itself, and the comparison is
 * fixed-time: comparing digests with === would leak, through timing, how much
 * of a guess was correct.
 */
function equalsFixedTime(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function bearerToken(request: Request): string {
  const header = request.headers.get('authorization') ?? '';
  const [ scheme, token ] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || token.length === 0) {
    throw new ApiError('UNAUTHORIZED', `a bearer token is required`);
  }
  return token;
}

/*
 * What an authenticated request is allowed to be charged as: a short prefix
 * of the token's digest. It identifies the credential for rate limiting and
 * diagnostics without being the token, or enough of its digest to be one.
 */
type Credential = {
  fingerprint: string,
};

const FINGERPRINT_LENGTH = 16;

/*
 * Verifies the request against the configured token hash. An environment
 * without a configured hash refuses every administrative request rather than
 * defaulting to open: an unconfigured admin API is a closed one.
 */
async function authenticateAdmin(request: Request, tokenHash: string | undefined): Promise<Credential> {
  if (tokenHash === undefined || tokenHash.length === 0) {
    throw new ApiError('FORBIDDEN', `the administrative API is not configured in this environment`);
  }
  const presented = await sha256Hex(bearerToken(request));
  if (!equalsFixedTime(presented, tokenHash.toLowerCase())) {
    throw new ApiError('UNAUTHORIZED', `the bearer token is not valid`);
  }
  return { fingerprint: presented.slice(0, FINGERPRINT_LENGTH) };
}

export type { Credential };
export { authenticateAdmin, bearerToken, equalsFixedTime, sha256Hex };
