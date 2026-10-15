import { jsonResponse } from '../http/json.js';

import {
  DecisionList,
  DeprecatedCollateral,
  applyDeprecatedCollaterals,
  exportDeprecatedCollaterals,
  readDeprecatedCollateral,
  reviewDeprecatedCollaterals,
  setDeprecatedCollateral,
} from './deprecated-collateral-repository.js';
import { RegistryContext, addressOf, chainIdOf } from './handlers.js';
import { registryHeaders } from './version-headers.js';

/*
 * The deprecated collateral routes: which collaterals of which Comets an
 * administrator has marked deprecated, and the audit of every change to that
 * decision. They and the token policy routes (token-handlers.ts) answer for
 * the two kinds of one store of decisions (decision-store.ts).
 *
 * A decision belongs to no registry version, but whether a collateral may
 * carry one is decided by the active version, so every answer names that
 * version, in headers and in the body, as the other registry routes do.
 *
 * A command records the decisions in force once it has committed, for an
 * outage to mark the active reads with (deprecated-collaterals.ts).
 */

// a collateral, as a path names it: by its chain, its Comet and its token
function collateralOf(chainId: string, cometAddress: string, tokenAddress: string): DeprecatedCollateral {
  return { chainId: chainIdOf(chainId), cometAddress: addressOf(cometAddress), tokenAddress: addressOf(tokenAddress) };
}

async function getDeprecatedCollateral(
  context: RegistryContext,
  chainId: string,
  cometAddress: string,
  tokenAddress: string,
): Promise<Response> {
  const decision = await readDeprecatedCollateral(context.db, collateralOf(chainId, cometAddress, tokenAddress));
  return jsonResponse(decision, { headers: registryHeaders(decision.registryVersion) });
}

/*
 * Sets the decision for one collateral of one Comet. Asking for the decision
 * already in force answers `changed: false` and writes nothing, so a retried
 * or repeated request is safe; a change is committed with its audit event
 * before it is answered.
 */
async function patchDeprecatedCollateral(
  context: RegistryContext,
  chainId: string,
  cometAddress: string,
  tokenAddress: string,
  decision: { isDeprecated: boolean, reason: string },
): Promise<Response> {
  const result = await setDeprecatedCollateral(context.db, {
    ...collateralOf(chainId, cometAddress, tokenAddress),
    isDeprecated: decision.isDeprecated,
    actor:        context.actor,
    reason:       decision.reason,
  });
  await context.recordDeprecated();
  return jsonResponse(result, { headers: registryHeaders(result.registryVersion) });
}

/*
 * A list of decisions for every collateral at once: exported as a file,
 * edited, reviewed as the diff it would make, and applied in one transaction.
 * The export and the two commands speak the same body, so an exported file is
 * sent back as it is.
 */
async function getDeprecatedCollateralExport(context: RegistryContext): Promise<Response> {
  const list = await exportDeprecatedCollaterals(context.db);
  return jsonResponse(list, { headers: registryHeaders(list.registryVersion) });
}

async function postDeprecatedCollateralReview(context: RegistryContext, list: DecisionList): Promise<Response> {
  const review = await reviewDeprecatedCollaterals(context.db, list);
  return jsonResponse(review, { headers: registryHeaders(review.registryVersion) });
}

async function postDeprecatedCollateralApply(context: RegistryContext, list: DecisionList): Promise<Response> {
  const applied = await applyDeprecatedCollaterals(context.db, list, context.actor);
  await context.recordDeprecated();
  return jsonResponse(applied, { headers: registryHeaders(applied.registryVersion) });
}

export {
  getDeprecatedCollateral,
  getDeprecatedCollateralExport,
  patchDeprecatedCollateral,
  postDeprecatedCollateralApply,
  postDeprecatedCollateralReview,
};
