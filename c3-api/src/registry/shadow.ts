import * as Eth from '../../lib/eth-constants.js';

import type * as KnownNetwork from '../../lib/well-known/networks/network.js';
import { Comet, Contract, StandaloneContract } from '../../lib/well-known/contracts/types.js';

import type { RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';

import type { CatalogMarket } from './catalog.js';
import { catalogOf } from './catalog.js';
import { SUPPORTED_NETWORKS } from './source/roots.js';

/*
 * The shadow catalog: what the static constants say against what the active
 * registry says.
 *
 * Every consumer is being moved from the constants to the registry, and the
 * two must agree before that move is trusted. This comparison is what makes a
 * disagreement visible while both sources still exist, rather than after the
 * constants are gone.
 *
 * Only the networks the registry covers are compared. The constants also
 * describe testnets, which the registry does not import, and reporting those
 * as missing would bury the differences that matter.
 */
type CometContract = Contract<StandaloneContract<Comet>>;

type Difference = {
  scope:    string,
  field:    string,
  static:   unknown,
  registry: unknown,
};

type ShadowReport = {
  versionId:       string,
  checksum:        string,
  networks:        KnownNetwork.Name[],
  staticMarkets:   number,
  registryMarkets: number,
  onlyInStatic:    string[],
  onlyInRegistry:  string[],
  /*
   * Markets the version describes and deliberately does not serve. They are
   * neither a difference nor a gap: the operator disabled them, and reporting
   * them as missing would leave the one signal this report exists for showing
   * a permanent disagreement.
   */
  disabledInRegistry: string[],
  differences:     Difference[],
};

// the networks both sources describe: everything the importer accepts
const COMPARED_NETWORKS = Object.values(SUPPORTED_NETWORKS) as KnownNetwork.Name[];

function lower(value: string | undefined | null): string | null {
  return value === undefined || value === null ? null : value.toLowerCase();
}

/*
 * `displayName` is typed as `unknown` on the static contracts, because the
 * constants allow anything nameable there. Only a string is comparable with
 * what the registry stores.
 */
function displayNameOf(contract: CometContract): string | null {
  return typeof(contract.displayName) === 'string' ? contract.displayName : null;
}

/*
 * The static Comets of one network, keyed by lowercased address. The
 * constants index each Comet under several alias keys, so the address is what
 * identifies a market across both sources.
 */
function staticComets(network: KnownNetwork.Name): Map<string, CometContract> {
  const contracts = Eth.wellKnownContractsByNetwork[network]?.['Comet'] ?? {};
  const comets    = new Map<string, CometContract>();
  for (const candidate of Object.values(contracts) as Contract[]) {
    if (Comet.is(candidate)) {
      comets.set(candidate.address.toLowerCase(), candidate as CometContract);
    }
  }
  return comets;
}

function compareMarket(entry: CatalogMarket, comet: CometContract): Difference[] {
  const scope = `${entry.chainId}/${entry.deploymentKey}`;
  const differences: Difference[] = [];
  const compare = (field: string, left: unknown, right: unknown) => {
    if (left !== right) {
      differences.push({ scope, field, static: left, registry: right });
    }
  };

  const market = entry.market;
  compare('displayName', displayNameOf(comet), market.contractName ?? market.displayName);
  compare('creationBlock', comet.creation.block.number, market.creationBlock);
  compare('baseAsset.address', lower(comet.base.asset.address), market.baseAsset.token.address);
  compare('baseAsset.symbol', comet.base.asset.canonicalName, market.baseAsset.token.symbol);
  compare('baseAsset.decimals', comet.base.asset.decimals, market.baseAsset.token.decimals);
  compare('baseAsset.priceFeed', lower(comet.base.priceFeed.address), market.baseAsset.priceFeed.address);
  /*
   * The constants declare every feed as eight decimals; the registry reads
   * them from the feed. A difference here is the assumption showing itself,
   * which is one of the reasons the registry exists.
   */
  compare('baseAsset.priceFeedDecimals', comet.base.priceFeed.decimals, market.baseAsset.priceFeed.decimals);
  compare(
    'baseAsset.usdPriceFeed',
    lower(comet.base.usdPriceFeed?.address),
    market.baseAsset.usdPriceFeed?.address ?? null,
  );
  compare('rewards.contract', lower(comet.rewards.contract.address), market.contracts.rewards);
  compare('rewards.asset', lower(comet.rewards.asset.address), market.rewardAsset?.token.address ?? null);
  compare('rewards.priceFeed', lower(comet.rewards.priceFeed.address), market.rewardAsset?.priceFeed?.address ?? null);

  return differences;
}

function byScopeAndField(left: Difference, right: Difference): number {
  return left.scope === right.scope
    ? (left.field < right.field ? -1 : left.field > right.field ? 1 : 0)
    : (left.scope < right.scope ? -1 : 1);
}

/*
 * Compares every market either source knows about. A market only one source
 * has is reported as such rather than as a set of field differences, because
 * the two raise different questions: one is a disagreement about data, the
 * other about which deployments exist at all.
 */
function compareWithStatic(snapshot: RegistrySnapshotV1): ShadowReport {
  const catalog = catalogOf(snapshot);
  const differences: Difference[]     = [];
  const onlyInStatic: string[]        = [];
  const onlyInRegistry: string[]      = [];
  const disabledInRegistry: string[]  = [];
  let staticMarkets   = 0;
  let registryMarkets = 0;

  /*
   * The catalog holds what the version serves; the snapshot also holds what
   * it deliberately does not, and that difference is exactly what separates a
   * disabled market from a missing one.
   */
  const disabled = new Map<string, string>();
  for (const network of snapshot.networks) {
    for (const market of network.markets) {
      if (market.status === 'disabled' && market.contracts.comet !== null) {
        disabled.set(`${network.key}:${market.contracts.comet}`, `${network.chainId}/${market.deploymentKey}`);
      }
    }
  }

  for (const network of COMPARED_NETWORKS) {
    const comets  = staticComets(network);
    const entries = catalog.marketsOn(network);
    staticMarkets   += comets.size;
    registryMarkets += entries.length;

    const seen = new Set<string>();
    for (const entry of entries) {
      const address = entry.market.contracts.comet;
      const comet   = address === null ? undefined : comets.get(address);
      if (comet === undefined) {
        onlyInRegistry.push(`${entry.chainId}/${entry.deploymentKey}`);
        continue;
      }
      seen.add(address!);
      differences.push(...compareMarket(entry, comet));
    }

    for (const [ address, comet ] of comets) {
      if (seen.has(address)) {
        continue;
      }
      const excluded = disabled.get(`${network}:${address}`);
      if (excluded !== undefined) {
        disabledInRegistry.push(excluded);
        continue;
      }
      onlyInStatic.push(`${network}/${displayNameOf(comet) ?? address}`);
    }
  }

  return {
    versionId:      catalog.versionId,
    checksum:       catalog.checksum,
    networks:       COMPARED_NETWORKS,
    staticMarkets,
    registryMarkets,
    onlyInStatic:       onlyInStatic.sort(),
    onlyInRegistry:     onlyInRegistry.sort(),
    disabledInRegistry: disabledInRegistry.sort(),
    differences:    differences.sort(byScopeAndField),
  };
}

export type { CometContract, Difference, ShadowReport };
export { COMPARED_NETWORKS, compareWithStatic, staticComets };
