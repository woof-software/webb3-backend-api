import { collateralDecisionsOf } from '../../src/registry/collateral-decisions.js';
import type { SummaryDecisions, SummaryTokens } from '../../src/registry/summary-tokens.js';

// decisions that were read, and that decide nothing: no token is strategic, and no collateral deprecated or hidden
const NO_DECISIONS: SummaryDecisions = {
  deprecated: { decisions: collateralDecisionsOf([]), recorded: false },
  hidden:     { decisions: collateralDecisionsOf([]), recorded: false },
  strategic:  new Map(),
};

// what the router hands the summary, for a test that calls its handler: the decisions the test gives
function summaryTokens(decisions: SummaryDecisions = NO_DECISIONS): SummaryTokens {
  return { decisions: async () => decisions };
}

export { NO_DECISIONS, summaryTokens };
