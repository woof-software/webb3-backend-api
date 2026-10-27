import { jsonResponse } from '../http/json.js';

import { RegistryContext, marketOfChain } from './handlers.js';
import type { MarketDecisionList } from './inactive-market-repository.js';
import {
  applyInactiveMarkets,
  exportInactiveMarkets,
  readInactiveMarket,
  reviewInactiveMarkets,
  setInactiveMarket,
} from './inactive-market-repository.js';
import { INACTIVE_RECORD } from './inactive-markets.js';
import { registryHeaders } from './version-headers.js';

/*
 * The routes of the decisions about a market (inactive-market-repository.ts):
 * which markets an administrator has marked inactive, and the audit of every
 * change to such a decision, answered as the routes of the decisions about a
 * collateral are (collateral-decision-handlers.ts).
 *
 * A decision belongs to no registry version, but whether a market may carry
 * one is decided by the active version, so every answer names that version,
 * in headers and in the body, as the other registry routes do.
 *
 * A command records the decisions in force once it has committed, for an
 * outage to answer /summary with (inactive-markets.ts).
 */

async function getInactiveMarket(context: RegistryContext, chainId: string, cometAddress: string): Promise<Response> {
  const decision = await readInactiveMarket(context.db, marketOfChain(chainId, cometAddress));
  return jsonResponse(decision, { headers: registryHeaders(decision.registryVersion) });
}

/*
 * Asking for the decision already in force answers `changed: false` and
 * writes nothing, so a retried or repeated request is safe; a change is
 * committed with its audit event before it is answered.
 */
async function patchInactiveMarket(
  context: RegistryContext,
  chainId: string,
  cometAddress: string,
  decision: { isInactive: boolean, reason: string },
): Promise<Response> {
  const result = await setInactiveMarket(context.db, {
    ...marketOfChain(chainId, cometAddress),
    isInactive: decision.isInactive,
    actor:      context.actor,
    reason:     decision.reason,
  });
  await context.record(INACTIVE_RECORD);
  return jsonResponse(result, { headers: registryHeaders(result.registryVersion) });
}

/*
 * A list of decisions for every market at once: exported as a file, edited,
 * reviewed as the diff it would make, and applied in one transaction. The
 * export and the two commands speak the same body, so an exported file is
 * sent back as it is.
 */
async function getInactiveMarketExport(context: RegistryContext): Promise<Response> {
  const list = await exportInactiveMarkets(context.db);
  return jsonResponse(list, { headers: registryHeaders(list.registryVersion) });
}

async function postInactiveMarketReview(context: RegistryContext, list: MarketDecisionList): Promise<Response> {
  const review = await reviewInactiveMarkets(context.db, list);
  return jsonResponse(review, { headers: registryHeaders(review.registryVersion) });
}

async function postInactiveMarketApply(context: RegistryContext, list: MarketDecisionList): Promise<Response> {
  const applied = await applyInactiveMarkets(context.db, list, context.actor);
  await context.record(INACTIVE_RECORD);
  return jsonResponse(applied, { headers: registryHeaders(applied.registryVersion) });
}

export {
  getInactiveMarket,
  getInactiveMarketExport,
  patchInactiveMarket,
  postInactiveMarketApply,
  postInactiveMarketReview,
};
