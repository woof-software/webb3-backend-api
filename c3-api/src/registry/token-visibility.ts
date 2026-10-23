import { BigFixnum } from '../../lib/bigfixnum.js';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import {
  ASSET_ROLES,
  Address,
  AppliedPriceExceptionV1,
  AssetRole,
  PriceExceptionV1,
  TokenListV1,
  TokenV1,
  TokenVisibilityV1,
  VersionRefV1,
  VisibilityV1,
} from '../../lib/model/comet-registry.js';

import type { Catalog, CatalogMarket } from './catalog.js';
import type { CollateralView, Position } from './token-collateral.js';
import { TokenValue, tokenValue } from './token-value.js';

/*
 * Which tokens discovery shows: a token an administrator marked strategic, or
 * one whose collateral across the chain's enabled markets is worth at least
 * USD 250,000. The comparison is exact, in fixed point, never in a float.
 *
 * A token whose value cannot be read is shown (decision D4 of the TOK-0
 * audit): leaving it out would keep from discovery an asset someone may hold,
 * and showing it is the safe answer to not knowing. A strategic token is shown
 * whatever its value says.
 *
 * Before any of that is asked, the decisions about a collateral of a Comet
 * may keep a token out of discovery, whatever else holds, strategic or worth
 * the threshold (Exclusion). An enabled market that takes the token offers it
 * unless it has it deprecated, and leaves it to discovery where it offers it
 * and does not hide it (migrations/0008_hidden_collaterals.sql). A token that
 * an enabled market takes, and that none of them leaves to discovery, is
 * kept out across the chain: as `hidden` where one of them hides it, since
 * hiding a collateral is a decision about discovery alone and so is asked
 * first; otherwise as `deprecated`, every one of them having it deprecated,
 * as no market offers it as collateral any longer. A market whose status is
 * `deprecated` offers the token no longer: its decisions are named, and take
 * no part in what the chain decides. In one market, its Comet's own decisions
 * keep the token out the same way, its hiding first, as /summary says of each
 * collateral (summary-tokens.ts).
 *
 * The markets still take a token kept out as collateral, and the app keeps
 * showing it to a user who holds some, so that it can be withdrawn.
 */
const THRESHOLD_USD  = BigFixnum.from({ value: 250000 });
const THRESHOLD_TEXT = '250000';

/*
 * The rule a list decides by, which the list names: 2 since the deprecated
 * decisions may keep a token out of discovery, 3 since the hidden ones may as
 * well. It reads the values the records hold (token-collateral.ts), and no
 * record depends on it.
 */
const RULE_VERSION = 3;

// what keeps a token out of discovery, if anything; not null, which /summary gives a decision it could not read
type Exclusion = 'hidden' | 'deprecated' | 'none';

// a kind of decision as the rule asks it (collateral-decisions.ts): whether it names a collateral, its addresses lowercase
type Decisions = { has: (collateral: { chainId: number, cometAddress: Address, tokenAddress: Address }) => boolean };

/*
 * Every token the active version serves on a chain, with every role it plays
 * in the markets that serve it. A deprecated market is still served, so its
 * tokens are listed; a disabled one is never materialized. A reward token is
 * the market's reward asset.
 */
function tokensOf(catalog: Catalog, network: KnownNetwork.Name): Array<{ token: TokenV1, roles: AssetRole[] }> {
  const found = new Map<Address, { token: TokenV1, roles: Set<AssetRole> }>();
  const add = (token: TokenV1, role: AssetRole) => {
    const entry = found.get(token.address) ?? { token, roles: new Set<AssetRole>() };
    entry.roles.add(role);
    found.set(token.address, entry);
  };
  for (const { market } of catalog.marketsOn(network)) {
    add(market.baseAsset.token, 'base');
    if (market.rewardAsset !== null) {
      add(market.rewardAsset.token, 'reward');
    }
    market.collateralAssets.forEach(asset => add(asset.token, 'collateral'));
  }
  return [ ...found.values() ].map(({ token, roles }) => ({ token, roles: ASSET_ROLES.filter(role => roles.has(role)) }));
}

function exclusionHere({ isHidden, isDeprecated }: { isHidden: boolean, isDeprecated: boolean }): Exclusion {
  return isHidden ? 'hidden' : isDeprecated ? 'deprecated' : 'none';
}

/*
 * What the decisions of a chain's served markets make of a token they take as
 * collateral: the Comets that have it deprecated, and those that hide it,
 * sorted; whether it is deprecated in every enabled market that takes it, of
 * which there is at least one, which the list says even where one of them
 * hides it as well; and what keeps it out of discovery across the chain.
 */
function exclusionOnChain(
  chainId: number,
  token: Address,
  markets: CatalogMarket[],
  { deprecated, hidden }: { deprecated: Decisions, hidden: Decisions },
): { exclusion: Exclusion, isDeprecated: boolean, deprecatedIn: Address[], hiddenIn: Address[] } {
  const taking = markets
    .filter(({ market }) => market.collateralAssets.some(asset => asset.token.address === token))
    .map(({ market }) => {
      const collateral = { chainId, cometAddress: market.contracts.comet, tokenAddress: token };
      return { market, isHidden: hidden.has(collateral), isDeprecated: deprecated.has(collateral) };
    });
  const enabled  = taking.filter(({ market }) => market.status === 'enabled');
  const byMarket = enabled.map(exclusionHere);
  const keptOut  = byMarket.length > 0 && !byMarket.includes('none');
  return {
    exclusion:    !keptOut ? 'none' : byMarket.includes('hidden') ? 'hidden' : 'deprecated',
    isDeprecated: enabled.length > 0 && enabled.every(entry => entry.isDeprecated),
    deprecatedIn: taking.filter(entry => entry.isDeprecated).map(({ market }) => market.contracts.comet).sort(),
    hiddenIn:     taking.filter(entry => entry.isHidden).map(({ market }) => market.contracts.comet).sort(),
  };
}

// of a value, the rule reads only whether it is known and what it is worth
function visibilityOf(exclusion: Exclusion, isStrategic: boolean, value: Pick<TokenValue, 'valueUsd'>): VisibilityV1 {
  if (exclusion !== 'none') {
    return { isVisible: false, visibilityReason: exclusion };
  }
  if (isStrategic) {
    return { isVisible: true, visibilityReason: 'strategic' };
  }
  if (value.valueUsd === null) {
    return { isVisible: true, visibilityReason: 'data_unavailable' };
  }
  return value.valueUsd.gte(THRESHOLD_USD)
    ? { isVisible: true,  visibilityReason: 'collateral_threshold' }
    : { isVisible: false, visibilityReason: 'below_threshold' };
}

/*
 * What discovery says of a token in one market, by its Comet's decisions about
 * the collateral and the chain's strategic marks, where a kind of them may not
 * have been read (null): what the rule answers whichever way an unread
 * decision went. Where every answer gives the same reason, that answer is
 * said, the reason saying whether the token is shown; where they agree only on
 * whether it is shown, that alone is said, a key being left out only where an
 * unread decision could change it; elsewhere nothing is.
 */
function visibilityHere(
  { isHidden, isDeprecated, isStrategic }: { isHidden: boolean | null, isDeprecated: boolean | null, isStrategic: boolean | null },
  value: Pick<TokenValue, 'valueUsd'>,
): Partial<VisibilityV1> {
  const either     = (decision: boolean | null) => decision === null ? [ true, false ] : [ decision ];
  const exclusions = either(isHidden).flatMap(hiding => either(isDeprecated).map(deprecating => (
    exclusionHere({ isHidden: hiding, isDeprecated: deprecating })
  )));
  const answers    = exclusions.flatMap(exclusion => either(isStrategic).map(strategic => visibilityOf(exclusion, strategic, value)));
  const [ first ]  = answers;
  const agreed     = (part: keyof VisibilityV1) => answers.every(answer => answer[part] === first[part]);
  return agreed('visibilityReason') ? first : agreed('isVisible') ? { isVisible: first.isVisible } : {};
}

/*
 * A value as the API writes it: every digit, no trailing zeros, no exponent.
 * BigFixnum's own string keeps a trailing ".0" and refuses large scales, so
 * the digits are placed here.
 */
function decimalString(value: BigFixnum): string {
  const negative = value.value.isNegative();
  const digits   = value.value.abs().toString();
  if (value.decimals === 0) {
    return `${negative ? '-' : ''}${digits}`;
  }
  const padded   = digits.padStart(value.decimals + 1, '0');
  const whole    = padded.slice(0, padded.length - value.decimals);
  const fraction = padded.slice(padded.length - value.decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${fraction === '' ? whole : `${whole}.${fraction}`}`;
}

function appliedOf(exception: PriceExceptionV1): AppliedPriceExceptionV1 {
  return {
    kind:             exception.kind,
    priceFeedAddress: exception.priceFeedAddress,
    provenance:       exception.provenance,
    // the catalog has already dropped an expiry it cannot parse, so this one parses
    expiresAt:        exception.expiresAt === null ? null : new Date(Date.parse(exception.expiresAt)).toISOString(),
  };
}

// by symbol, ignoring case, then by address, so the order never depends on the order of markets
function bySymbol(left: TokenVisibilityV1, right: TokenVisibilityV1): number {
  const [ a, b ] = [ left.symbol.toLowerCase(), right.symbol.toLowerCase() ];
  return a < b ? -1 : a > b ? 1 : left.address < right.address ? -1 : left.address > right.address ? 1 : 0;
}

type ListInput = {
  chainId:    number,
  catalog:    Catalog,
  network:    KnownNetwork.Name,
  positions:  Position[],
  view:       CollateralView,
  strategic:  ReadonlySet<Address>,
  deprecated: Decisions,
  hidden:     Decisions,
  now:        Date,
};

// a token as the list writes it, and the value the rule read of it, of which the list writes the digits
type ListedToken = { token: TokenVisibilityV1, valueUsd: BigFixnum | null };

/*
 * Every token of a chain as the list writes it, in no particular order, with
 * the value it was decided by, which /summary decides each collateral by in
 * its own market (summary-tokens.ts).
 */
function listedTokens(input: ListInput): ListedToken[] {
  const markets = input.catalog.marketsOn(input.network);
  return tokensOf(input.catalog, input.network).map(({ token, roles }): ListedToken => {
    const value       = tokenValue(token.address, input.view, input.positions, THRESHOLD_USD, input.now);
    const isStrategic = input.strategic.has(token.address);
    // the list names where the token is hidden, and says what keeps it out of discovery by its reason alone
    const chain       = exclusionOnChain(input.chainId, token.address, markets, input);
    return {
      token: {
        address:               token.address,
        symbol:                token.symbol,
        name:                  token.name,
        decimals:              token.decimals,
        roles,
        isStrategic,
        isDeprecated:          chain.isDeprecated,
        deprecatedIn:          chain.deprecatedIn,
        hiddenIn:              chain.hiddenIn,
        collateralValueUsd:    value.valueUsd === null ? null : decimalString(value.valueUsd),
        collateralValueStatus: value.status,
        valueAt:               value.block === null ? null : new Date(value.block.timestamp * 1000).toISOString(),
        valueBlock:            value.block,
        staleAgeSeconds:       value.staleAgeSeconds,
        exceptions:            value.exceptions.map(appliedOf),
        ...visibilityOf(chain.exclusion, isStrategic, value),
      },
      valueUsd: value.valueUsd,
    };
  });
}

function tokenList(input: ListInput & { registryVersion: VersionRefV1 }): TokenListV1 {
  const tokens = listedTokens(input).map(({ token }) => token);
  return {
    registryVersion: input.registryVersion,
    chainId:         input.chainId,
    thresholdUsd:    THRESHOLD_TEXT,
    ruleVersion:     RULE_VERSION,
    computedAt:      input.now.toISOString(),
    block:           input.view.block,
    tokens:          tokens.sort(bySymbol),
  };
}

export type { Exclusion, ListedToken };
export { RULE_VERSION, decimalString, listedTokens, tokenList, tokensOf, visibilityHere, visibilityOf };
