import * as evm    from '../../lib/computations/evm.js';
import * as comet  from '../../lib/computations/comet.js';
import * as market from '../../lib/computations/market.js';

import { collateralDecisionsOf } from '../../src/registry/collateral-decisions.js';
import { SUMMARY_DEADLINE_MS } from '../../src/registry/summary-tokens.js';
import type { SummaryDecisions, SummaryTokens } from '../../src/registry/summary-tokens.js';
import { DEADLINE_MS } from '../../src/registry/token-collateral.js';
import type { TokenCollateralDeps } from '../../src/registry/token-collateral.js';

import { evaluatorOver, memoryCache } from './evaluator.js';
import { MemoryKv } from './kv.js';

/*
 * The dependencies of one isolate's collateral valuation, which is what one KV
 * binding object is: the real computations on the evaluator the token list
 * runs, over a cache of the isolate's own, reading whatever node the global
 * fetch reaches. What it hands to waitUntil is kept, so a test can wait for
 * the work a request left running.
 */
function tokenCollateralDeps(
  kv: KVNamespace,
  overrides: Partial<TokenCollateralDeps> = {},
): TokenCollateralDeps & { background: Array<Promise<unknown>> } {
  const cache = memoryCache();
  const background: Array<Promise<unknown>> = [];
  return {
    frame:           { apiHost: '', nodeHost: 'node.test', nodeKey: 'key' },
    evaluator:       () => evaluatorOver({ ...evm, ...comet, ...market }, { cache }),
    kv:              () => kv,
    maxStaleMinutes: 15,
    now:             () => new Date(),
    debug:           { error: () => {} },
    waitUntil:       work => { background.push(work); },
    deadlineMs:      DEADLINE_MS,
    background,
    ...overrides,
  };
}

// decisions that were read, and that decide nothing: no token is strategic, and no collateral deprecated or hidden
const NO_DECISIONS: SummaryDecisions = {
  deprecated: { decisions: collateralDecisionsOf([]), recorded: false },
  hidden:     { decisions: collateralDecisionsOf([]), recorded: false },
  strategic:  new Map(),
};

/*
 * What the router hands the summary, for a test that calls its handler: one
 * isolate's valuation, over a KV of its own, with the summary's deadline, and
 * the decisions the test gives.
 */
function summaryTokens(
  overrides: Partial<TokenCollateralDeps> = {},
  decisions: SummaryDecisions = NO_DECISIONS,
): SummaryTokens & { collateral: ReturnType<typeof tokenCollateralDeps> } {
  return {
    collateral: tokenCollateralDeps(MemoryKv({}), { deadlineMs: SUMMARY_DEADLINE_MS, ...overrides }),
    decisions:  async () => decisions,
  };
}

export { summaryTokens, tokenCollateralDeps };
