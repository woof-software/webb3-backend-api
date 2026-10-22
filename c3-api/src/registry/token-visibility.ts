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
} from '../../lib/model/comet-registry.js';

import type { Catalog, CatalogMarket } from './catalog.js';
import type { DeprecatedDecisions, HiddenDecisions } from './deprecated-collaterals.js';
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
 * A token deprecated in every enabled market that takes it is not shown,
 * whatever else holds, strategic or worth the threshold: no market offers it
 * as collateral any longer, so discovery does not either. Its holders lose
 * nothing by it, since the app keeps showing a deprecated collateral to a user
 * who still holds some, so that it can be withdrawn.
 *
 * Nor is a token an administrator hid (migrations/0008_hidden_collaterals.sql)
 * in an enabled market that takes it, where every other one hides it or has
 * it deprecated: no enabled market offers it as a current collateral and
 * leaves it to discovery. That is asked first, before whether it is
 * deprecated or strategic, since hiding a collateral is a decision about
 * discovery alone. The markets still take the token as collateral, and the
 * app keeps showing it to a user who holds some, as it does a deprecated one.
 */
const THRESHOLD_USD  = BigFixnum.from({ value: 250000 });
const THRESHOLD_TEXT = '250000';

/*
 * The rule a list decides by, which the list names: 2 since a token
 * deprecated in every enabled market that takes it is not shown, 3 since one
 * that such a market hides, and every other hides or has deprecated, is not
 * either, whatever else holds. It reads the values the records hold
 * (token-collateral.ts), and no record depends on it.
 */
const RULE_VERSION = 3;

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

/*
 * Where a token is a deprecated collateral: the Comets of the chain's served
 * markets that take it as collateral and whose decision marks it deprecated,
 * sorted, and whether it is deprecated in every enabled market that takes it,
 * of which there is at least one. The decision of a market whose status is
 * `deprecated` is named, but takes no part in `isDeprecated`, which says that
 * no enabled market offers the token as a current collateral any longer: a
 * token still current in one of them is offered there, and discovery decides
 * it as any other.
 */
function deprecatedOf(
  chainId: number,
  token: Address,
  markets: CatalogMarket[],
  deprecated: DeprecatedDecisions,
): { isDeprecated: boolean, deprecatedIn: Address[] } {
  const taking  = markets.filter(({ market }) => market.collateralAssets.some(asset => asset.token.address === token));
  const marked  = taking.filter(({ market }) => deprecated.has(chainId, market.contracts.comet, token));
  const enabled = taking.filter(({ market }) => market.status === 'enabled');
  return {
    isDeprecated: enabled.length > 0 && enabled.every(entry => marked.includes(entry)),
    deprecatedIn: marked.map(({ market }) => market.contracts.comet).sort(),
  };
}

/*
 * Where an administrator hid a token as a collateral: the Comets of the
 * chain's served markets that take it as collateral and hide it, sorted, as
 * deprecatedOf names where it is deprecated. And whether it is hidden across
 * the chain: an enabled market that takes it hides it, and every other one
 * hides it or has it deprecated, so that none of them offers it as a current
 * collateral and leaves it to discovery. A token deprecated in every one of
 * them and hidden in none is deprecated instead, and one that an enabled
 * market takes with neither decision is offered there, and decided by the
 * rest of the rule. A market whose status is `deprecated` offers the token no
 * longer: its decisions are named, and take no part.
 */
function hiddenOf(
  chainId: number,
  token: Address,
  markets: CatalogMarket[],
  { deprecated, hidden }: { deprecated: DeprecatedDecisions, hidden: HiddenDecisions },
): { isHidden: boolean, hiddenIn: Address[] } {
  const taking  = markets.filter(({ market }) => market.collateralAssets.some(asset => asset.token.address === token));
  const hiding  = taking.filter(({ market }) => hidden.has(chainId, market.contracts.comet, token));
  const enabled = taking.filter(({ market }) => market.status === 'enabled');
  return {
    isHidden: enabled.some(entry => hiding.includes(entry))
      && enabled.every(entry => hiding.includes(entry) || deprecated.has(chainId, entry.market.contracts.comet, token)),
    hiddenIn: hiding.map(({ market }) => market.contracts.comet).sort(),
  };
}

type Visibility = Pick<TokenVisibilityV1, 'isVisible' | 'visibilityReason'>;

// of a value, the rule reads only whether it is known and what it is worth
function visibilityOf(
  { isHidden, isDeprecated, isStrategic }: { isHidden: boolean, isDeprecated: boolean, isStrategic: boolean },
  value: Pick<TokenValue, 'valueUsd'>,
): Visibility {
  if (isHidden) {
    return { isVisible: false, visibilityReason: 'hidden' };
  }
  if (isDeprecated) {
    return { isVisible: false, visibilityReason: 'deprecated' };
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

// a value as decimalString writes it, read back: every digit is written, so it is the value itself
function fixnumOf(text: string): BigFixnum {
  const [ whole, fraction = '' ] = text.split('.');
  return BigFixnum.from({ value: `${whole}${fraction}`, decimals: fraction.length });
}

/*
 * What discovery says of a token of the list where one market's decisions are
 * what count: the rule, with whether this market hides the token and whether
 * it has it deprecated in place of what the chain decides of either (hiddenOf,
 * deprecatedOf), and every other input as the list has it, its value read back
 * from the digits the list writes. The summary asks it of each collateral with
 * the decisions of the collateral's own Comet (summary-tokens.ts).
 */
function visibilityWith(token: TokenVisibilityV1, here: { isHidden: boolean, isDeprecated: boolean }): Visibility {
  return visibilityOf(
    { isHidden: here.isHidden, isDeprecated: here.isDeprecated, isStrategic: token.isStrategic },
    { valueUsd: token.collateralValueUsd === null ? null : fixnumOf(token.collateralValueUsd) },
  );
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

function tokenList(input: {
  registryVersion: VersionRefV1,
  chainId:         number,
  catalog:         Catalog,
  network:         KnownNetwork.Name,
  positions:       Position[],
  view:            CollateralView,
  strategic:       ReadonlySet<Address>,
  deprecated:      DeprecatedDecisions,
  hidden:          HiddenDecisions,
  now:             Date,
}): TokenListV1 {
  const markets = input.catalog.marketsOn(input.network);
  const tokens  = tokensOf(input.catalog, input.network).map(({ token, roles }): TokenVisibilityV1 => {
    const value       = tokenValue(token.address, input.view, input.positions, THRESHOLD_USD, input.now);
    const isStrategic = input.strategic.has(token.address);
    const deprecated  = deprecatedOf(input.chainId, token.address, markets, input.deprecated);
    // the list names where the token is hidden, and says that it is hidden across the chain by its reason alone
    const { isHidden, hiddenIn } = hiddenOf(input.chainId, token.address, markets, { deprecated: input.deprecated, hidden: input.hidden });
    return {
      address:               token.address,
      symbol:                token.symbol,
      name:                  token.name,
      decimals:              token.decimals,
      roles,
      isStrategic,
      ...deprecated,
      hiddenIn,
      collateralValueUsd:    value.valueUsd === null ? null : decimalString(value.valueUsd),
      collateralValueStatus: value.status,
      valueAt:               value.block === null ? null : new Date(value.block.timestamp * 1000).toISOString(),
      valueBlock:            value.block,
      staleAgeSeconds:       value.staleAgeSeconds,
      exceptions:            value.exceptions.map(appliedOf),
      ...visibilityOf({ isHidden, isDeprecated: deprecated.isDeprecated, isStrategic }, value),
    };
  });
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

export { RULE_VERSION, THRESHOLD_USD, decimalString, deprecatedOf, hiddenOf, tokenList, tokensOf, visibilityOf, visibilityWith };
