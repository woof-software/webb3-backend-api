import { jsonResponse } from '../http/json.js';

import type { CollateralDecisionKind, CollateralDecisionList } from './collateral-decision-repository.js';
import {
  applyCollaterals,
  exportCollaterals,
  member,
  readCollateral,
  reviewCollaterals,
  setCollateral,
} from './collateral-decision-repository.js';
import type { RecordedKind } from './collateral-decisions.js';
import { RegistryContext, collateralOf } from './handlers.js';
import { registryHeaders } from './version-headers.js';

/*
 * The routes of the decisions about a collateral of a Comet, each answering
 * for the kind it is given (collateral-decision-repository.ts): which
 * collaterals of which Comets an administrator has marked deprecated, and
 * which ones hidden, and the audit of every change to such a decision. They
 * and the token policy routes (token-handlers.ts) answer for the kinds of one
 * store of decisions (decision-store.ts).
 *
 * A decision belongs to no registry version, but whether a collateral may
 * carry one is decided by the active version, so every answer names that
 * version, in headers and in the body, as the other registry routes do.
 *
 * A command records its kind's decisions in force once it has committed, for
 * an outage to mark the active reads with (collateral-decisions.ts).
 */

async function getCollateral<Flag extends string, Column extends string, Rows extends string>(
  context: RegistryContext,
  kind: CollateralDecisionKind<Flag, Column, Rows>,
  chainId: string,
  cometAddress: string,
  tokenAddress: string,
): Promise<Response> {
  const decision = await readCollateral(context.db, kind, collateralOf(chainId, cometAddress, tokenAddress));
  return jsonResponse(decision, { headers: registryHeaders(decision.registryVersion) });
}

/*
 * Asking for the decision already in force answers `changed: false` and
 * writes nothing, so a retried or repeated request is safe; a change is
 * committed with its audit event before it is answered.
 */
async function patchCollateral<Flag extends string, Column extends string, Rows extends string>(
  context: RegistryContext,
  kind: CollateralDecisionKind<Flag, Column, Rows>,
  record: RecordedKind,
  chainId: string,
  cometAddress: string,
  tokenAddress: string,
  decision: { flag: boolean, reason: string },
): Promise<Response> {
  const result = await setCollateral(context.db, kind, {
    ...collateralOf(chainId, cometAddress, tokenAddress),
    ...member(kind.flag, decision.flag),
    actor:  context.actor,
    reason: decision.reason,
  });
  await context.record(record);
  return jsonResponse(result, { headers: registryHeaders(result.registryVersion) });
}

/*
 * A list of decisions for every collateral at once: exported as a file,
 * edited, reviewed as the diff it would make, and applied in one transaction.
 * The export and the two commands speak the same body, so an exported file is
 * sent back as it is.
 */
async function getCollateralExport<Flag extends string, Column extends string, Rows extends string>(
  context: RegistryContext,
  kind: CollateralDecisionKind<Flag, Column, Rows>,
): Promise<Response> {
  const list = await exportCollaterals(context.db, kind);
  return jsonResponse(list, { headers: registryHeaders(list.registryVersion) });
}

async function postCollateralReview<Flag extends string, Column extends string, Rows extends string>(
  context: RegistryContext,
  kind: CollateralDecisionKind<Flag, Column, Rows>,
  list: CollateralDecisionList<Flag>,
): Promise<Response> {
  const review = await reviewCollaterals(context.db, kind, list);
  return jsonResponse(review, { headers: registryHeaders(review.registryVersion) });
}

async function postCollateralApply<Flag extends string, Column extends string, Rows extends string>(
  context: RegistryContext,
  kind: CollateralDecisionKind<Flag, Column, Rows>,
  record: RecordedKind,
  list: CollateralDecisionList<Flag>,
): Promise<Response> {
  const applied = await applyCollaterals(context.db, kind, list, context.actor);
  await context.record(record);
  return jsonResponse(applied, { headers: registryHeaders(applied.registryVersion) });
}

export {
  getCollateral,
  getCollateralExport,
  patchCollateral,
  postCollateralApply,
  postCollateralReview,
};
