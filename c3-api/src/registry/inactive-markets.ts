import { isAddress, normalizeAddress } from '../../lib/model/comet-registry.js';

import type { RecordedKind } from './collateral-decisions.js';
import { digestOf } from './collateral-decisions.js';
import type { MarketOfChain } from './inactive-market-repository.js';
import { INACTIVE_MARKET_KIND, chainCometKey, readInactiveMarkets } from './inactive-market-repository.js';

/*
 * The markets an administrator has marked inactive
 * (inactive-market-repository.ts), as /summary carries them: read on every
 * request, every chain's in one statement, and during an outage from the
 * record the Worker keeps of them in KV, as it keeps one of each kind of
 * decision about collaterals (collateral-decisions.ts, which keeps every
 * record the same way). The active reads of /registry/v1 do not carry them,
 * so only /summary reads and the kind's own commands keep the record.
 */

// the markets marked inactive: a market nobody has decided about, or one decided otherwise, is not among them
type InactiveMarkets = {
  markets: MarketOfChain[],
  // whether the decisions name the market, its Comet lowercase
  has:     (market: MarketOfChain) => boolean,
  // what tells two sets of decisions apart
  digest:  string,
};

function inactiveMarketsOf(markets: MarketOfChain[]): InactiveMarkets {
  const keys = markets.map(chainCometKey);
  const held = new Set(keys);
  return {
    markets,
    has:    market => held.has(chainCometKey(market)),
    digest: digestOf(keys),
  };
}

// every chain's inactive markets, and when they were recorded; like the other records, it does not expire
const INACTIVE_KEY = 'inactive-markets:v1';

type InactiveRecord = { at: string, markets: MarketOfChain[] };

function marketsIn(value: unknown): MarketOfChain[] | null {
  const record = value as InactiveRecord | null;
  if (record === null || typeof(record) !== 'object' || typeof(record.at) !== 'string' || !Array.isArray(record.markets)) {
    return null;
  }
  const markets = record.markets as unknown[];
  const valid = markets.every(entry => {
    const market = entry as Partial<MarketOfChain> | null;
    return market !== null && typeof(market) === 'object'
      && typeof(market.chainId) === 'number' && Number.isSafeInteger(market.chainId) && market.chainId > 0
      && isAddress(market.cometAddress);
  });
  return valid
    ? record.markets.map(({ chainId, cometAddress }) => ({ chainId, cometAddress: normalizeAddress(cometAddress) }))
    : null;
}

// made once, here: what an isolate knows of the record is kept in it, so one made anew would know nothing
const INACTIVE_RECORD: RecordedKind<InactiveMarkets> = {
  key:         INACTIVE_KEY,
  noun:        INACTIVE_MARKET_KIND.label,
  read:        async db => inactiveMarketsOf(await readInactiveMarkets(db)),
  decisionsIn: value => {
    const markets = marketsIn(value);
    return markets === null ? null : inactiveMarketsOf(markets);
  },
  recordOf:    (decisions, at): InactiveRecord => ({ at, markets: decisions.markets }),
  known:       new WeakMap(),
};

export type { InactiveMarkets };
export { INACTIVE_KEY, INACTIVE_RECORD, inactiveMarketsOf };
