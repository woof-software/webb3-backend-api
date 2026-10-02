import { Address, isAddress, normalizeAddress } from '../../lib/model/comet-registry.js';

import { ApiError } from '../http/errors.js';
import { jsonResponse } from '../http/json.js';

import { RegistryContext, chainIdOf } from './handlers.js';
import {
  DecisionList,
  applyTokenPolicies,
  exportTokenPolicies,
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

export {
  getTokenPolicies,
  getTokenPolicy,
  getTokenPolicyExport,
  patchTokenPolicy,
  postTokenPolicyApply,
  postTokenPolicyReview,
  tokenAddressOf,
};
