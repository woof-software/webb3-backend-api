import * as Fallible     from '../../lib/fallible/fallible.js';
import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import { canonicalJson } from '../../lib/canonical-json.js';
import { keccak256 } from '../../lib/hash.js';


import {
  Comet,
  Contract,
  ERC20,
  PriceFeed,
  StandaloneContract,
} from '../../lib/well-known/contracts/types.js';

import {
  Address,
  MarketV1,
  NetworkV1,
  PriceExceptionV1,
  PriceFeedV1,
  RegistryAnnotation,
  RegistrySnapshotV1,
  TokenV1,
  checksumAddress,
  registryOf,
} from '../../lib/model/comet-registry.js';

/*
 * The request catalog: one activated snapshot, materialized into the contract
 * objects the existing computations already consume.
 *
 * A computation should not care whether a market came from a static constant
 * or from D1, so the catalog hands out the same `Comet`, `ERC20`, and
 * `PriceFeed` shapes the well-known constants do. What it adds is identity:
 * every lookup is answered from one pinned version, and the version id is
 * available for cache keys, because two versions can describe the same
 * address with different metadata.
 */
type RegistryComet = Contract<StandaloneContract<Comet>> & { registry: RegistryAnnotation };

type CatalogMarket = {
  chainId:       number,
  network:       KnownNetwork.Name,
  deploymentKey: string,
  market:        MarketV1,
  comet:         RegistryComet,
};

type Catalog = {
  versionId: string,
  checksum:  string,
  /*
   * What this catalog contributes to a computation's cache key. It is the
   * content checksum, not the version id: re-importing the same markets
   * produces a new version that must not invalidate everything computed from
   * the previous one, while any change to what the registry says must.
   */
  key(): string,
  /*
   * The same for a computation that reads one network only: the markets it
   * serves there, by their own keys, and the names the network renames tokens
   * to. A change on another network, or to how a market is listed, leaves it
   * alone.
   */
  keyFor(network: KnownNetwork.Name): string,
  /*
   * Markets the API may serve. `enabled` and `deprecated` are readable;
   * `disabled` markets are excluded, because a runtime consumer must not
   * resolve one.
   */
  markets(): CatalogMarket[],
  discoverable(): CatalogMarket[],
  networks(): NetworkV1[],
  networkOf(network: KnownNetwork.Name): NetworkV1 | null,
  marketAt(network: KnownNetwork.Name, cometAddress: Address): CatalogMarket | null,
  marketsOn(network: KnownNetwork.Name): CatalogMarket[],
  priceExceptionFor(network: KnownNetwork.Name, priceFeed: Address): PriceExceptionV1 | null,
  defaultMarket(): CatalogMarket | null,
  /*
   * Every token of a version, by network and address: base, collateral, and
   * reward assets alike. A transaction log names a token by address only, so
   * this is what turns one into a symbol and a scale.
   */
  tokenAt(network: KnownNetwork.Name, address: Address): TokenV1 | null,
  // the base token of a market, addressed by its Comet
  baseTokenAt(network: KnownNetwork.Name, cometAddress: Address): TokenV1 | null,
  /*
   * The symbol a network's presentation renames a token to, where it keeps
   * the token's own address; a token presented as the chain's own token is
   * not renamed here.
   */
  renamedSymbolAt(network: KnownNetwork.Name, address: Address): string | null,
};

function networkName(network: NetworkV1): KnownNetwork.Name | null {
  const known = KnownNetwork.lookup({ name: network.key });
  return Fallible.isFailure(known) ? null : (network.key as KnownNetwork.Name);
}

/*
 * An address as a contract carries it, and so as every response echoes it:
 * checksummed, the form the API answered with before the registry. The
 * registry stores addresses lowercased, and every lookup and cache key keeps
 * comparing that form.
 */
function shown(address: Address): Address {
  return checksumAddress(address) as Address;
}

/*
 * A token as the contract shapes carry it. The registry's `name` goes into
 * `description`, which is where the static constants put the human name of a
 * token ("USD Coin" beside the symbol "USDC") and where the market rewards
 * computation reads it from. `displayName` stays unset, so a token still
 * reads as its symbol wherever a contract is named.
 */
function erc20(
  network: KnownNetwork.Name,
  token: TokenV1,
  creationBlock: number,
): Contract<StandaloneContract<ERC20>> {
  return ERC20(token.symbol, {
    network,
    address:     shown(token.address),
    decimals:    token.decimals,
    description: token.name,
    block:       { number: creationBlock },
  }) as unknown as Contract<StandaloneContract<ERC20>>;
}

function priceFeed(
  network: KnownNetwork.Name,
  feed: PriceFeedV1,
  creationBlock: number,
): Contract<StandaloneContract<PriceFeed>> {
  return PriceFeed({
    network,
    address:  shown(feed.address),
    decimals: feed.decimals,
    block:    { number: creationBlock },
  }) as unknown as Contract<StandaloneContract<PriceFeed>>;
}

/*
 * What identifies a market to a cache: everything the registry says about it
 * that a computation reads, and the exceptions of its network, which decide
 * whether a price is read at all.
 *
 * Left out is what no computation reads, so that changing it does not throw
 * away work that did not depend on it — daily summaries reach back years:
 *
 * - the row id, which changes with every import even when the market does not;
 * - how the website lists the market — its label, slug and section, whether
 *   it opens first — and whether it is served, which decides whether a
 *   computation runs, not what it computes;
 * - the contract name, which only governance titles use, uncached;
 * - the base asset's display name.
 *
 * The rewards summary does report the labels, and so keys itself by them.
 */
function marketDigest(market: MarketV1, priceExceptions: PriceExceptionV1[]): string {
  const {
    id: _id, displayName: _label, slug: _slug, isInstitutional: _section, isDefault: _default,
    status: _status, contractName: _contract, baseAsset: { displayName: _baseName, ...baseAsset },
    ...identity
  } = market;
  return keccak256(canonicalJson({ identity: { ...identity, baseAsset }, priceExceptions })).slice(0, 16);
}

/*
 * One market as the computations see it. A market without a reward feed still
 * has a rewards contract and token, so the shape stays complete; what changes
 * is that its rewards capability is off, and consumers check that rather than
 * inferring it from a missing feed.
 *
 * The contract keys itself by address and market digest, so two versions that
 * describe the same market share every cached computation of it, and a version
 * that changes a token, a feed, or an exception shares none.
 */
function cometOf(
  network: KnownNetwork.Name,
  market: MarketV1,
  annotation: Omit<RegistryAnnotation, 'digest' | 'market'>,
): RegistryComet {
  const block = market.creationBlock;
  const base  = {
    asset:     erc20(network, market.baseAsset.token, block),
    priceFeed: priceFeed(network, market.baseAsset.priceFeed, block),
    ...(market.baseAsset.usdPriceFeed === null
      ? {}
      : { usdPriceFeed: priceFeed(network, market.baseAsset.usdPriceFeed, block) }),
  };

  const rewardToken = market.rewardAsset?.token ?? null;
  const rewardFeed  = market.rewardAsset?.priceFeed ?? null;
  const rewards = {
    asset:     rewardToken === null ? erc20(network, EMPTY_TOKEN, block) : erc20(network, rewardToken, block),
    contract:  ERC20('CometRewards', {
      network,
      address:  shown(market.contracts.rewards ?? ZERO_ADDRESS),
      decimals: 0,
      block:    { number: block },
    }) as unknown as Contract<StandaloneContract>,
    priceFeed: rewardFeed === null
      ? priceFeed(network, { address: ZERO_ADDRESS, decimals: 8 }, block)
      : priceFeed(network, rewardFeed, block),
  };

  const address = market.contracts.comet ?? ZERO_ADDRESS;
  const digest  = marketDigest(market, annotation.priceExceptions);
  const comet   = Comet({
    network,
    address:     shown(address),
    displayName: market.contractName ?? market.displayName,
    // the registry stores no alias keys; a market is addressed by its Comet
    aliases:     [] as const,
    block:       { number: block },
    base,
    rewards,
  });

  return Object.assign(comet as unknown as Contract<StandaloneContract<Comet>>, {
    registry: { ...annotation, digest, market },
    key:      () => `${address}@${digest}`,
  });
}

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';

// stands in for a reward token a market does not have, so the contract shape
// stays uniform; capabilities.rewards is what says whether it is usable
const EMPTY_TOKEN: TokenV1 = { address: ZERO_ADDRESS, symbol: 'NONE', name: 'No reward token', decimals: 0 };

/*
 * The exceptions of a network that still apply.
 *
 * An exception may carry an expiry, and an expired one must stop applying
 * without waiting for a new import. Expiry is resolved here, once per
 * request, rather than inside a computation: a cached result must not change
 * meaning because time passed while it sat in the cache, and dropping an
 * exception here changes the market digest, which retires exactly the cached
 * results that depended on it.
 */
function applicableExceptions(exceptions: PriceExceptionV1[], now: number): PriceExceptionV1[] {
  return exceptions.filter(exception => {
    if (exception.expiresAt === null) {
      return true;
    }
    const expiresAt = Date.parse(exception.expiresAt);
    /*
     * Compared as instants, never as strings: an overlay may state an expiry
     * in any form Date.parse accepts, and "2026-09-21T13:00:00+02:00" sorts
     * after the same moment written in Z. An expiry that cannot be parsed at
     * all is treated as expired, because an exception nobody can date is not
     * one to keep suppressing a live feed with.
     */
    return Number.isFinite(expiresAt) && expiresAt > now;
  });
}

/*
 * Materializes a snapshot once per request. Building the contract objects is
 * cheap, and holding one catalog for the whole request is what keeps every
 * computation of that request on the same version.
 */
function catalogOf(snapshot: RegistrySnapshotV1, now: Date = new Date()): Catalog {
  const asOf = now.getTime();
  const markets: CatalogMarket[] = [];
  const networks: NetworkV1[]    = [];
  // every token of the version, by network and lowercased address
  const tokens = new Map<string, TokenV1>();
  const bases  = new Map<string, TokenV1>();
  /*
   * Markets by network and Comet address. Transaction history resolves a
   * stream's contracts for every stream on every merge step, so this lookup
   * is on a hot path and must not be a scan of the whole version.
   */
  const byComet = new Map<string, CatalogMarket>();
  const byNetworkMarkets = new Map<string, CatalogMarket[]>();
  // the exceptions of each network that have not expired
  const byException = new Map<string, PriceExceptionV1[]>();

  for (const network of snapshot.networks) {
    const name = networkName(network);
    if (name === null) {
      // a network this API cannot name is not one it can serve
      continue;
    }
    networks.push(network);
    const exceptions = applicableExceptions(network.priceExceptions, asOf);
    byException.set(name, exceptions);

    for (const market of network.markets) {
      if (market.status === 'disabled') {
        continue;
      }
      const comet = cometOf(name, market, {
        versionId:       snapshot.registryVersion.id,
        chainId:         network.chainId,
        deploymentKey:   market.deploymentKey,
        priceExceptions: exceptions,
      });
      const entry: CatalogMarket = {
        chainId:       network.chainId,
        network:       name,
        deploymentKey: market.deploymentKey,
        market,
        comet,
      };
      markets.push(entry);
      const served = byNetworkMarkets.get(name) ?? [];
      served.push(entry);
      byNetworkMarkets.set(name, served);
      if (market.contracts.comet !== null) {
        byComet.set(`${name}:${market.contracts.comet}`, entry);
      }

      /*
       * A disabled market contributes no tokens either: the version keeps it
       * for diagnostics, and nothing the API serves may resolve through it.
       */
      for (const token of [
        market.baseAsset.token,
        ...(market.rewardAsset === null ? [] : [ market.rewardAsset.token ]),
        ...market.collateralAssets.map(asset => asset.token),
      ]) {
        tokens.set(`${name}:${token.address}`, token);
      }
      if (market.contracts.comet !== null) {
        bases.set(`${name}:${market.contracts.comet}`, market.baseAsset.token);
      }
    }
  }

  const byNetwork = new Map<string, NetworkV1>(networks.map(network => [ network.key, network ]));

  const renamed = new Map<string, string>(networks.flatMap(network => network.presentation.assetDisplayOverrides
    .filter(override => override.displayAddress === override.tokenAddress)
    .map(override => [ `${network.key}:${override.tokenAddress}`, override.symbol ] as const)));

  const networkKeys = new Map<string, string>(networks.map(network => {
    const served  = (byNetworkMarkets.get(network.key as KnownNetwork.Name) ?? []).map(entry => entry.comet.key()).sort();
    const renames = network.presentation.assetDisplayOverrides
      .filter(override => override.displayAddress === override.tokenAddress)
      .map(override => `${override.tokenAddress}=${override.symbol}`)
      .sort();
    return [ network.key, keccak256(canonicalJson({ served, renames })).slice(0, 16) ];
  }));

  return {
    versionId: snapshot.registryVersion.id,
    checksum:  snapshot.registryVersion.checksum,
    key:       () => `registry:${snapshot.registryVersion.checksum.slice(0, 16)}`,
    keyFor:    network => `registry:${network}:${networkKeys.get(network) ?? 'none'}`,
    markets:   () => markets,
    networks:  () => networks,
    tokenAt:     (network, address) => tokens.get(`${network}:${address.toLowerCase()}`) ?? null,
    baseTokenAt: (network, address) => bases.get(`${network}:${address.toLowerCase()}`) ?? null,
    renamedSymbolAt: (network, address) => renamed.get(`${network}:${address.toLowerCase()}`) ?? null,
    // discovery and defaults ignore deprecated markets, which stay readable
    discoverable: () => markets.filter(entry => entry.market.status === 'enabled'),
    networkOf:    network => byNetwork.get(network) ?? null,
    marketsOn:    network => byNetworkMarkets.get(network) ?? [],
    marketAt:     (network, cometAddress) => byComet.get(`${network}:${cometAddress.toLowerCase()}`) ?? null,
    priceExceptionFor(network, feedAddress) {
      const feed = feedAddress.toLowerCase();
      return byException.get(network)?.find(exception => exception.priceFeedAddress === feed) ?? null;
    },
    /*
     * The default is a market the API offers, so a deprecated one is not it,
     * for the same reason it is not discoverable: the unique index that keeps
     * one default per version does not care about status.
     */
    defaultMarket: () => markets.find(entry => entry.market.isDefault && entry.market.status === 'enabled') ?? null,
  };
}

export type { Catalog, CatalogMarket, RegistryComet };
export { ZERO_ADDRESS, catalogOf, marketDigest, registryOf };
