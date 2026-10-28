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
  // 11: the latest summary, where a remap fell back, leaving its collateral's value unknown and naming the remap.
  // 7 to 10 are taken in the KV two deployments of develop can share: 7 to 9 by values of other shapes, 10 by values of the rule 11 changes.
  version: 11,
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
