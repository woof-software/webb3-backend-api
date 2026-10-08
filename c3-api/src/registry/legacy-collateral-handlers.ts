import { Address, isAddress, normalizeAddress } from '../../lib/model/comet-registry.js';

import { ApiError } from '../http/errors.js';
import { jsonResponse } from '../http/json.js';

import { RegistryContext, chainIdOf } from './handlers.js';
import {
  DecisionList,
  LegacyCollateral,
  applyLegacyCollaterals,
  exportLegacyCollaterals,
  readLegacyCollateral,
  reviewLegacyCollaterals,
  setLegacyCollateral,
} from './legacy-collateral-repository.js';
import { registryHeaders } from './version-headers.js';

/*
 * The legacy collateral routes: which collaterals of which Comets an
 * administrator has marked legacy, and the audit of every change to that
 * decision. They are the token policy routes (token-handlers.ts) for a
 * collateral of a Comet in place of a token.
 *
 * A decision belongs to no registry version, but whether a collateral may
 * carry one is decided by the active version, so every answer names that
 * version, in headers and in the body, as the other registry routes do.
 *
 * A command records the decisions in force once it has committed, for an
 * outage to mark the active reads with (legacy-collaterals.ts).
 */

// an address in any case, stored and answered lowercase, as every address the registry holds
function addressOf(value: string): Address {
  if (!isAddress(value)) {
    throw new ApiError('BAD_REQUEST', `${value} is not an address`);
  }
  return normalizeAddress(value);
}

// a collateral, as a path names it: by its chain, its Comet and its token
function collateralOf(chainId: string, cometAddress: string, tokenAddress: string): LegacyCollateral {
  return { chainId: chainIdOf(chainId), cometAddress: addressOf(cometAddress), tokenAddress: addressOf(tokenAddress) };
}

async function getLegacyCollateral(
  context: RegistryContext,
  chainId: string,
  cometAddress: string,
  tokenAddress: string,
): Promise<Response> {
  const decision = await readLegacyCollateral(context.db, collateralOf(chainId, cometAddress, tokenAddress));
  return jsonResponse(decision, { headers: registryHeaders(decision.registryVersion) });
}

/*
 * Sets the decision for one collateral of one Comet. Asking for the decision
 * already in force answers `changed: false` and writes nothing, so a retried
 * or repeated request is safe; a change is committed with its audit event
 * before it is answered.
 */
async function patchLegacyCollateral(
  context: RegistryContext,
  chainId: string,
  cometAddress: string,
  tokenAddress: string,
  decision: { isLegacy: boolean, reason: string },
): Promise<Response> {
  const result = await setLegacyCollateral(context.db, {
    ...collateralOf(chainId, cometAddress, tokenAddress),
    isLegacy: decision.isLegacy,
    actor:    context.actor,
    reason:   decision.reason,
  });
  await context.recordLegacy();
  return jsonResponse(result, { headers: registryHeaders(result.registryVersion) });
}

/*
 * A list of decisions for every collateral at once: exported as a file,
 * edited, reviewed as the diff it would make, and applied in one transaction.
 * The export and the two commands speak the same body, so an exported file is
 * sent back as it is.
 */
async function getLegacyCollateralExport(context: RegistryContext): Promise<Response> {
  const list = await exportLegacyCollaterals(context.db);
  return jsonResponse(list, { headers: registryHeaders(list.registryVersion) });
}

async function postLegacyCollateralReview(context: RegistryContext, list: DecisionList): Promise<Response> {
  const review = await reviewLegacyCollaterals(context.db, list);
  return jsonResponse(review, { headers: registryHeaders(review.registryVersion) });
}

async function postLegacyCollateralApply(context: RegistryContext, list: DecisionList): Promise<Response> {
  const applied = await applyLegacyCollaterals(context.db, list, context.actor);
  await context.recordLegacy();
  return jsonResponse(applied, { headers: registryHeaders(applied.registryVersion) });
}

export {
  getLegacyCollateral,
  getLegacyCollateralExport,
  patchLegacyCollateral,
  postLegacyCollateralApply,
  postLegacyCollateralReview,
};
