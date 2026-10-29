import { isAddress, isChainId, normalizeAddress } from '../../lib/model/comet-registry.js';

import type { RecordedKind } from './decision-records.js';
import { readMarked } from './decision-store.js';
import type { MarketOfChain } from './inactive-market-repository.js';
import { INACTIVE_MARKET_KIND, INACTIVE_MARKET_TABLES, chainCometKey } from './inactive-market-repository.js';

/*
 * The markets an administrator has marked inactive
 * (inactive-market-repository.ts), as /summary carries them: read on every
 * request, every chain's in one statement, and during an outage from the
 * record the Worker keeps of them in KV, as it keeps one of each kind of
 * decision about collaterals (decision-records.ts). The active reads of
 * /registry/v1 do not carry them, so only /summary reads and the kind's own
 * commands keep the record.
 */

// the market an entry of the record names, its Comet lowercase as a decision names it
function recordedMarket(entry: unknown): MarketOfChain | null {
  const market = entry as Partial<MarketOfChain> | null;
  return market !== null && typeof(market) === 'object' && isChainId(market.chainId) && isAddress(market.cometAddress)
    ? { chainId: market.chainId, cometAddress: normalizeAddress(market.cometAddress) }
    : null;
}

const INACTIVE_KEY = INACTIVE_MARKET_KIND.recordKey;

const INACTIVE_RECORD: RecordedKind<MarketOfChain> = {
  key:       INACTIVE_KEY,
  noun:      INACTIVE_MARKET_KIND.label,
  member:    'markets',
  read:      db => readMarked(db, INACTIVE_MARKET_TABLES),
  keyOf:     chainCometKey,
  subjectOf: recordedMarket,
};

export { INACTIVE_KEY, INACTIVE_RECORD };
