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

import { keccak256 } from '../hash.js';

import type { Comet, Contract, StandaloneContract } from '../well-known/contracts/types.js';

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

const ACTIVATION_ACTIONS = [ 'activate', 'rollback' ] as const;
const SYNC_TRIGGER_KINDS = [ 'scheduled', 'manual' ] as const;
const SYNC_RUN_STATUSES  = [ 'running', 'failed', 'completed' ] as const;
const SYNC_OUTCOMES      = [ 'imported', 'no_change' ] as const;
const SYNC_ITEM_STATUSES = [ 'pending', 'processing', 'completed', 'failed' ] as const;

/*
 * How the token list valued a token, and why it shows or hides it. `partial`
 * is a value read from only some of a token's positions that already reaches
 * the threshold (decision D7 of the TOK-0 audit).
 */
const COLLATERAL_VALUE_STATUSES = [ 'fresh', 'exception', 'partial', 'stale', 'unavailable' ] as const;
const VISIBILITY_REASONS        = [ 'strategic', 'collateral_threshold', 'below_threshold', 'data_unavailable' ] as const;

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

type ActivationAction = (typeof ACTIVATION_ACTIONS)[number];
type SyncTriggerKind  = (typeof SYNC_TRIGGER_KINDS)[number];
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

/*
 * The EIP-55 form of an address, which is how the API writes addresses out:
 * the case of each letter carries one bit of the keccak256 of the lowercase
 * address. Lookups keep comparing the lowercase form.
 */
function checksumAddress(value: Address | string): Address {
  const lower = value.toLowerCase().slice(2);
  const hash  = keccak256(lower);
  let checksummed = '0x';
  for (let index = 0; index < lower.length; index++) {
    checksummed += parseInt(hash[index]!, 16) >= 8 ? lower[index]!.toUpperCase() : lower[index]!;
  }
  return checksummed as Address;
}

function isCommitSha(value: unknown): value is string {
  return typeof(value) === 'string' && SHA1_PATTERN.test(value);
}

function isChecksum(value: unknown): value is string {
  return typeof(value) === 'string' && SHA256_PATTERN.test(value);
}

/*
 * How the registry names a market wherever it names one in text: the keys of
 * an overlay directory, the scopes of a version's changes, its checks and its
 * audit events, and what it lists as unreviewed. It is the chain id and the
 * deployment key joined by a slash, which a deployment key cannot hold — the
 * schema refuses one — so a name always reads back as the two it was made of.
 */
const MARKET_KEY_SEPARATOR = '/';

function marketKey(chainId: number, deploymentKey: string): string {
  return `${chainId}${MARKET_KEY_SEPARATOR}${deploymentKey}`;
}

/*
 * The two parts of a market's name, or null for text that is not one. The
 * chain id comes back as written: whether it is a chain id is for the caller
 * to decide, and to say in its own words.
 */
function parseMarketKey(key: string): { chainId: string, deploymentKey: string } | null {
  const separator = key.indexOf(MARKET_KEY_SEPARATOR);
  if (separator <= 0 || separator === key.length - 1) {
    return null;
  }
  return { chainId: key.slice(0, separator), deploymentKey: key.slice(separator + 1) };
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
 * explicitly nullable, matching the migrations.
 *
 * `reviewed` says whether someone made the decisions a network or market row
 * carries (0002). The column defaults to 1, which SQLite needs to add it to a
 * table that has rows, so a row inserted without it would claim a review
 * nobody made; the row types require it, and so every write states it.
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
  reviewed:             number,
};

type MarketRow = {
  id:                          string,
  registry_version_id:         string,
  network_id:                  string,
  deployment_key:              string,
  display_name:                string,
  slug:                        string | null,
  contract_name:               string | null,
  creation_block:              number,
  status:                      MarketStatus,
  is_default:                  number,
  is_institutional:            number,
  rewards_enabled:             number,
  account_rewards_enabled:     number,
  transaction_history_enabled: number,
  collateral_value_quote:      PriceQuote,
  reviewed:                    number,
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

type RegistryOverlayEventRow = {
  id:                  string,
  registry_version_id: string,
  scope_type:          'network' | 'market',
  scope_key:           string,
  previous_digest:     string | null,
  new_digest:          string,
  actor:               string,
  reason:              string,
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
  lease_expires_at:    string | null,
  expected_count:      number,
  completed_count:     number,
  failed_count:        number,
  last_error:          string | null,
  started_at:          string,
  completed_at:        string | null,
  hold_for_review:     number,
};

type SyncRunItemRow = {
  id:                   string,
  sync_run_id:          string,
  root_path:            string,
  source_blob_sha:      string,
  upstream_network_key: string,
  deployment_key:       string,
  status:               SyncItemStatus,
  attempts:             number,
  claim_owner:          string | null,
  claimed_at:           string | null,
  completed_at:         string | null,
  last_error:           string | null,
  created_at:           string,
  updated_at:           string,
};

/*
 * The tables the registry writes row by row, with the row each one takes, so
 * a write names its table and is checked against that table's columns.
 */
type RegistryTables = {
  registry_versions:        RegistryVersionRow,
  registry_networks:        RegistryNetworkRow,
  network_price_exceptions: NetworkPriceExceptionRow,
  markets:                  MarketRow,
  tokens:                   TokenRow,
  market_contracts:         MarketContractRow,
  market_assets:            MarketAssetRow,
  registry_overlay_events:  RegistryOverlayEventRow,
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
  /*
   * What the frontend addresses the market by where its label is shared with
   * another market of the same network; null where the label alone does.
   */
  slug:                 string | null,
  contractName:         string | null,
  isDefault:            boolean,
  // listed in the frontend's institutional section rather than with the standard markets
  isInstitutional:      boolean,
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

/*
 * How a response that resolved a version identifies it. It is deliberately
 * smaller than the snapshot's own reference: a convenience read states which
 * version answered, not where it came from.
 */
type VersionRefV1 = {
  id:       string,
  checksum: string,
};

type ActivationResultV1 = {
  action:            ActivationAction,
  activationId:      string | null,
  previousVersionId: string | null,
  targetVersionId:   string,
  changed:           boolean,
  registryVersion:   VersionRefV1,
};

type ValidationCheckV1 = {
  name:     string,
  scope:    string,
  passed:   boolean,
  details?: unknown,
};

type ValidationSummaryV1 = {
  attempt: number,
  passed:  number,
  failed:  number,
  checks:  ValidationCheckV1[],
};

/*
 * Token policies, from migrations/0004_token_policies.sql: the decisions an
 * administrator makes about a token, kept by chain id and address rather than
 * on a versioned row, so that they outlive every activation.
 */
type TokenPolicyRow = {
  chain_id:      number,
  token_address: Address,
  is_strategic:  number,
  updated_at:    string,
  updated_by:    string,
};

type TokenPolicyEventRow = {
  id:                    string,
  chain_id:              number,
  token_address:         Address,
  previous_is_strategic: number | null,
  is_strategic:          number,
  actor:                 string,
  reason:                string,
  created_at:            string,
};

/*
 * The decision in force for a token. A token nobody has decided about is not
 * strategic, and has no time or author to name.
 */
type TokenPolicyV1 = {
  isStrategic: boolean,
  updatedAt:   string | null,
  updatedBy:   string | null,
};

type TokenPolicyEventV1 = {
  id:                  string,
  // null where the token had no decision yet, which is not strategic
  previousIsStrategic: boolean | null,
  isStrategic:         boolean,
  actor:               string,
  reason:              string,
  createdAt:           string,
};

/*
 * Every token of one network of the active version, with the decision in
 * force for each, and the decisions kept for tokens of the chain the active
 * version does not hold: each applies again if a version brings its token back.
 * `inActiveVersion` is false for a chain the active version does not hold at
 * all, which has no tokens to list but may still have decisions kept.
 */
type TokenPoliciesV1 = {
  registryVersion: VersionRefV1,
  chainId:         number,
  inActiveVersion: boolean,
  tokens:          Array<TokenV1 & TokenPolicyV1>,
  retained:        Array<TokenPolicyV1 & { address: Address }>,
};

/*
 * One token's decision, and the changes that led to it, newest committed
 * first. `inActiveVersion` is false for a decision kept while the active
 * version does not hold the token, which applies again once one does.
 */
type TokenPolicyDetailV1 = TokenPolicyV1 & {
  registryVersion: VersionRefV1,
  chainId:         number,
  tokenAddress:    Address,
  inActiveVersion: boolean,
  events:          TokenPolicyEventV1[],
};

/*
 * The answer to a policy change. `changed` is false when the decision asked
 * for was already in force, which writes nothing; `updatedAt` is when the
 * decision in force was made, and null for a token nobody has decided about.
 */
type TokenPolicyResultV1 = {
  registryVersion: VersionRefV1,
  chainId:         number,
  tokenAddress:    Address,
  isStrategic:     boolean,
  changed:         boolean,
  updatedAt:       string | null,
};

/*
 * A list of decisions: what the export answers, and what review and apply
 * take, so a list is exported, edited and sent back as one file.
 *
 * A row that changes a decision needs a reason: its own, or the list's. A row
 * that leaves its token as it is needs none. `symbol` is there for the person
 * editing the file; the address decides, and a symbol that is not the token's
 * is refused as the mistake it usually is. `registryVersion` says where the
 * list was exported from, and is not checked: a decision belongs to no version.
 */
type TokenPolicyDecisionV1 = {
  chainId:      number,
  tokenAddress: Address,
  symbol?:      string | null,
  isStrategic:  boolean,
  reason?:      string | null,
};

type TokenPolicyListV1 = {
  registryVersion?: VersionRefV1,
  reason:           string | null,
  policies:         TokenPolicyDecisionV1[],
};

// what applying a list would change, row by row, without writing anything
type TokenPolicyReviewV1 = {
  registryVersion: VersionRefV1,
  summary:         { change: number, unchanged: number, problems: number },
  policies:        Array<{
    row:          number,
    chainId:      number,
    tokenAddress: Address,
    symbol:       string | null,
    current:      boolean,
    requested:    boolean,
    action:       'change' | 'unchanged',
    reason:       string | null,
    problem:      string | null,
  }>,
};

// what applying a list wrote: every row, as the transaction that wrote it left it
type TokenPolicyApplyV1 = {
  registryVersion: VersionRefV1,
  summary:         { changed: number, unchanged: number },
  policies:        Array<{
    row:          number,
    chainId:      number,
    tokenAddress: Address,
    symbol:       string,
    isStrategic:  boolean,
    changed:      boolean,
    updatedAt:    string | null,
  }>,
};

/*
 * The token list: every token the active version serves on one chain, with
 * its strategic decision, its collateral value in USD across the chain's
 * enabled markets, and whether discovery shows it.
 *
 * Values are decimal strings, never numbers: a value is exact, and a client
 * that compares or formats it must not lose a digit doing so. Each token says
 * when its value was read, which may be an earlier minute than the list's own
 * `block` when the latest could not be read.
 */
type CollateralValueStatusV1 = (typeof COLLATERAL_VALUE_STATUSES)[number];
type VisibilityReasonV1      = (typeof VISIBILITY_REASONS)[number];

type BlockRefV1 = { number: number, timestamp: number };

// a price exception the value applied: what the registry stated in place of reading a feed
type AppliedPriceExceptionV1 = {
  kind:             ExceptionKind,
  priceFeedAddress: Address,
  provenance:       string,
  expiresAt:        string | null,
};

type TokenVisibilityV1 = TokenV1 & {
  roles:                 AssetRole[],
  isStrategic:           boolean,
  collateralValueUsd:    string | null,
  collateralValueStatus: CollateralValueStatusV1,
  valueAt:               string | null,
  valueBlock:            BlockRefV1 | null,
  staleAgeSeconds:       number | null,
  exceptions:            AppliedPriceExceptionV1[],
  isVisible:             boolean,
  visibilityReason:      VisibilityReasonV1,
};

type TokenListV1 = {
  registryVersion: VersionRefV1,
  chainId:         number,
  thresholdUsd:    string,
  ruleVersion:     number,
  computedAt:      string,
  block:           BlockRefV1 | null,
  tokens:          TokenVisibilityV1[],
};

/*
 * What a Comet contract carries when it was materialized from the registry:
 * the version that described it, the market as that version describes it, and
 * the exceptions of its network.
 *
 * It travels on the contract object itself so that a computation which
 * already receives a contract needs no second parameter threaded through
 * every caller. `digest` identifies the market's content, and is what keeps
 * cached results of two different versions apart when, and only when, the
 * version changed something a computation can observe.
 */
type RegistryAnnotation = {
  versionId:       string,
  digest:          string,
  chainId:         number,
  deploymentKey:   string,
  market:          MarketV1,
  priceExceptions: PriceExceptionV1[],
};

// a Comet as the catalog materializes it: the contract shape, and the registry's description of it
type RegistryComet = Contract<StandaloneContract<Comet>> & { registry: RegistryAnnotation };

/*
 * The registry description behind a contract, or null for one that came from
 * the static constants, which governance still decodes proposals against.
 * This is the one place that tells the two apart.
 */
function registryOf(contract: unknown): RegistryAnnotation | null {
  const annotation = (contract as { registry?: unknown } | null)?.registry;
  return typeof(annotation) === 'object' && annotation !== null && 'digest' in annotation
    ? annotation as RegistryAnnotation
    : null;
}

/*
 * The registry description of a Comet a computation is handed. The routes
 * hand the computations only Comets the request's catalog materialized, so a
 * computation has one kind of market to read: one without a description is a
 * caller's mistake, refused as one rather than computed as if the registry
 * had said nothing about it.
 */
function annotationOf(contract: { address: string }): RegistryAnnotation {
  const annotation = registryOf(contract);
  if (annotation === null) {
    throw new Error(`invariant violated: ${contract.address} is not a Comet the registry materialized`);
  }
  return annotation;
}

export type {
  ActivationAction,
  ActivationResultV1,
  Address,
  AssetDisplayOverrideV1,
  AppliedPriceExceptionV1,
  AssetRole,
  BaseAssetV1,
  BlockRefV1,
  CollateralValueStatusV1,
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
  RegistryOverlayEventRow,
  RegistrySnapshotV1,
  RegistryTables,
  RegistryVersionRefV1,
  RegistryAnnotation,
  RegistryComet,
  RegistryVersionRow,
  RewardAssetV1,
  SyncItemStatus,
  SyncOutcome,
  SyncRunItemRow,
  SyncRunRow,
  SyncRunStatus,
  SyncTriggerKind,
  TokenPoliciesV1,
  TokenListV1,
  TokenPolicyApplyV1,
  TokenPolicyDecisionV1,
  TokenPolicyDetailV1,
  TokenPolicyEventRow,
  TokenPolicyEventV1,
  TokenPolicyListV1,
  TokenPolicyResultV1,
  TokenPolicyReviewV1,
  TokenPolicyRow,
  TokenPolicyV1,
  TokenRow,
  TokenV1,
  UnwrappedCollateralAssetV1,
  ValidationCheckV1,
  ValidationResultRow,
  ValidationSummaryV1,
  VersionRefV1,
  VersionStatus,
  VisibilityReasonV1,
  TokenVisibilityV1,
};

export {
  checksumAddress,
  ACTIVATION_ACTIONS,
  ASSET_ROLES,
  COLLATERAL_VALUE_STATUSES,
  VISIBILITY_REASONS,
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
  MARKET_KEY_SEPARATOR,
  marketKey,
  normalizeAddress,
  parseMarketKey,
  annotationOf,
  registryOf,
};
