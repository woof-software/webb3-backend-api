import type { MarketV1, NetworkV1 } from '../../lib/model/comet-registry.js';

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

function marketsByScope(networks: NetworkV1[]): Map<string, MarketV1> {
  return new Map(networks.flatMap(network => network.markets.map(market => (
    [ `${network.chainId}/${market.deploymentKey}`, market ] as const
  ))));
}

// chain ids in numeric order, then deployment keys
function byScope(left: string, right: string): number {
  const [ leftChain, leftKey = '' ]   = left.split('/');
  const [ rightChain, rightKey = '' ] = right.split('/');
  return Number(leftChain) - Number(rightChain) || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0);
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
  const scopes        = [ ...afterMarkets.keys() ].sort(byScope);

  return {
    networks: {
      added:   [ ...afterNetworks.keys() ].filter(chainId => !beforeNetworks.has(chainId)).sort((a, b) => a - b),
      removed: [ ...beforeNetworks.keys() ].filter(chainId => !afterNetworks.has(chainId)).sort((a, b) => a - b),
      changed: networkChanges,
    },
    markets: {
      added: scopes
        .filter(scope => !beforeMarkets.has(scope))
        .map(scope => ({ scope, reviewed: !unreviewed.has(scope), market: withoutId(afterMarkets.get(scope)!) })),
      removed: [ ...beforeMarkets.keys() ].filter(scope => !afterMarkets.has(scope)).sort(byScope),
      changed: scopes
        .filter(scope => beforeMarkets.has(scope))
        .flatMap(scope => fieldChanges(scope, withoutId(beforeMarkets.get(scope)!), withoutId(afterMarkets.get(scope)!))),
    },
  };
}

export type { FieldChange, VersionChanges };
export { compareVersions };
