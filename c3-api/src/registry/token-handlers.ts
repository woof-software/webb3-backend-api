import { Address, isAddress, normalizeAddress } from '../../lib/model/comet-registry.js';

import type * as KnownNetwork from '../../lib/well-known/networks/network.js';

import { ApiError } from '../http/errors.js';
import { jsonResponse } from '../http/json.js';

import type { Catalog } from './catalog.js';
import { isUnreachable } from './cache.js';
import { RegistryContext, chainIdOf } from './handlers.js';
import { catalogHeaders, isRegistryUnavailable } from './request-catalog.js';
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

/*
 * A token is addressed by its address in any case; it is stored and answered
 * lowercase, as every address the registry holds.
 */
function tokenAddressOf(value: string): Address {
  if (!isAddress(value)) {
    throw new ApiError('BAD_REQUEST', `${value} is not an address`);
  }
  return normalizeAddress(value);
}

async function getTokenPolicies(context: RegistryContext, chainId: string): Promise<Response> {
  const policies = await readTokenPolicies(context.db, chainIdOf(chainId));
  return jsonResponse(policies, { headers: registryHeaders(policies.registryVersion) });
}

async function getTokenPolicy(context: RegistryContext, chainId: string, tokenAddress: string): Promise<Response> {
  const policy = await readTokenPolicy(context.db, chainIdOf(chainId), tokenAddressOf(tokenAddress));
  return jsonResponse(policy, { headers: registryHeaders(policy.registryVersion) });
}

/*
 * Sets the decision for one token. Asking for the decision already in force
 * answers `changed: false` and writes nothing, so a retried or repeated
 * request is safe; a change is committed with its audit event before it is
 * answered.
 */
async function patchTokenPolicy(
  context: RegistryContext,
  chainId: string,
  tokenAddress: string,
  decision: { isStrategic: boolean, reason: string },
): Promise<Response> {
  const result = await setTokenPolicy(context.db, {
    chainId:      chainIdOf(chainId),
    tokenAddress: tokenAddressOf(tokenAddress),
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

async function loadCatalog(context: RegistryContext): Promise<Catalog> {
  try {
    return await context.catalog.load();
  } catch (error) {
    if (isRegistryUnavailable(error)) {
      if (error.reason === 'not_active') {
        throw new ApiError('REGISTRY_NOT_ACTIVE', `No active registry snapshot is available`);
      }
      // the client is told only that the registry could not be read; why goes to the logs
      context.debug.error(`the token list could not read the registry`, { error, cause: error.cause });
      throw new ApiError('UPSTREAM_UNAVAILABLE', `the comet registry could not be read`);
    }
    throw error;
  }
}

/*
 * The strategic decisions of a chain. A database that does not answer is an
 * outage the client is told about, and fails open on: without them, a
 * strategic token below the threshold would be listed as hidden.
 */
async function strategicTokens(context: RegistryContext, chainId: number): Promise<Set<Address>> {
  try {
    return await readStrategicTokens(context.db, chainId);
  } catch (error) {
    if (isUnreachable(error)) {
      context.debug.error(`the token list could not read the token policies`, { chainId, error });
      throw new ApiError('UPSTREAM_UNAVAILABLE', `the token policies could not be read`);
    }
    throw error;
  }
}

/*
 * `GET /registry/v1/networks/{chainId}/tokens[?visibleOnly=true]`: every token
 * the active version serves on a chain, with its strategic decision, its
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
  const catalog     = await loadCatalog(context);
  const registryVersion = { id: catalog.versionId, checksum: catalog.checksum };

  const network = catalog.networks().find(entry => entry.chainId === chainId);
  if (network === undefined) {
    throw new ApiError('NOT_FOUND', `chain ${chainId} is not part of the active registry`, { registryVersion }, registryHeaders(registryVersion));
  }
  // the catalog only holds networks this API can name
  const name      = network.key as KnownNetwork.Name;
  const positions = positionsOf(catalog, name);
  const valuing   = collateralView(context.tokens, { chainId, network: name, positions, versionId: catalog.versionId });
  /*
   * The valuation may start a minute every other request of the isolate
   * waits for, so it is not cancelled when this request answers first —
   * which a refusal to read the policies does.
   */
  context.tokens.waitUntil(valuing);
  const [ strategic, view ] = await Promise.all([ strategicTokens(context, chainId), valuing ]);

  const list = tokenList({ registryVersion, chainId, catalog, network: name, positions, view, strategic, now: context.tokens.now() });
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
  tokenAddressOf,
  visibleOnlyOf,
};
