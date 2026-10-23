import { ApiError } from '../http/errors.js';
import { jsonResponse } from '../http/json.js';

import { isUnreachable } from './cache.js';
import { DEPRECATED_RECORD, HIDDEN_RECORD, collateralDecisionsOf } from './collateral-decisions.js';
import { RegistryContext, addressOf, chainIdOf } from './handlers.js';
import { catalogHeaders } from './request-catalog.js';
import { collateralView, positionsOf } from './token-collateral.js';
import { tokenList } from './token-visibility.js';
import {
  DecisionList,
  applyTokenPolicies,
  exportTokenPolicies,
  readStrategicTokens,
  readTokenPolicies,
  readTokenPolicy,
  reviewTokenPolicies,
  setTokenPolicy,
} from './token-policy-repository.js';
import { registryHeaders } from './version-headers.js';

/*
 * The token policy routes: which tokens an administrator has marked
 * strategic, and the audit of every change to that decision.
 *
 * A policy belongs to no registry version, but whether a token may carry one
 * is decided by the active version, so every answer names that version, in
 * headers and in the body, as the other registry routes do.
 */

async function getTokenPolicies(context: RegistryContext, chainId: string): Promise<Response> {
  const policies = await readTokenPolicies(context.db, chainIdOf(chainId));
  return jsonResponse(policies, { headers: registryHeaders(policies.registryVersion) });
}

async function getTokenPolicy(context: RegistryContext, chainId: string, tokenAddress: string): Promise<Response> {
  const policy = await readTokenPolicy(context.db, chainIdOf(chainId), addressOf(tokenAddress));
  return jsonResponse(policy, { headers: registryHeaders(policy.registryVersion) });
}

/*
 * Asking for the decision already in force answers `changed: false` and
 * writes nothing, so a retried or repeated request is safe; a change is
 * committed with its audit event before it is answered.
 */
async function patchTokenPolicy(
  context: RegistryContext,
  chainId: string,
  tokenAddress: string,
  decision: { isStrategic: boolean, reason: string },
): Promise<Response> {
  const result = await setTokenPolicy(context.db, {
    chainId:      chainIdOf(chainId),
    tokenAddress: addressOf(tokenAddress),
    isStrategic:  decision.isStrategic,
    actor:        context.actor,
    reason:       decision.reason,
  });
  return jsonResponse(result, { headers: registryHeaders(result.registryVersion) });
}

/*
 * A list of decisions for every token at once: exported as a file, edited,
 * reviewed as the diff it would make, and applied in one transaction. The
 * export and the two commands speak the same body, so an exported file is
 * sent back as it is.
 */
async function getTokenPolicyExport(context: RegistryContext): Promise<Response> {
  const list = await exportTokenPolicies(context.db);
  return jsonResponse(list, { headers: registryHeaders(list.registryVersion) });
}

async function postTokenPolicyReview(context: RegistryContext, list: DecisionList): Promise<Response> {
  const review = await reviewTokenPolicies(context.db, list);
  return jsonResponse(review, { headers: registryHeaders(review.registryVersion) });
}

async function postTokenPolicyApply(context: RegistryContext, list: DecisionList): Promise<Response> {
  const applied = await applyTokenPolicies(context.db, list, context.actor);
  return jsonResponse(applied, { headers: registryHeaders(applied.registryVersion) });
}

/*
 * `visibleOnly` is exactly `true` or `false`, once, or absent. Anything else
 * is refused rather than read as one of them: a client that misspells the
 * filter must not silently get the other list.
 */
function visibleOnlyOf(query: URLSearchParams): boolean {
  const values = query.getAll('visibleOnly');
  if (values.length === 0 || (values.length === 1 && values[0] === 'false')) {
    return false;
  }
  if (values.length === 1 && values[0] === 'true') {
    return true;
  }
  throw new ApiError('BAD_REQUEST', `visibleOnly must be true or false`);
}

/*
 * The decisions of one kind the list is made with, read from the database on
 * every request. A database that does not answer is an outage the client is
 * told about, a 503, and fails open on, since the list would be wrong without
 * them: without the token policies it would list a strategic token below the
 * threshold as not shown, without the deprecated collateral decisions call a
 * deprecated collateral current and show a token discovery does not, and
 * without the hidden ones show a token an enabled market hides and none of
 * them leaves to discovery. Why it did not answer is logged under the request
 * id, beside the answer's own line.
 *
 * The collateral decisions are every chain's, read as the active reads read
 * them, and the list looks up its own chain's. Unlike the active reads, the
 * list does not answer from the decisions last recorded: it fails with the
 * token policies anyway.
 */
async function orRefused<T>(context: RegistryContext, chainId: number, decisions: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isUnreachable(error)) {
      context.debug.error(`the token list could not read the ${decisions}`, { requestId: context.requestId, chainId, error });
      throw new ApiError('UPSTREAM_UNAVAILABLE', `the ${decisions} could not be read`);
    }
    throw error;
  }
}

/*
 * `GET /registry/v1/networks/{chainId}/tokens[?visibleOnly=true]`: every token
 * the active version serves on a chain, with its strategic decision, the
 * Comets it is a deprecated collateral of and those it is a hidden one of, its
 * collateral value, and whether discovery shows it.
 *
 * Values change every minute and with every decision, so the answer is kept
 * briefly by a client, never by its version: no ETag, and a short max-age.
 * A failure to value a token is never a failure of the list; it is a status
 * on that token.
 */
async function getTokenList(request: Request, context: RegistryContext, chainIdText: string): Promise<Response> {
  const chainId     = chainIdOf(chainIdText);
  const visibleOnly = visibleOnlyOf(new URL(request.url).searchParams);
  // a registry that cannot be read is answered, and logged, by the router, as on every registry route
  const catalog     = await context.catalog.load();
  const registryVersion = { id: catalog.versionId, checksum: catalog.checksum };

  const served = catalog.networkOn(chainId);
  if (served === null) {
    throw new ApiError('NOT_FOUND', `chain ${chainId} is not part of the active registry`, { registryVersion }, registryHeaders(registryVersion));
  }
  const name      = served.name;
  const positions = positionsOf(catalog, name);
  const valuing   = collateralView(context.tokens, { chainId, network: name, positions, versionId: catalog.versionId });
  /*
   * The valuation may start a minute every other request of the isolate
   * waits for, so it is not cancelled when this request answers first —
   * which a refusal to read the decisions does.
   */
  context.tokens.waitUntil(valuing);
  const [ strategic, deprecated, hidden, view ] = await Promise.all([
    orRefused(context, chainId, 'token policies', () => readStrategicTokens(context.db, chainId)),
    orRefused(context, chainId, 'deprecated collateral decisions', () => DEPRECATED_RECORD.read(context.db)),
    orRefused(context, chainId, 'hidden collateral decisions', () => HIDDEN_RECORD.read(context.db)),
    valuing,
  ]);

  const list = tokenList({
    registryVersion,
    chainId,
    catalog,
    network:    name,
    positions,
    view,
    strategic,
    deprecated: collateralDecisionsOf(deprecated),
    hidden:     collateralDecisionsOf(hidden),
    now:        context.tokens.now(),
  });
  return jsonResponse(visibleOnly ? { ...list, tokens: list.tokens.filter(token => token.isVisible) } : list, {
    headers: {
      'Cache-Control': 'public, max-age=30',
      // last, so an answer from a version the database could not confirm is not stored
      ...catalogHeaders(catalog, context.catalog.staleFor()),
    },
  });
}

export {
  getTokenList,
  getTokenPolicies,
  getTokenPolicy,
  getTokenPolicyExport,
  patchTokenPolicy,
  postTokenPolicyApply,
  postTokenPolicyReview,
};
