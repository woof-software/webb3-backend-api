import { checksumAddress } from '../../lib/model/comet-registry.js';
import type { TokenVisibilityV1 } from '../../lib/model/comet-registry.js';

// what a collateral of /summary answers, in the order it writes it, where every decision was read and every value is known
const COLLATERAL_KEYS = [
  'address', 'symbol', 'status',
  'name', 'decimals', 'is_deprecated', 'is_network_deprecated', 'deprecated_in', 'is_strategic', 'network_roles',
  'total_network_collateral_value_usd', 'total_network_collateral_value_status',
  'network_value_at', 'network_value_block', 'network_value_stale_age_seconds', 'network_value_exceptions',
  'is_visible', 'visibility_reason',
] as const;

/*
 * What a collateral of /summary says of its token as the token list says it:
 * every field of the list's token, under the summary's names, each address
 * checksummed, and a value that is not known left out. `is_deprecated` is the
 * market's own, and the list has no such field.
 */
function onSummary(token: TokenVisibilityV1) {
  return {
    name:                  token.name,
    decimals:              token.decimals,
    is_network_deprecated: token.isDeprecated,
    deprecated_in:         token.deprecatedIn.map(address => checksumAddress(address)),
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
    is_visible:        token.isVisible,
    visibility_reason: token.visibilityReason,
  };
}

export { COLLATERAL_KEYS, onSummary };
