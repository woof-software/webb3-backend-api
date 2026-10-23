import { checksumAddress } from '../../lib/model/comet-registry.js';
import type { TokenVisibilityV1, VisibilityReasonV1 } from '../../lib/model/comet-registry.js';

// what a collateral of /summary answers, in the order it writes it, where every decision was read and every value is known
const COLLATERAL_KEYS = [
  'address', 'symbol', 'status',
  'name', 'decimals', 'is_deprecated', 'is_network_deprecated', 'deprecated_in', 'is_hidden', 'hidden_in', 'is_strategic', 'network_roles',
  'total_network_collateral_value_usd', 'total_network_collateral_value_status',
  'network_value_at', 'network_value_block', 'network_value_stale_age_seconds', 'network_value_exceptions',
  'is_visible', 'visibility_reason',
] as const;

// the token list's threshold, in whole USD
const THRESHOLD_USD = 250_000n;

/*
 * Whether discovery shows a token in one market, and why, as a collateral of
 * /summary says it, stated apart from the rule's code, which asks the rule
 * every way a decision that could not be read might have gone: from whether
 * the market's Comet hides the token and whether it has it deprecated,
 * whether the token is strategic on its chain, each null where that kind of
 * decision could not be read, and the value the list writes of the token,
 * null where it is not known. The token is not shown where the Comet hides it
 * or has it deprecated, or where it is not strategic and is worth less than
 * the threshold, whatever the other decisions are; it is shown where the
 * Comet neither hides nor deprecates it and it is strategic, worth at least
 * the threshold, or of a value that cannot be read. Either is said wherever
 * it holds. Why is said only where every kind of decision the rule asks, up to
 * the one that decides, was read: the hiding, then the deprecating, then the
 * strategic mark.
 */
function visibilityOnSummary(
  { isHidden, isDeprecated, isStrategic }: { isHidden: boolean | null, isDeprecated: boolean | null, isStrategic: boolean | null },
  valueUsd: string | null,
): { is_visible?: boolean, visibility_reason?: VisibilityReasonV1 } {
  // the list writes every digit and no exponent, so the whole part tells a value short of a whole threshold
  const below    = valueUsd !== null && BigInt(valueUsd.split('.')[0]) < THRESHOLD_USD;
  const notShown = isHidden === true || isDeprecated === true || (isStrategic === false && below);
  const shown    = isHidden === false && isDeprecated === false && (isStrategic === true || !below);
  const reason: VisibilityReasonV1 | null = (
      isHidden === true                               ? 'hidden'
    : isHidden === null                               ? null
    : isDeprecated === true                           ? 'deprecated'
    : isDeprecated === null || isStrategic === null   ? null
    : isStrategic                                     ? 'strategic'
    : valueUsd === null                               ? 'data_unavailable'
    : below                                           ? 'below_threshold'
    : 'collateral_threshold'
  );
  return {
    ...(shown || notShown ? { is_visible: shown } : {}),
    ...(reason === null ? {} : { visibility_reason: reason }),
  };
}

/*
 * What a collateral of /summary says of its token as the token list says it:
 * every field of the list's token, under the summary's names, each address
 * checksummed, and a value that is not known left out. `is_deprecated` and
 * `is_hidden` are the market's own, and the list has no such fields. So is
 * whether discovery shows the token: by the market's Comet's decisions
 * (`here`), and by the token's strategic mark and value as the list has them
 * (visibilityOnSummary), every decision read.
 */
function onSummary(token: TokenVisibilityV1, here: { isHidden: boolean, isDeprecated: boolean }) {
  return {
    name:                  token.name,
    decimals:              token.decimals,
    is_network_deprecated: token.isDeprecated,
    deprecated_in:         token.deprecatedIn.map(address => checksumAddress(address)),
    hidden_in:             token.hiddenIn.map(address => checksumAddress(address)),
    is_strategic:          token.isStrategic,
    network_roles:         token.roles,
    ...(token.collateralValueUsd === null ? {} : { total_network_collateral_value_usd: token.collateralValueUsd }),
    total_network_collateral_value_status: token.collateralValueStatus,
    ...(token.valueAt         === null ? {} : { network_value_at: token.valueAt }),
    ...(token.valueBlock      === null ? {} : { network_value_block: token.valueBlock }),
    ...(token.staleAgeSeconds === null ? {} : { network_value_stale_age_seconds: token.staleAgeSeconds }),
    network_value_exceptions: token.exceptions.map(({ kind, priceFeedAddress, provenance, expiresAt }) => ({
      kind,
      price_feed_address: checksumAddress(priceFeedAddress),
      provenance,
      expires_at:         expiresAt,
    })),
    ...visibilityOnSummary({ ...here, isStrategic: token.isStrategic }, token.collateralValueUsd),
  };
}

export { COLLATERAL_KEYS, onSummary, visibilityOnSummary };
