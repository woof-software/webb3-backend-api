import * as Key from "../../symbolic/key.js";
import * as Index from "../../symbolic/index.js";
import * as Compute from "../../symbolic/computation.js";
import * as Fallible from "../../fallible/fallible.js";

import type { MarketLatestSummary } from "./market-latest-summary.js";

type MarketMinutelySummary = Compute.Spec<{
  name: "marketMinutelySummary";
  depends: [MarketLatestSummary];
  expects: MarketLatestSummary["expects"];
  returns: MarketLatestSummary["returns"];
}>;

const { implement, pull1 } = Compute.Functor<MarketMinutelySummary>({});
const marketMinutelySummary = implement({
  // 9: the latest summary, with base_price and the totals in USD.
  // Not 7: dev caches that answer without the totals in USD. Not 8: this branch caches it without base_price.
  // Two deployments of develop can share the KV.
  version: 9,
  index: Index.MinutelyBlockIndex,
  key(name, {block, ...context}) {
    const { block: projected } = Fallible.must(this.index.project({ block, ...context }));
    return Key.toKey(name, { block: projected.number, ...context });
  },
  compute({ apiHost, nodeHost, nodeKey, contract, network, block }) {
    const projected = Fallible.must(this.index.project({ apiHost, nodeHost, nodeKey, contract, network, block }));

    return pull1(
      { marketLatestSummary: projected },
    );
  }
});

export { MarketMinutelySummary, marketMinutelySummary };
