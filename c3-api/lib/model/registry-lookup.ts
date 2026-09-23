import type * as KnownNetwork from '../well-known/networks/network.js';

import type {
  Comet,
  Contract,
  StandaloneContract,
} from '../well-known/contracts/types.js';

import type { Address, MarketV1, TokenV1 } from './comet-registry.js';

/*
 * What a computation needs from the registry: resolve an address, and say
 * which version it is answering from.
 *
 * The request catalog implements this, and it is the only shape the
 * computations depend on. They are given one lookup for the whole request, so
 * every address in one response is resolved against one version, and `key()`
 * is what puts that version into their cache keys: the same addresses
 * described differently are different results.
 */
type ResolvedMarket = {
  market: MarketV1,
  comet:  Contract<StandaloneContract<Comet>>,
};

type RegistryLookup = {
  key(): string,
  // the key of what one network's markets say, for a computation that reads only that network
  keyFor(network: KnownNetwork.Name): string,
  marketAt(network: KnownNetwork.Name, cometAddress: Address): ResolvedMarket | null,
  marketsOn(network: KnownNetwork.Name): ResolvedMarket[],
  tokenAt(network: KnownNetwork.Name, address: Address): TokenV1 | null,
  baseTokenAt(network: KnownNetwork.Name, cometAddress: Address): TokenV1 | null,
  /*
   * The symbol a token is shown by where the network renames it — bridged
   * USDC as USDC.e — and null where it keeps its own. A token shown as the
   * chain's own token instead, WETH as ETH, keeps its own symbol here: that
   * is how the website offers it, not what a transaction moved.
   */
  renamedSymbolAt(network: KnownNetwork.Name, address: Address): string | null,
};

export type { RegistryLookup, ResolvedMarket };
