import { jsonResponse } from '../http/json.js';

import { RegistryContext, addressOf, chainIdOf } from './handlers.js';
import {
  DecisionList,
  HiddenCollateral,
  applyHiddenCollaterals,
  exportHiddenCollaterals,
  readHiddenCollateral,
  reviewHiddenCollaterals,
  setHiddenCollateral,
} from './hidden-collateral-repository.js';
import { registryHeaders } from './version-headers.js';

/*
 * The hidden collateral routes: which collaterals of which Comets an
 * administrator has hidden, and the audit of every change to that decision.
 * They answer as the deprecated collateral routes do
 * (deprecated-collateral-handlers.ts), for another kind of the same store of
 * decisions (decision-store.ts).
 *
 * A decision belongs to no registry version, but whether a collateral may
 * carry one is decided by the active version, so every answer names that
 * version, in headers and in the body, as the other registry routes do.
 *
 * A command records the decisions in force once it has committed, for an
 * outage to answer with (deprecated-collaterals.ts).
 */

// a collateral, as a path names it: by its chain, its Comet and its token
function collateralOf(chainId: string, cometAddress: string, tokenAddress: string): HiddenCollateral {
  return { chainId: chainIdOf(chainId), cometAddress: addressOf(cometAddress), tokenAddress: addressOf(tokenAddress) };
}

async function getHiddenCollateral(
  context: RegistryContext,
  chainId: string,
  cometAddress: string,
  tokenAddress: string,
): Promise<Response> {
  const decision = await readHiddenCollateral(context.db, collateralOf(chainId, cometAddress, tokenAddress));
  return jsonResponse(decision, { headers: registryHeaders(decision.registryVersion) });
}

/*
 * Sets the decision for one collateral of one Comet. Asking for the decision
 * already in force answers `changed: false` and writes nothing, so a retried
 * or repeated request is safe; a change is committed with its audit event
 * before it is answered.
 */
async function patchHiddenCollateral(
  context: RegistryContext,
  chainId: string,
  cometAddress: string,
  tokenAddress: string,
  decision: { isHidden: boolean, reason: string },
): Promise<Response> {
  const result = await setHiddenCollateral(context.db, {
    ...collateralOf(chainId, cometAddress, tokenAddress),
    isHidden: decision.isHidden,
    actor:    context.actor,
    reason:   decision.reason,
  });
  await context.recordHidden();
  return jsonResponse(result, { headers: registryHeaders(result.registryVersion) });
}

/*
 * A list of decisions for every collateral at once: exported as a file,
 * edited, reviewed as the diff it would make, and applied in one transaction.
 * The export and the two commands speak the same body, so an exported file is
 * sent back as it is.
 */
async function getHiddenCollateralExport(context: RegistryContext): Promise<Response> {
  const list = await exportHiddenCollaterals(context.db);
  return jsonResponse(list, { headers: registryHeaders(list.registryVersion) });
}

async function postHiddenCollateralReview(context: RegistryContext, list: DecisionList): Promise<Response> {
  const review = await reviewHiddenCollaterals(context.db, list);
  return jsonResponse(review, { headers: registryHeaders(review.registryVersion) });
}

async function postHiddenCollateralApply(context: RegistryContext, list: DecisionList): Promise<Response> {
  const applied = await applyHiddenCollaterals(context.db, list, context.actor);
  await context.recordHidden();
  return jsonResponse(applied, { headers: registryHeaders(applied.registryVersion) });
}

export {
  getHiddenCollateral,
  getHiddenCollateralExport,
  patchHiddenCollateral,
  postHiddenCollateralApply,
  postHiddenCollateralReview,
};
