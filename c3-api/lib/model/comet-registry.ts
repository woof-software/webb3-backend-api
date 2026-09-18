/*
 * Types shared by the Comet registry: the rows of the APP_DB tables created
 * in migrations/0001_comet_registry.sql, the records parsed from the pinned
 * Comet source, and the RegistrySnapshotV1 wire contract frozen in
 * tests/fixtures/registry/registry-snapshot-v1.json.
 *
 * Addresses are stored and compared lowercase. The registry validates them
 * with the anchored validator below rather than Eth.parseAddress, whose
 * pattern is unanchored and so accepts an address embedded in other text.
 */

// same shape as Eth.Address, without importing the runtime constants module
type Address = `0x${string}`;

/*
 * The closed value sets of the schema. Each one is written once as a const
 * array, so the type and the runtime list validation uses cannot drift apart,
 * and the values are exactly what D1 stores and the wire contract carries.
 */
const CONTRACT_ROLES   = [ 'comet', 'configurator', 'rewards', 'bulker', 'fauceteer', 'bridge_receiver' ] as const;
const ASSET_ROLES      = [ 'base', 'reward', 'collateral' ] as const;
const PRICE_QUOTES     = [ 'usd', 'base' ] as const;
const MARKET_STATUSES  = [ 'enabled', 'deprecated', 'disabled' ] as const;
const VERSION_STATUSES = [ 'importing', 'invalid', 'validated' ] as const;
const EXCEPTION_KINDS  = [ 'zero_price', 'fixed_price', 'deprecated_price_remap' ] as const;

const SYNC_TRIGGER_KINDS = [ 'scheduled', 'manual' ] as const;
const SYNC_RUN_STATUSES  = [ 'running', 'failed', 'completed' ] as const;
const SYNC_OUTCOMES      = [ 'imported', 'no_change' ] as const;
const SYNC_ITEM_STATUSES = [ 'pending', 'processing', 'completed', 'failed' ] as const;

type ContractRole  = (typeof CONTRACT_ROLES)[number];

/*
 * The camelCase spelling of each role. D1 stores snake_case role values,
 * while RegistrySnapshotV1 and the upstream roots.json documents use
 * camelCase keys, so the two spellings are tied together here rather than
 * repeated wherever the wire shape or the parser needs them.
 */
const CONTRACT_ROLE_KEYS = {
  comet:           'comet',
  configurator:    'configurator',
  rewards:         'rewards',
  bulker:          'bulker',
  fauceteer:       'fauceteer',
  bridge_receiver: 'bridgeReceiver',
} as const satisfies Record<ContractRole, string>;

type ContractRoleKey = (typeof CONTRACT_ROLE_KEYS)[ContractRole];
type AssetRole     = (typeof ASSET_ROLES)[number];
type PriceQuote    = (typeof PRICE_QUOTES)[number];
type MarketStatus  = (typeof MARKET_STATUSES)[number];
type VersionStatus = (typeof VERSION_STATUSES)[number];
type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

type SyncTriggerKind = (typeof SYNC_TRIGGER_KINDS)[number];
type SyncRunStatus   = (typeof SYNC_RUN_STATUSES)[number];
type SyncOutcome     = (typeof SYNC_OUTCOMES)[number];
type SyncItemStatus  = (typeof SYNC_ITEM_STATUSES)[number];

/*
 * Anchored address validation. Accepts any casing, because upstream roots
 * are checksummed, and normalizeAddress lowercases for storage.
 */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SHA1_PATTERN    = /^[0-9a-f]{40}$/;
const SHA256_PATTERN  = /^[0-9a-f]{64}$/;

function isAddress(value: unknown): value is Address {
  return typeof(value) === 'string' && ADDRESS_PATTERN.test(value);
}

function normalizeAddress(value: Address | string): Address {
  return value.toLowerCase() as Address;
}

function isCommitSha(value: unknown): value is string {
  return typeof(value) === 'string' && SHA1_PATTERN.test(value);
}

function isChecksum(value: unknown): value is string {
  return typeof(value) === 'string' && SHA256_PATTERN.test(value);
}

/*
 * Source identity of one deployment discovered in the Comet repository.
 * `upstreamNetworkKey` is the repository's own directory name, such as
 * 'mainnet'; `network` is this API's canonical name, 'ethereum-mainnet'.
 */
type DeploymentPath = {
  rootPath:           string,
  upstreamNetworkKey: string,
  deploymentKey:      string,
};

/*
 * One parsed roots.json. `contracts` holds the roles the registry stores;
 * `otherRoots` holds every remaining key, which the registry does not store
 * but does include in the checksum, so a renamed or removed role changes the
 * checksum instead of disappearing unnoticed.
 */
type ParsedRoot = DeploymentPath & {
  network:      string,
  chainId:      number,
  sourceBlobSha: string,
  contracts:    Partial<Record<ContractRole, Address>>,
  otherRoots:   Record<string, Address>,
  checksum:     string,
};

/*
 * D1 rows. Booleans are INTEGER 0 or 1 and every nullable column is
 * explicitly nullable, matching the migration.
 */
type RegistryVersionRow = {
  id:                string,
  source_repository: string,
  source_commit_sha: string,
  source_checksum:   string,
  snapshot_checksum: string | null,
  attempt:           number,
  status:            VersionStatus,
  created_at:        string,
  validated_at:      string | null,
  created_by:        string,
};

type RegistryNetworkRow = {
  id:                   string,
  registry_version_id:  string,
  chain_id:             number,
  upstream_network_key: string,
  canonical_name:       string,
  display_name:         string,
  is_testnet:           number,
  metadata:             string,
};

type MarketRow = {
  id:                          string,
  registry_version_id:         string,
  network_id:                  string,
  deployment_key:              string,
  display_name:                string,
  contract_name:               string | null,
  creation_block:              number,
  status:                      MarketStatus,
  is_default:                  number,
  rewards_enabled:             number,
  account_rewards_enabled:     number,
  transaction_history_enabled: number,
  collateral_value_quote:      PriceQuote,
};

type TokenRow = {
  id:                  string,
  registry_version_id: string,
  network_id:          string,
  address:             Address,
  symbol:              string,
  name:                string,
  decimals:            number,
};

type MarketContractRow = {
  id?:       number,
  market_id: string,
  role:      ContractRole,
  address:   Address,
};

type MarketAssetRow = {
  id?:                     number,
  registry_version_id:     string,
  network_id:              string,
  market_id:               string,
  token_id:                string,
  role:                    AssetRole,
  asset_index:             number | null,
  price_feed_address:      Address | null,
  price_feed_decimals:     number | null,
  price_feed_quote:        PriceQuote | null,
  usd_price_feed_address:  Address | null,
  usd_price_feed_decimals: number | null,
  display_name:            string | null,
  is_wrapped_native:       number | null,
};

type NetworkPriceExceptionRow = {
  id?:                             number,
  registry_version_id:             string,
  network_id:                      string,
  price_feed_address:              Address,
  kind:                            ExceptionKind,
  fixed_price_value:               string | null,
  fixed_price_decimals:            number | null,
  replacement_price_feed_address:  Address | null,
  replacement_price_feed_decimals: number | null,
  provenance:                      string,
  expires_at:                      string | null,
};

type ValidationResultRow = {
  id?:                 number,
  registry_version_id: string,
  validation_attempt:  number,
  check_name:          string,
  scope:               string,
  passed:              number,
  details:             string,
  created_at:          string,
};

type SyncRunRow = {
  id:                  string,
  source_commit_sha:   string,
  tracked_ref:         string | null,
  registry_version_id: string | null,
  trigger_kind:        SyncTriggerKind,
  requested_by:        string | null,
  reason:              string | null,
  status:              SyncRunStatus,
  outcome:             SyncOutcome | null,
  lease_owner:         string | null,
  lease_generation:    number,
  lease_expires_at:    string | null,
  expected_count:      number,
  completed_count:     number,
  failed_count:        number,
  last_error:          string | null,
  started_at:          string,
  completed_at:        string | null,
};

type SyncRunItemRow = {
  id:                   string,
  sync_run_id:          string,
  root_path:            string,
  source_blob_sha:      string,
  root_checksum:        string,
  upstream_network_key: string,
  deployment_key:       string,
  status:               SyncItemStatus,
  attempts:             number,
  claim_owner:          string | null,
  claim_generation:     number,
  claimed_at:           string | null,
  completed_at:         string | null,
  last_error:           string | null,
  created_at:           string,
  updated_at:           string,
};

/*
 * RegistrySnapshotV1, the public wire contract. The committed fixture is
 * normative and tests/lib/registry/registry-snapshot-v1-fixture.test.ts
 * enforces its exact key sets and cross-field rules.
 */
type PriceFeedV1 = {
  address:  Address,
  decimals: number,
};

type TokenV1 = {
  address:  Address,
  symbol:   string,
  name:     string,
  decimals: number,
};

type BaseAssetV1 = {
  token:           TokenV1,
  displayName:     string,
  isWrappedNative: boolean,
  priceFeed:       PriceFeedV1,
  usdPriceFeed:    PriceFeedV1 | null,
};

type RewardAssetV1 = {
  token:          TokenV1,
  priceFeed:      PriceFeedV1 | null,
  priceFeedQuote: PriceQuote | null,
};

type CollateralAssetV1 = {
  assetIndex: number,
  token:      TokenV1,
  priceFeed:  PriceFeedV1,
};

type MarketV1 = {
  id:                   string,
  deploymentKey:        string,
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
  contracts:        Record<ContractRoleKey, Address | null>,
  baseAsset:        BaseAssetV1,
  rewardAsset:      RewardAssetV1 | null,
  collateralAssets: CollateralAssetV1[],
};

type PriceExceptionV1 = (
  | {
      kind:               'zero_price',
      priceFeedAddress:   Address,
      provenance:         string,
      expiresAt:          string | null,
    }
  | {
      kind:               'fixed_price',
      priceFeedAddress:   Address,
      price:              { value: string, decimals: number },
      provenance:         string,
      expiresAt:          string | null,
    }
  | {
      kind:                 'deprecated_price_remap',
      priceFeedAddress:     Address,
      replacementPriceFeed: PriceFeedV1,
      provenance:           string,
      expiresAt:            string | null,
    }
);

type AssetDisplayOverrideV1 = {
  tokenAddress:   Address,
  displayAddress: Address,
  symbol:         string,
  name:           string,
};

type UnwrappedCollateralAssetV1 = {
  wrappedTokenAddress: Address,
  tokenAddress:        Address,
  symbol:              string,
  name:                string,
};

type NetworkPresentationV1 = {
  assetDisplayOverrides:     AssetDisplayOverrideV1[],
  unwrappedCollateralAssets: UnwrappedCollateralAssetV1[],
};

type NetworkV1 = {
  chainId:         number,
  key:             string,
  upstreamKey:     string,
  displayName:     string,
  testnet:         boolean,
  presentation:    NetworkPresentationV1,
  priceExceptions: PriceExceptionV1[],
  markets:         MarketV1[],
};

type RegistryVersionRefV1 = {
  id:               string,
  sourceRepository: string,
  sourceCommitSha:  string,
  checksum:         string,
};

type RegistrySnapshotV1 = {
  schemaVersion:   1,
  registryVersion: RegistryVersionRefV1,
  networks:        NetworkV1[],
};

export type {
  Address,
  AssetDisplayOverrideV1,
  AssetRole,
  BaseAssetV1,
  CollateralAssetV1,
  ContractRole,
  ContractRoleKey,
  DeploymentPath,
  ExceptionKind,
  MarketAssetRow,
  MarketContractRow,
  MarketRow,
  MarketStatus,
  MarketV1,
  NetworkPresentationV1,
  NetworkPriceExceptionRow,
  NetworkV1,
  ParsedRoot,
  PriceExceptionV1,
  PriceFeedV1,
  PriceQuote,
  RegistryNetworkRow,
  RegistrySnapshotV1,
  RegistryVersionRefV1,
  RegistryVersionRow,
  RewardAssetV1,
  SyncItemStatus,
  SyncOutcome,
  SyncRunItemRow,
  SyncRunRow,
  SyncRunStatus,
  SyncTriggerKind,
  TokenRow,
  TokenV1,
  UnwrappedCollateralAssetV1,
  ValidationResultRow,
  VersionStatus,
};

export {
  ASSET_ROLES,
  CONTRACT_ROLES,
  CONTRACT_ROLE_KEYS,
  EXCEPTION_KINDS,
  MARKET_STATUSES,
  PRICE_QUOTES,
  SYNC_ITEM_STATUSES,
  SYNC_OUTCOMES,
  SYNC_RUN_STATUSES,
  SYNC_TRIGGER_KINDS,
  VERSION_STATUSES,
  isAddress,
  isChecksum,
  isCommitSha,
  normalizeAddress,
};
