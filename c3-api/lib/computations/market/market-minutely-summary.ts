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
  // 5: the latest summary, with its totals in USD, reserves, the rate model and each collateral's price and parameters, and its collateral and base feed as the registry version describes them
  version: 5,
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
