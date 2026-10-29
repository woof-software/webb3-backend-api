import { DEPRECATED_RECORD, HIDDEN_RECORD } from '../../src/registry/collateral-decisions.js';
import { decisionSetOf } from '../../src/registry/decision-records.js';
import { INACTIVE_RECORD } from '../../src/registry/inactive-markets.js';
import type { SummaryDecisions } from '../../src/registry/summary-tokens.js';

// decisions that were read, and that decide nothing: no token is strategic, no collateral deprecated or hidden, and no market inactive
const NO_DECISIONS: SummaryDecisions = {
  deprecated: { decisions: decisionSetOf(DEPRECATED_RECORD, []), recorded: false },
  hidden:     { decisions: decisionSetOf(HIDDEN_RECORD, []), recorded: false },
  strategic:  new Map(),
  inactive:   { decisions: decisionSetOf(INACTIVE_RECORD, []), recorded: false },
};

// what the router hands the summary, for a test that calls its handler: the read of the decisions the test gives
function summaryDecisionsOf(decisions: SummaryDecisions = NO_DECISIONS): () => Promise<SummaryDecisions> {
  return async () => decisions;
}

export { NO_DECISIONS, summaryDecisionsOf };
