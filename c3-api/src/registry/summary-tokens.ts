import type * as KnownNetwork from '../../lib/well-known/networks/network.js';
import { throttleBy } from '../../lib/throttle.js';

import { checksumAddress, normalizeAddress } from '../../lib/model/comet-registry.js';
import type { Address, TokenVisibilityV1 } from '../../lib/model/comet-registry.js';

import type { CacheDeps } from './cache.js';
import type { Catalog, RegistryComet } from './catalog.js';
import { nowOf } from './clock.js';
import { deprecatedDecisions, deprecatedDecisionsOf, hiddenDecisions, hiddenDecisionsOf } from './deprecated-collaterals.js';
import type { DeprecatedRead, HiddenRead } from './deprecated-collaterals.js';
import { collateralView, positionsOf } from './token-collateral.js';
import type { BlockRef, TokenCollateralDeps } from './token-collateral.js';
import { readStrategicTokensByChain } from './token-policy-repository.js';
import { tokenList, visibilityWith } from './token-visibility.js';

/*
 * What /summary says of each collateral beside what it read of the market:
 * every field the token list gives its token (token-handlers.ts), written flat
 * on the collateral. A field about the token across its chain says `network`
 * in its name, since on a market it would read as the market's own: the value
 * is what every enabled market of the chain holds. `is_visible` is whether
 * discovery shows the token, not whether this market offers it, and is the
 * market's own: the list's rule, with whether this market's Comet hides the
 * token and whether it has it deprecated in place of what the chain decides of
 * either (token-visibility.ts, visibilityWith).
 *
 * The values are the list's own, from the record of the chain's minute
 * (token-collateral.ts): valued at the latest block the summary read, or found
 * in the isolate or in KV where the list or another summary valued that minute
 * already. They are added once the computations have answered, as the labels
 * of a market are (market.ts, described), so no version or cache key of those
 * changes.
 */

// every chain's strategic tokens, by chain id
type StrategicTokens = ReadonlyMap<number, ReadonlySet<Address>>;

// the decisions of administrators, every chain's, or null where they could not be read
type SummaryDecisions = {
  deprecated: DeprecatedRead | null,
  hidden:     HiddenRead | null,
  strategic:  StrategicTokens | null,
};

/*
 * What the router hands the summary: what values a chain's collateral, as the
 * token list values it but with the summary's own deadline, and the read of
 * the decisions, which a request makes once for all its networks.
 */
type SummaryTokens = {
  collateral: TokenCollateralDeps,
  decisions:  () => Promise<SummaryDecisions>,
};

/*
 * How long a summary waits for a minute nobody has valued yet, where the token
 * list waits 4 seconds: every market of the summary waits for its chain's
 * collateral. A valuation the summary stops waiting for goes on, and the next
 * request of the minute answers from it.
 */
const SUMMARY_DEADLINE_MS = 2_000;

/*
 * When this isolate says it could not read a kind of decision, per database
 * binding: once a minute, as the cache says it answers from an older version,
 * rather than once a request, since the summary is still answered on every
 * request of an outage.
 */
const unreadDue = throttleBy<D1Database>(60_000);

/*
 * The decisions, every kind read at once. No read fails the summary, where
 * the token list answers 503 for it: on the legacy router a database fault
 * would be a 500 of every market's summary. A read that failed leaves out the
 * fields it decides on every request, and is logged under the id of the
 * request that found it (unreadDue). The deprecated and the hidden decisions
 * are read as /registry/v1/active reads them, and come from the records the
 * worker keeps while D1 cannot be reached; the strategic ones have no such
 * record.
 */
async function summaryDecisions(deps: CacheDeps, requestId: string): Promise<SummaryDecisions> {
  const unread = (decisions: string) => (error: unknown) => {
    if (unreadDue(deps.db, decisions, nowOf(deps.now).getTime())) {
      deps.debug.error(`the summary could not read the ${decisions}`, { requestId, error });
    }
    return null;
  };
  const [ deprecated, hidden, strategic ] = await Promise.all([
    deprecatedDecisions(deps).catch(unread('deprecated collateral decisions')),
    hiddenDecisions(deps).catch(unread('hidden collateral decisions')),
    readStrategicTokensByChain(deps.db).catch(unread('token policies')),
  ]);
  return { deprecated, hidden, strategic };
}

// the token list's entry of every token of a chain, by address, and the decisions it was made with
type ChainTokens = {
  chainId:   number,
  tokens:    ReadonlyMap<Address, TokenVisibilityV1>,
  decisions: SummaryDecisions,
};

/*
 * The token list of a chain at the latest block the summary read, made as the
 * list makes it. A decision that could not be read is taken as none, and what
 * it decides is left out of every collateral (collateralFields).
 */
async function chainTokens(
  deps: TokenCollateralDeps,
  catalog: Catalog,
  network: KnownNetwork.Name,
  chainId: number,
  latest: BlockRef,
  decided: Promise<SummaryDecisions>,
): Promise<ChainTokens> {
  const positions = positionsOf(catalog, network);
  const [ view, decisions ] = await Promise.all([
    collateralView(deps, { chainId, network, positions, versionId: catalog.versionId }, latest),
    decided,
  ]);
  const list = tokenList({
    registryVersion: { id: catalog.versionId, checksum: catalog.checksum },
    chainId,
    catalog,
    network,
    positions,
    view,
    strategic:  decisions.strategic?.get(chainId) ?? new Set(),
    deprecated: decisions.deprecated?.decisions ?? deprecatedDecisionsOf([]),
    hidden:     decisions.hidden?.decisions ?? hiddenDecisionsOf([]),
    now:        deps.now(),
  });
  return { chainId, tokens: new Map(list.tokens.map(token => [ token.address, token ])), decisions };
}

/*
 * One collateral's token under the summary's names, after what was read of
 * it: its name and decimals; `is_deprecated` and `is_hidden`, the decisions of
 * this market's Comet, as /registry/v1/active marks its collateral; and the
 * rest as the list says it of the whole chain, but for whether discovery
 * shows the token (visibilityWith). A field whose decision could not be read
 * is left out, and so is a value that is not known: never null, as the
 * summary leaves out whatever it cannot give.
 *
 * Whether discovery shows the token is said as soon as the decisions read
 * decide it, since the rule asks this Comet's hiding first and its
 * deprecating next: a token this Comet hides, or does not hide but has
 * deprecated, is said not to be shown here even when the decisions after it
 * could not be read, as a client that is told nothing shows it. The rest of
 * the rule takes every kind.
 */
function collateralFields(token: TokenVisibilityV1, { chainId, decisions }: ChainTokens, comet: Address) {
  const { deprecated, hidden, strategic } = decisions;
  const isHidden     = hidden === null ? null : hidden.decisions.has(chainId, comet, token.address);
  const isDeprecated = deprecated === null ? null : deprecated.decisions.has(chainId, comet, token.address);
  const decided      = isHidden === true
    || (isHidden === false && (isDeprecated === true || (isDeprecated === false && strategic !== null)));
  const visibility   = decided ? visibilityWith(token, { isHidden: isHidden === true, isDeprecated: isDeprecated === true }) : null;
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
    ...(strategic === null ? {} : { is_strategic: token.isStrategic }),
    network_roles: token.roles,
    ...(token.collateralValueUsd === null ? {} : { total_network_collateral_value_usd: token.collateralValueUsd }),
    total_network_collateral_value_status: token.collateralValueStatus,
    ...(token.valueAt         === null ? {} : { network_value_at: token.valueAt }),
    ...(token.valueBlock      === null ? {} : { network_value_block: token.valueBlock }),
    ...(token.staleAgeSeconds === null ? {} : { network_value_stale_age_seconds: token.staleAgeSeconds }),
    network_value_exceptions: token.exceptions.map(exception => ({
      kind:               exception.kind,
      price_feed_address: checksumAddress(exception.priceFeedAddress),
      provenance:         exception.provenance,
      // null where the exception does not expire: that is known, not left out
      expires_at:         exception.expiresAt,
    })),
    ...(visibility === null ? {} : {
      is_visible:        visibility.isVisible,
      visibility_reason: visibility.visibilityReason,
    }),
  };
}

// a collateral as the summary read it: its token's address, checksummed, its symbol, and its status
type SummaryCollateral = { address: string, symbol: string, status: string, message?: string };

/*
 * A market of the summary with each collateral's token fields. A market the
 * chain has not reached has no collaterals (market.ts, unreachedMarket), and
 * is answered as it was.
 */
function withTokenFields<Entry extends { collaterals?: SummaryCollateral[] }>(entry: Entry, contract: RegistryComet, chain: ChainTokens): Entry {
  if (entry.collaterals === undefined) {
    return entry;
  }
  const comet = normalizeAddress(contract.address);
  return {
    ...entry,
    collaterals: entry.collaterals.map(collateral => {
      const token = chain.tokens.get(normalizeAddress(collateral.address));
      return token === undefined ? collateral : { ...collateral, ...collateralFields(token, chain, comet) };
    }),
  };
}

export type { ChainTokens, StrategicTokens, SummaryDecisions, SummaryTokens };
export { SUMMARY_DEADLINE_MS, chainTokens, summaryDecisions, withTokenFields };
