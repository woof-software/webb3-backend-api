import type * as KnownNetwork from '../../lib/well-known/networks/network.js';
import { throttleBy } from '../../lib/throttle.js';

import { checksumAddress, normalizeAddress } from '../../lib/model/comet-registry.js';
import type { Address, BlockRefV1, CollateralValueStatusV1, PriceExceptionV1 } from '../../lib/model/comet-registry.js';
import type { ValuedCollateral } from '../../lib/computations/market/market-latest-summary.js';

import type { CacheDeps } from './cache.js';
import type { Catalog, RegistryComet } from './catalog.js';
import { nowOf } from './clock.js';
import { DEPRECATED_RECORD, HIDDEN_RECORD, collateralDecisionsOf, markedDecisions } from './collateral-decisions.js';
import type { CollateralRead } from './collateral-decisions.js';
import { readStrategicTokensByChain } from './token-policy-repository.js';
import { chainTokensOf, decimalString, visibilityHere } from './token-visibility.js';
import type { ChainToken } from './token-visibility.js';
import { staleHeaders } from './version-headers.js';

/*
 * What /summary says of each collateral beside what it read of the market,
 * written flat on the collateral: what holds of its token on the chain, the
 * collateral's own value in this market, and whether discovery shows the
 * token here. A field about the token across its chain says `network` in its
 * name, since on a market it would read as the market's own; the value is
 * the collateral's in this market, and says `collateral`. `is_visible` is
 * whether discovery shows the token, not whether this market offers it, and
 * is the market's own: the rule asked with whether this market's Comet hides
 * the token and whether it has it deprecated, the chain's strategic mark, and
 * that value (token-visibility.ts, visibilityHere).
 *
 * The value is what the summary read of the market, at the market's own block,
 * and the time it was read at is that block's: both are read with the market
 * (marketLatestSummary) and cached with its summary of the minute
 * (marketMinutelySummary), a header the node did not give included. The
 * decisions are read with every request, and the fields added once the
 * computations have answered, as the labels of a market are (market.ts,
 * described), so no cache key holds a decision.
 */

// every chain's strategic tokens, by chain id
type StrategicTokens = ReadonlyMap<number, ReadonlySet<Address>>;

// the decisions of administrators, every chain's, or null where they could not be read
type SummaryDecisions = {
  deprecated: CollateralRead | null,
  hidden:     CollateralRead | null,
  strategic:  StrategicTokens | null,
};

// what the router hands the summary: the read of the decisions, which a request makes once for all its networks
type SummaryTokens = {
  decisions: () => Promise<SummaryDecisions>,
};

/*
 * When this isolate says it could not read a kind of decision, per database
 * binding: once a minute, as the cache says it answers from an older version,
 * rather than once a request, since the summary is still answered on every
 * request of an outage.
 */
const unreadDue = throttleBy<D1Database>(60_000);

/*
 * The decisions, every kind read at once. No read fails the summary: on the
 * legacy router a database fault would be a 500 of every market's summary. A
 * read that failed leaves out the fields it decides on every request, and is
 * logged under the id of the request that found it (unreadDue). The
 * deprecated and the hidden decisions are read as /registry/v1/active reads
 * them, and come from the records the worker keeps while D1 cannot be
 * reached; the strategic ones have no such record.
 */
async function summaryDecisions(deps: CacheDeps, requestId: string): Promise<SummaryDecisions> {
  const unread = (decisions: string) => (error: unknown) => {
    if (unreadDue(deps.db, decisions, nowOf(deps.now).getTime())) {
      deps.debug.error(`the summary could not read the ${decisions}`, { requestId, error });
    }
    return null;
  };
  const [ deprecated, hidden, strategic ] = await Promise.all([
    markedDecisions(DEPRECATED_RECORD, deps).catch(unread('deprecated collateral decisions')),
    markedDecisions(HIDDEN_RECORD, deps).catch(unread('hidden collateral decisions')),
    readStrategicTokensByChain(deps.db).catch(unread('token policies')),
  ]);
  return { deprecated, hidden, strategic };
}

/*
 * Collaterals marked by the deprecated or the hidden decisions the worker
 * last recorded, because D1 could not give them, are not confirmed, and the
 * answer says so as /registry/v1/active does; the legacy router sets the
 * version's own age over it where the version came from the cache too.
 */
function summaryHeaders({ deprecated, hidden }: SummaryDecisions): Record<string, string> {
  return staleHeaders(deprecated?.recorded || hidden?.recorded ? 0 : null);
}

// every token of a chain, by address, and the decisions it was made with
type ChainTokens = {
  chainId:   number,
  tokens:    ReadonlyMap<Address, ChainToken>,
  decisions: SummaryDecisions,
};

/*
 * The tokens of a chain, with what holds of them across it. A kind of
 * decision that could not be read is taken as no decision, and what it
 * decides is left out of every collateral (collateralFields).
 */
function chainTokens(catalog: Catalog, network: KnownNetwork.Name, chainId: number, decisions: SummaryDecisions): ChainTokens {
  const tokens = chainTokensOf({
    chainId,
    catalog,
    network,
    strategic:  decisions.strategic?.get(chainId) ?? new Set(),
    deprecated: decisions.deprecated?.decisions ?? collateralDecisionsOf([]),
    hidden:     decisions.hidden?.decisions ?? collateralDecisionsOf([]),
  });
  return { chainId, tokens: new Map(tokens.map(token => [ token.address, token ])), decisions };
}

// what the summary read of a collateral's value: its value in USD, or null, and the exception that priced it
type Valued = Pick<ValuedCollateral, 'valueUsd' | 'exception'>;

/*
 * The price exception that priced a collateral, as the version that answers
 * describes it, where the summary read names it by what it does and to which
 * feed: the summary may have been read under another version that describes
 * it otherwise. Each version it is answered with holds it, since what keys
 * the summary, the market's digest, takes in every exception of its network
 * but why it was added and until when it applies (catalog.ts, marketDigest),
 * and a network has one exception for a feed. Its expiry is an instant, which
 * a version stored before expiries were normalized may state with an offset;
 * the catalog has already dropped an expiry it cannot parse, so this one
 * parses.
 */
function exceptionsOf({ exception }: Valued, described: readonly PriceExceptionV1[]) {
  const applied = exception === null ? [] : described.filter(each => each.kind === exception.kind && each.priceFeedAddress === exception.priceFeedAddress);
  return applied.map(each => ({
    kind:               each.kind,
    price_feed_address: checksumAddress(each.priceFeedAddress),
    provenance:         each.provenance,
    // null where the exception does not expire: that is known, not left out
    expires_at:         each.expiresAt === null ? null : new Date(Date.parse(each.expiresAt)).toISOString(),
  }));
}

/*
 * One collateral's token under the summary's names, after what was read of
 * it: its name and decimals; `is_deprecated` and `is_hidden`, the decisions of
 * this market's Comet, as /registry/v1/active marks its collateral; what holds
 * of the token across the chain; the collateral's value in this market; and
 * whether discovery shows it here (visibilityHere). A field whose decision
 * could not be read is left out, and so is a value that is not known: never
 * null, as the summary leaves out whatever it cannot give. A value is read
 * with the market, at its block, and never carried over from an earlier
 * minute, so it is never stale; where the node did not give that block's
 * header, the block, the time and the age are left out, and the value stays.
 *
 * Whether discovery shows the token is said wherever the decisions read settle
 * it, whichever way those that could not be read went, and why only where they
 * settle that as well (visibilityHere): one this Comet hides or has
 * deprecated, or one that is not strategic and is worth less than the
 * threshold here, is said not to be shown here even when this Comet's other
 * decisions about it could not be read, since a client that is told nothing
 * shows the token; and one this Comet neither hides nor deprecates, worth the
 * threshold here or of a value that cannot be read, is said to be shown even
 * when the strategic marks could not be.
 */
function collateralFields(
  token: ChainToken,
  { chainId, decisions }: ChainTokens,
  comet: Address,
  valued: Valued,
  block: BlockRefV1 | null,
  described: readonly PriceExceptionV1[],
) {
  const { deprecated, hidden, strategic } = decisions;
  const { valueUsd, exception } = valued;
  const collateral   = { chainId, cometAddress: comet, tokenAddress: token.address };
  const isHidden     = hidden === null ? null : hidden.decisions.has(collateral);
  const isDeprecated = deprecated === null ? null : deprecated.decisions.has(collateral);
  const isStrategic  = strategic === null ? null : token.isStrategic;
  const visibility   = visibilityHere({ isHidden, isDeprecated, isStrategic }, { valueUsd });
  const status: CollateralValueStatusV1 = valueUsd === null ? 'unavailable' : exception === null ? 'fresh' : 'exception';
  return {
    name:     token.name,
    decimals: token.decimals,
    ...(isDeprecated === null ? {} : {
      is_deprecated:         isDeprecated,
      is_network_deprecated: token.isDeprecated,
      deprecated_in:         token.deprecatedIn.map(address => checksumAddress(address)),
    }),
    ...(isHidden === null ? {} : {
      is_hidden: isHidden,
      hidden_in: token.hiddenIn.map(address => checksumAddress(address)),
    }),
    ...(isStrategic === null ? {} : { is_strategic: isStrategic }),
    network_roles: token.roles,
    ...(valueUsd === null ? {} : { collateral_value_usd: decimalString(valueUsd) }),
    collateral_value_status: status,
    ...(valueUsd === null || block === null ? {} : {
      collateral_value_at:                new Date(block.timestamp * 1000).toISOString(),
      collateral_value_block:             { number: block.number, timestamp: block.timestamp },
      collateral_value_stale_age_seconds: 0,
    }),
    collateral_value_exceptions: exceptionsOf(valued, described),
    ...(visibility.isVisible        === undefined ? {} : { is_visible: visibility.isVisible }),
    ...(visibility.visibilityReason === undefined ? {} : { visibility_reason: visibility.visibilityReason }),
  };
}

/*
 * A collateral as the summary read it: its token's address, checksummed, its
 * symbol and its status, and its value with the exception that priced it,
 * which the summary answers in fields of its own (collateralFields).
 */
type SummaryCollateral = { address: string, symbol: string, status: string, message?: string } & Valued;

/*
 * A market of the summary with each collateral's token fields, and without
 * what they were made of: each collateral's value as it was read, and the
 * block the market was read at, which no answer carries as they are. A
 * market the chain has not reached has no collaterals, nor a block
 * (market.ts, unreachedMarket), and is answered as it was.
 */
function withTokenFields<Entry extends { collaterals?: SummaryCollateral[], market_block?: BlockRefV1 | null }>(
  { market_block: block = null, ...entry }: Entry,
  contract: RegistryComet,
  chain: ChainTokens,
) {
  if (entry.collaterals === undefined) {
    return entry;
  }
  const comet = normalizeAddress(contract.address);
  return {
    ...entry,
    collaterals: entry.collaterals.map(({ valueUsd, exception, ...collateral }) => {
      const token = chain.tokens.get(normalizeAddress(collateral.address));
      return token === undefined
        ? collateral
        : { ...collateral, ...collateralFields(token, chain, comet, { valueUsd, exception }, block, contract.registry.priceExceptions) };
    }),
  };
}

export type { ChainTokens, StrategicTokens, SummaryDecisions, SummaryTokens };
export { chainTokens, summaryDecisions, summaryHeaders, withTokenFields };
