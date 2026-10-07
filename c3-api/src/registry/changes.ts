import type { MarketV1, NetworkV1 } from '../../lib/model/comet-registry.js';
import { marketKey } from '../../lib/model/comet-registry.js';

/*
 * What a version changes against the one that is on.
 *
 * The shadow comparison measures a version against the static constants,
 * which is what moving an environment onto the registry needs and what a
 * routine update does not: a market the constants never described is only a
 * name there, and a change to a known market is measured against constants
 * that are out of date anyway. Before switching a newer version on, the
 * question is what switching changes — which markets it adds or drops, and
 * which of their facts and decisions differ from what is served now. A market
 * the version adds is reported whole, with everything its import read from
 * the source and the chain, because describing it starts from those facts.
 *
 * Values are compared field by field on flattened paths, so a change reads as
 * `baseAsset.priceFeed.address` rather than as two market documents to tell
 * apart. Lists are flattened by position, with their length alongside, so a
 * collateral the source adds shows as a longer list and one more entry.
 */
type FieldChange = {
  scope:  string,
  field:  string,
  before: unknown,
  after:  unknown,
};

type VersionChanges = {
  networks: {
    added:   number[],
    removed: number[],
    changed: FieldChange[],
  },
  markets: {
    added:   Array<{ scope: string, reviewed: boolean, market: Omit<MarketV1, 'id'> }>,
    removed: string[],
    changed: FieldChange[],
  },
};

function flatten(value: unknown, path: string, into: Map<string, unknown>): Map<string, unknown> {
  if (Array.isArray(value)) {
    into.set(`${path}.length`, value.length);
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, into));
    return into;
  }
  if (typeof(value) === 'object' && value !== null) {
    for (const [ key, item ] of Object.entries(value)) {
      flatten(item, path === '' ? key : `${path}.${key}`, into);
    }
    return into;
  }
  into.set(path, value === undefined ? null : value);
  return into;
}

function fieldChanges(scope: string, before: unknown, after: unknown): FieldChange[] {
  const left  = flatten(before, '', new Map());
  const right = flatten(after, '', new Map());
  const fields = [ ...new Set([ ...left.keys(), ...right.keys() ]) ].sort();
  return fields
    .filter(field => JSON.stringify(left.get(field) ?? null) !== JSON.stringify(right.get(field) ?? null))
    .map(field => ({ scope, field, before: left.get(field) ?? null, after: right.get(field) ?? null }));
}

// a market's id is a row identity each version assigns anew, not something it says
function withoutId({ id: _id, ...market }: MarketV1): Omit<MarketV1, 'id'> {
  return market;
}

function withoutMarkets({ markets: _markets, ...network }: NetworkV1): Omit<NetworkV1, 'markets'> {
  return network;
}

// a market with the chain it is on, by its key
type Scoped = { chainId: number, market: MarketV1 };

function marketsByScope(networks: NetworkV1[]): Map<string, Scoped> {
  return new Map(networks.flatMap(network => network.markets.map(market => (
    [ marketKey(network.chainId, market.deploymentKey), { chainId: network.chainId, market } ] as const
  ))));
}

// the keys of some markets, chain ids in numeric order and then deployment keys
function inScopeOrder(markets: Map<string, Scoped>, scopes: string[]): string[] {
  const order = (left: Scoped, right: Scoped) => left.chainId - right.chainId || (
    left.market.deploymentKey < right.market.deploymentKey ? -1 : left.market.deploymentKey > right.market.deploymentKey ? 1 : 0
  );
  return [ ...scopes ].sort((left, right) => order(markets.get(left)!, markets.get(right)!));
}

/*
 * `before` is the version that is on, or null when none is: then everything
 * the version holds is new. `unreviewed` names the markets of `after` nobody
 * has reviewed, which is what an operator describes next.
 */
function compareVersions(
  before: NetworkV1[] | null,
  after: NetworkV1[],
  unreviewed: ReadonlySet<string>,
): VersionChanges {
  const beforeNetworks = new Map((before ?? []).map(network => [ network.chainId, network ]));
  const afterNetworks  = new Map(after.map(network => [ network.chainId, network ]));

  const networkChanges = [ ...afterNetworks ]
    .filter(([ chainId ]) => beforeNetworks.has(chainId))
    .flatMap(([ chainId, network ]) => fieldChanges(
      String(chainId), withoutMarkets(beforeNetworks.get(chainId)!), withoutMarkets(network),
    ));

  const beforeMarkets = marketsByScope(before ?? []);
  const afterMarkets  = marketsByScope(after);
  const scopes        = inScopeOrder(afterMarkets, [ ...afterMarkets.keys() ]);

  return {
    networks: {
      added:   [ ...afterNetworks.keys() ].filter(chainId => !beforeNetworks.has(chainId)).sort((a, b) => a - b),
      removed: [ ...beforeNetworks.keys() ].filter(chainId => !afterNetworks.has(chainId)).sort((a, b) => a - b),
      changed: networkChanges,
    },
    markets: {
      added: scopes
        .filter(scope => !beforeMarkets.has(scope))
        .map(scope => ({ scope, reviewed: !unreviewed.has(scope), market: withoutId(afterMarkets.get(scope)!.market) })),
      removed: inScopeOrder(beforeMarkets, [ ...beforeMarkets.keys() ].filter(scope => !afterMarkets.has(scope))),
      changed: scopes
        .filter(scope => beforeMarkets.has(scope))
        .flatMap(scope => fieldChanges(
          scope,
          withoutId(beforeMarkets.get(scope)!.market),
          withoutId(afterMarkets.get(scope)!.market),
        )),
    },
  };
}

export type { FieldChange, VersionChanges };
export { compareVersions };
