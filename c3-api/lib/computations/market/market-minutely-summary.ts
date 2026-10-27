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
  // 10: the latest summary, with each collateral's value in USD and the block the market was read at.
  // 7 to 9 are taken by values of other shapes in the KV two deployments of develop can share.
  version: 10,
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
