import {
  Address,
  AssetDisplayOverrideV1,
  CONTRACT_ROLES,
  CONTRACT_ROLE_KEYS,
  ContractRoleKey,
  EXCEPTION_KINDS,
  MARKET_STATUSES,
  MarketStatus,
  MarketV1,
  NetworkV1,
  PRICE_QUOTES,
  ParsedRoot,
  PriceExceptionV1,
  PriceFeedV1,
  PriceQuote,
  UnwrappedCollateralAssetV1,
  isAddress,
  normalizeAddress,
} from '../../lib/model/comet-registry.js';

import type { MarketEnrichment } from './enrichment.js';
import { RegistryError } from './errors.js';
import { sha256Hex } from './source/roots.js';

/*
 * The reviewed overlay: everything about a market that the chain and the
 * pinned source cannot state. Labels, the default market, lifecycle status,
 * capabilities, the quote unit, the USD conversion feed, the reward feed and
 * its unit, network presentation, and price exceptions are all decisions,
 * not observations.
 *
 * Overlay documents are complete replacements with exact key sets: a missing
 * key is a missing decision, never an implicit default. The same shapes are
 * cloned from the active version, so an import inherits reviewed data instead
 * of asking an operator to restate it for every unchanged market.
 */
type MarketOverlay = {
  displayName:          string,
  contractName:         string | null,
  isDefault:            boolean,
  status:               MarketStatus,
  creationBlock:        number,
  collateralValueQuote: PriceQuote,
  capabilities: {
    rewards:            boolean,
    accountRewards:     boolean,
    transactionHistory: boolean,
  },
  baseAsset: {
    displayName:        string,
    isWrappedNative:    boolean,
    usdPriceFeedAddress: Address | null,
  },
  rewardPriceFeed: { address: Address, quote: PriceQuote } | null,
};

type NetworkOverlay = {
  displayName:               string,
  assetDisplayOverrides:     AssetDisplayOverrideV1[],
  unwrappedCollateralAssets: UnwrappedCollateralAssetV1[],
  priceExceptions:           PriceExceptionV1[],
};

const MAX_TEXT      = 200;
const MAX_PROVENANCE = 1000;
const MAX_OVERRIDES  = 200;
const MAX_BLOCK      = Number.MAX_SAFE_INTEGER;

function fail(message: string, scope: string): never {
  throw new RegistryError('OVERLAY_INVALID', message, scope);
}

function object(value: unknown, keys: readonly string[], scope: string): Record<string, unknown> {
  if (typeof(value) !== 'object' || value === null || Array.isArray(value)) {
    fail(`${scope} must be an object`, scope);
  }
  const record  = value as Record<string, unknown>;
  const present = Object.keys(record);
  const unknown = present.filter(key => !keys.includes(key));
  if (unknown.length > 0) {
    fail(`${scope} has unexpected keys: ${unknown.sort().join(', ')}`, scope);
  }
  const missing = keys.filter(key => !present.includes(key));
  if (missing.length > 0) {
    fail(`${scope} is missing: ${missing.join(', ')}`, scope);
  }
  return record;
}

function text(value: unknown, scope: string, { max = MAX_TEXT }: { max?: number } = {}): string {
  if (typeof(value) !== 'string' || value.trim().length === 0 || value.length > max) {
    fail(`${scope} must be a non-empty string of at most ${max} characters`, scope);
  }
  return value.trim();
}

function flag(value: unknown, scope: string): boolean {
  if (typeof(value) !== 'boolean') {
    fail(`${scope} must be a boolean`, scope);
  }
  return value;
}

function address(value: unknown, scope: string): Address {
  if (!isAddress(value)) {
    fail(`${scope} must be an address`, scope);
  }
  return normalizeAddress(value);
}

function member<T extends string>(value: unknown, allowed: readonly T[], scope: string): T {
  if (typeof(value) !== 'string' || !allowed.includes(value as T)) {
    fail(`${scope} must be one of ${allowed.join(', ')}`, scope);
  }
  return value as T;
}

function array(value: unknown, scope: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_OVERRIDES) {
    fail(`${scope} must be an array of at most ${MAX_OVERRIDES} entries`, scope);
  }
  return value;
}

function timestamp(value: unknown, scope: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof(value) !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(`${scope} must be an ISO-8601 timestamp or null`, scope);
  }
  return value;
}

function unique<T>(entries: T[], key: (entry: T) => string, scope: string): T[] {
  const keys = entries.map(key);
  if (new Set(keys).size !== keys.length) {
    fail(`${scope} lists the same address twice`, scope);
  }
  // arrays are stored sorted, so an overlay cannot differ by order alone
  return [ ...entries ].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
}

function parsePriceException(value: unknown, scope: string): PriceExceptionV1 {
  const kind = member((value as { kind?: unknown })?.kind, EXCEPTION_KINDS, `${scope}.kind`);
  switch (kind) {
    case 'zero_price': {
      const entry = object(value, [ 'kind', 'priceFeedAddress', 'provenance', 'expiresAt' ], scope);
      return {
        kind,
        priceFeedAddress: address(entry.priceFeedAddress, `${scope}.priceFeedAddress`),
        provenance:       text(entry.provenance, `${scope}.provenance`, { max: MAX_PROVENANCE }),
        expiresAt:        timestamp(entry.expiresAt, `${scope}.expiresAt`),
      };
    }
    case 'fixed_price': {
      const entry = object(value, [ 'kind', 'priceFeedAddress', 'price', 'provenance', 'expiresAt' ], scope);
      const price = object(entry.price, [ 'value', 'decimals' ], `${scope}.price`);
      if (typeof(price.value) !== 'string' || !/^[0-9]+$/.test(price.value)) {
        fail(`${scope}.price.value must be a decimal string`, scope);
      }
      if (typeof(price.decimals) !== 'number' || !Number.isInteger(price.decimals) || price.decimals < 0 || price.decimals > 255) {
        fail(`${scope}.price.decimals must be between 0 and 255`, scope);
      }
      return {
        kind,
        priceFeedAddress: address(entry.priceFeedAddress, `${scope}.priceFeedAddress`),
        price:            { value: price.value, decimals: price.decimals },
        provenance:       text(entry.provenance, `${scope}.provenance`, { max: MAX_PROVENANCE }),
        expiresAt:        timestamp(entry.expiresAt, `${scope}.expiresAt`),
      };
    }
    case 'deprecated_price_remap': {
      const entry       = object(value, [ 'kind', 'priceFeedAddress', 'replacementPriceFeedAddress', 'provenance', 'expiresAt' ], scope);
      const replaced    = address(entry.priceFeedAddress, `${scope}.priceFeedAddress`);
      const replacement = address(entry.replacementPriceFeedAddress, `${scope}.replacementPriceFeedAddress`);
      if (replaced === replacement) {
        fail(`${scope} remaps a feed onto itself`, scope);
      }
      /*
       * The overlay never carries feed decimals: enrichment reads them from
       * the replacement feed, so a reviewer cannot state a scale the chain
       * disagrees with. The placeholder is replaced in applyNetworkOverlay.
       */
      return {
        kind,
        priceFeedAddress:     replaced,
        replacementPriceFeed: { address: replacement, decimals: -1 },
        provenance:           text(entry.provenance, `${scope}.provenance`, { max: MAX_PROVENANCE }),
        expiresAt:            timestamp(entry.expiresAt, `${scope}.expiresAt`),
      };
    }
  }
}

function parseNetworkOverlay(value: unknown, scope: string = 'overlay'): NetworkOverlay {
  const entry = object(
    value,
    [ 'displayName', 'assetDisplayOverrides', 'unwrappedCollateralAssets', 'priceExceptions' ],
    scope,
  );

  const overrides = array(entry.assetDisplayOverrides, `${scope}.assetDisplayOverrides`).map((item, index) => {
    const override = object(item, [ 'tokenAddress', 'displayAddress', 'symbol', 'name' ], `${scope}.assetDisplayOverrides[${index}]`);
    return {
      tokenAddress:   address(override.tokenAddress, `${scope}.assetDisplayOverrides[${index}].tokenAddress`),
      // the zero address displays a wrapped native asset as the native one
      displayAddress: address(override.displayAddress, `${scope}.assetDisplayOverrides[${index}].displayAddress`),
      symbol:         text(override.symbol, `${scope}.assetDisplayOverrides[${index}].symbol`),
      name:           text(override.name, `${scope}.assetDisplayOverrides[${index}].name`),
    };
  });

  const unwrapped = array(entry.unwrappedCollateralAssets, `${scope}.unwrappedCollateralAssets`).map((item, index) => {
    const pair = object(item, [ 'wrappedTokenAddress', 'tokenAddress', 'symbol', 'name' ], `${scope}.unwrappedCollateralAssets[${index}]`);
    return {
      wrappedTokenAddress: address(pair.wrappedTokenAddress, `${scope}.unwrappedCollateralAssets[${index}].wrappedTokenAddress`),
      tokenAddress:        address(pair.tokenAddress, `${scope}.unwrappedCollateralAssets[${index}].tokenAddress`),
      symbol:              text(pair.symbol, `${scope}.unwrappedCollateralAssets[${index}].symbol`),
      name:                text(pair.name, `${scope}.unwrappedCollateralAssets[${index}].name`),
    };
  });

  const exceptions = array(entry.priceExceptions, `${scope}.priceExceptions`)
    .map((item, index) => parsePriceException(item, `${scope}.priceExceptions[${index}]`));

  return {
    displayName:               text(entry.displayName, `${scope}.displayName`),
    assetDisplayOverrides:     unique(overrides, override => override.tokenAddress, `${scope}.assetDisplayOverrides`),
    unwrappedCollateralAssets: unique(unwrapped, pair => pair.wrappedTokenAddress, `${scope}.unwrappedCollateralAssets`),
    priceExceptions:           unique(exceptions, exception => exception.priceFeedAddress, `${scope}.priceExceptions`),
  };
}

function parseMarketOverlay(value: unknown, scope: string = 'overlay'): MarketOverlay {
  const entry = object(value, [
    'displayName', 'contractName', 'isDefault', 'status', 'creationBlock',
    'collateralValueQuote', 'capabilities', 'baseAsset', 'rewardPriceFeed',
  ], scope);

  const capabilities = object(entry.capabilities, [ 'rewards', 'accountRewards', 'transactionHistory' ], `${scope}.capabilities`);
  const baseAsset    = object(entry.baseAsset, [ 'displayName', 'isWrappedNative', 'usdPriceFeedAddress' ], `${scope}.baseAsset`);

  const creationBlock = entry.creationBlock;
  if (typeof(creationBlock) !== 'number' || !Number.isInteger(creationBlock) || creationBlock < 0 || creationBlock > MAX_BLOCK) {
    fail(`${scope}.creationBlock must be a non-negative block number`, scope);
  }

  let rewardPriceFeed: MarketOverlay['rewardPriceFeed'] = null;
  if (entry.rewardPriceFeed !== null) {
    const feed = object(entry.rewardPriceFeed, [ 'address', 'quote' ], `${scope}.rewardPriceFeed`);
    rewardPriceFeed = {
      address: address(feed.address, `${scope}.rewardPriceFeed.address`),
      quote:   member(feed.quote, PRICE_QUOTES, `${scope}.rewardPriceFeed.quote`),
    };
  }

  return {
    displayName:          text(entry.displayName, `${scope}.displayName`),
    contractName:         entry.contractName === null ? null : text(entry.contractName, `${scope}.contractName`),
    isDefault:            flag(entry.isDefault, `${scope}.isDefault`),
    status:               member(entry.status, MARKET_STATUSES, `${scope}.status`),
    creationBlock,
    collateralValueQuote: member(entry.collateralValueQuote, PRICE_QUOTES, `${scope}.collateralValueQuote`),
    capabilities: {
      rewards:            flag(capabilities.rewards, `${scope}.capabilities.rewards`),
      accountRewards:     flag(capabilities.accountRewards, `${scope}.capabilities.accountRewards`),
      transactionHistory: flag(capabilities.transactionHistory, `${scope}.capabilities.transactionHistory`),
    },
    baseAsset: {
      displayName:         text(baseAsset.displayName, `${scope}.baseAsset.displayName`),
      isWrappedNative:     flag(baseAsset.isWrappedNative, `${scope}.baseAsset.isWrappedNative`),
      usdPriceFeedAddress: baseAsset.usdPriceFeedAddress === null
        ? null
        : address(baseAsset.usdPriceFeedAddress, `${scope}.baseAsset.usdPriceFeedAddress`),
    },
    rewardPriceFeed,
  };
}

/*
 * The digest an overlay audit event records, over the normalized overlay. It
 * identifies what was applied without storing the request body.
 */
async function overlayDigest(overlay: MarketOverlay | NetworkOverlay): Promise<string> {
  return sha256Hex(JSON.stringify(overlay));
}

/*
 * The feed addresses an overlay introduces. Their decimals are read on chain,
 * because the overlay states which feed to use, never how to scale it.
 */
function overlayFeedAddresses(overlay: MarketOverlay): Address[] {
  return [
    ...(overlay.baseAsset.usdPriceFeedAddress === null ? [] : [ overlay.baseAsset.usdPriceFeedAddress ]),
    ...(overlay.rewardPriceFeed === null ? [] : [ overlay.rewardPriceFeed.address ]),
  ];
}

function networkOverlayFeedAddresses(overlay: NetworkOverlay): Address[] {
  return overlay.priceExceptions
    .filter(exception => exception.kind === 'deprecated_price_remap')
    .map(exception => (exception as { replacementPriceFeed: PriceFeedV1 }).replacementPriceFeed.address);
}

function feedOf(feeds: Map<Address, PriceFeedV1>, address: Address, scope: string): PriceFeedV1 {
  const feed = feeds.get(address);
  if (feed === undefined) {
    throw new RegistryError('OVERLAY_FEED_UNREADABLE', `the decimals of ${address} were not read`, scope);
  }
  return feed;
}

/*
 * Combines one market's three sources into the wire shape: the pinned roots
 * for contract addresses, enrichment for on-chain identity, and the overlay
 * for reviewed decisions.
 */
function applyMarketOverlay(
  root: ParsedRoot,
  enrichment: MarketEnrichment,
  overlay: MarketOverlay,
  feeds: Map<Address, PriceFeedV1>,
  id: string,
): MarketV1 {
  const scope     = root.rootPath;
  const contracts = Object.fromEntries(
    CONTRACT_ROLES.map(role => [ CONTRACT_ROLE_KEYS[role], root.contracts[role] ?? null ])
  ) as Record<ContractRoleKey, Address | null>;

  const rewardAsset = enrichment.rewardToken === null ? null : {
    token:          enrichment.rewardToken,
    priceFeed:      overlay.rewardPriceFeed === null ? null : feedOf(feeds, overlay.rewardPriceFeed.address, scope),
    priceFeedQuote: overlay.rewardPriceFeed === null ? null : overlay.rewardPriceFeed.quote,
  };

  return {
    id,
    deploymentKey:        root.deploymentKey,
    displayName:          overlay.displayName,
    contractName:         overlay.contractName,
    isDefault:            overlay.isDefault,
    status:               overlay.status,
    creationBlock:        overlay.creationBlock,
    collateralValueQuote: overlay.collateralValueQuote,
    capabilities:         overlay.capabilities,
    contracts,
    baseAsset: {
      token:           enrichment.baseToken,
      displayName:     overlay.baseAsset.displayName,
      isWrappedNative: overlay.baseAsset.isWrappedNative,
      priceFeed:       enrichment.basePriceFeed,
      usdPriceFeed:    overlay.baseAsset.usdPriceFeedAddress === null
        ? null
        : feedOf(feeds, overlay.baseAsset.usdPriceFeedAddress, scope),
    },
    rewardAsset,
    // getAssetInfo order is the on-chain asset index order
    collateralAssets: enrichment.collateralAssets,
  };
}

/*
 * Builds one network of the snapshot. Markets are ordered by creation block
 * and then deployment key, as the wire contract fixes.
 */
function applyNetworkOverlay(
  identity: { chainId: number, key: string, upstreamKey: string, testnet: boolean },
  overlay: NetworkOverlay,
  markets: MarketV1[],
  feeds: Map<Address, PriceFeedV1>,
): NetworkV1 {
  const scope = identity.key;
  return {
    chainId:     identity.chainId,
    key:         identity.key,
    upstreamKey: identity.upstreamKey,
    displayName: overlay.displayName,
    testnet:     identity.testnet,
    presentation: {
      assetDisplayOverrides:     overlay.assetDisplayOverrides,
      unwrappedCollateralAssets: overlay.unwrappedCollateralAssets,
    },
    priceExceptions: overlay.priceExceptions.map(exception => exception.kind === 'deprecated_price_remap'
      ? { ...exception, replacementPriceFeed: feedOf(feeds, exception.replacementPriceFeed.address, scope) }
      : exception),
    markets: [ ...markets ].sort((left, right) => (
      left.creationBlock - right.creationBlock
        || (left.deploymentKey < right.deploymentKey ? -1 : left.deploymentKey > right.deploymentKey ? 1 : 0)
    )),
  };
}

/*
 * Networks are ordered by chain id, which completes the snapshot ordering the
 * wire contract fixes.
 */
function orderNetworks(networks: NetworkV1[]): NetworkV1[] {
  return [ ...networks ].sort((left, right) => left.chainId - right.chainId);
}

export type { MarketOverlay, NetworkOverlay };

export {
  applyMarketOverlay,
  applyNetworkOverlay,
  networkOverlayFeedAddresses,
  orderNetworks,
  overlayDigest,
  overlayFeedAddresses,
  parseMarketOverlay,
  parseNetworkOverlay,
};
