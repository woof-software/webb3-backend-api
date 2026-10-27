import type { BlockRefV1, VisibilityReasonV1 } from '../../lib/model/comet-registry.js';

// what a collateral of /summary answers, in the order it writes it, where every decision was read and every value is known
const COLLATERAL_KEYS = [
  'address', 'symbol', 'status',
  'name', 'decimals', 'is_deprecated', 'is_network_deprecated', 'deprecated_in', 'is_hidden', 'hidden_in', 'is_strategic', 'network_roles',
  'collateral_value_usd', 'collateral_value_status',
  'collateral_value_at', 'collateral_value_block', 'collateral_value_stale_age_seconds', 'collateral_value_exceptions',
  'is_visible', 'visibility_reason',
] as const;

// the threshold of discovery, in whole USD
const THRESHOLD_USD = 250_000n;

/*
 * Whether discovery shows a token in one market, and why, as a collateral of
 * /summary says it, stated apart from the rule's code, which asks the rule
 * every way a decision that could not be read might have gone: from whether
 * the market's Comet hides the token and whether it has it deprecated,
 * whether the token is strategic on its chain, each null where that kind of
 * decision could not be read, and the collateral's value in that market,
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
  // the summary writes every digit and no exponent, so the whole part tells a value short of a whole threshold
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

// a price exception as a collateral of /summary names the one that priced it
type ExceptionOnSummary = { kind: string, price_feed_address: string, provenance: string, expires_at: string | null };

/*
 * The value fields of a collateral of /summary, stated apart from the code:
 * its value in its market, `usd`, every digit, or null where it is not known;
 * the block the market was read at, null where the node did not give its
 * header; and the exceptions that priced it. A value that is known says when
 * it was read, where that is known too, and is never stale; one that is not is
 * `unavailable`, and says neither.
 */
function valueOnSummary({ usd, block, exceptions = [] }: { usd: string | null, block: BlockRefV1 | null, exceptions?: ExceptionOnSummary[] }) {
  return {
    ...(usd === null ? {} : { collateral_value_usd: usd }),
    collateral_value_status: usd === null ? 'unavailable' : exceptions.length === 0 ? 'fresh' : 'exception',
    ...(usd === null || block === null ? {} : {
      collateral_value_at:                new Date(block.timestamp * 1000).toISOString(),
      collateral_value_block:             block,
      collateral_value_stale_age_seconds: 0,
    }),
    collateral_value_exceptions: exceptions,
  };
}

// a decimal string as an exact number of 10^-40ths, so that values of any scale add up exactly
function scaled(value: string): bigint {
  const [ whole, fraction = '' ] = value.split('.');
  if (fraction.length > 40) {
    throw new Error(`${value} has more than 40 decimals`);
  }
  return BigInt(whole!) * 10n ** 40n + BigInt(fraction.padEnd(40, '0'));
}

export type { ExceptionOnSummary };
export { COLLATERAL_KEYS, scaled, valueOnSummary, visibilityOnSummary };
