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
  VisibilityReasonV1,
} from '../../lib/model/comet-registry.js';

import type { Catalog } from './catalog.js';
import { CollateralView, Position, RULE_VERSION, TokenValue, tokenValue } from './token-collateral.js';

/*
 * Which tokens discovery shows: a token an administrator marked strategic, or
 * one whose collateral across the chain's enabled markets is worth at least
 * USD 250,000. The comparison is exact, in fixed point, never in a float.
 *
 * A token whose value cannot be read is shown (decision D4 of the TOK-0
 * audit): hiding it would hide an asset someone may hold, and showing it is
 * the safe answer to not knowing. A strategic token is shown whatever its
 * value says.
 */
const THRESHOLD_USD  = BigFixnum.from({ value: 250000 });
const THRESHOLD_TEXT = '250000';

/*
 * Every token the active version serves on a chain, with every role it plays
 * in the markets that serve it. A deprecated market is still served, so its
 * tokens are listed; a disabled one is never materialized. A reward token is
 * the market's reward asset, never the placeholder a market without rewards
 * carries on its contract object.
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

function visibilityOf(isStrategic: boolean, value: TokenValue): { isVisible: boolean, visibilityReason: VisibilityReasonV1 } {
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
  now:             Date,
}): TokenListV1 {
  const tokens = tokensOf(input.catalog, input.network).map(({ token, roles }): TokenVisibilityV1 => {
    const value       = tokenValue(token.address, input.view, input.positions, THRESHOLD_USD, input.now);
    const isStrategic = input.strategic.has(token.address);
    return {
      address:               token.address,
      symbol:                token.symbol,
      name:                  token.name,
      decimals:              token.decimals,
      roles,
      isStrategic,
      collateralValueUsd:    value.valueUsd === null ? null : decimalString(value.valueUsd),
      collateralValueStatus: value.status,
      valueAt:               value.block === null ? null : new Date(value.block.timestamp * 1000).toISOString(),
      valueBlock:            value.block,
      staleAgeSeconds:       value.staleAgeSeconds,
      exceptions:            value.exceptions.map(appliedOf),
      ...visibilityOf(isStrategic, value),
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

export { THRESHOLD_USD, decimalString, tokenList, tokensOf, visibilityOf };
