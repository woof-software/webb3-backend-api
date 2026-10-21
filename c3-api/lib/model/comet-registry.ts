/*
 * Types shared by the Comet registry: the records parsed from the pinned
 * Comet source, the RegistrySnapshotV1 wire contract frozen in
 * tests/fixtures/registry/registry-snapshot-v1.json and the other answers of
 * the registry routes, and the Comet a computation takes. The rows of the
 * APP_DB tables are in src/registry/rows.ts, beside the only modules that
 * read them.
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
const CONTRACT_ROLES  = [ 'comet', 'configurator', 'rewards', 'bulker', 'fauceteer', 'bridge_receiver' ] as const;
const ASSET_ROLES     = [ 'base', 'reward', 'collateral' ] as const;
const PRICE_QUOTES    = [ 'usd', 'base' ] as const;
const MARKET_STATUSES = [ 'enabled', 'deprecated', 'disabled' ] as const;
const EXCEPTION_KINDS = [ 'zero_price', 'fixed_price', 'deprecated_price_remap' ] as const;

const ACTIVATION_ACTIONS = [ 'activate', 'rollback' ] as const;

/*
 * How the token list valued a token, and why it shows or hides it. `partial`
 * is a value read from only some of a token's positions that already reaches
 * the threshold (decision D7 of the TOK-0 audit). `deprecated` hides a token
 * deprecated in every enabled market that takes it, whatever else holds.
 */
const COLLATERAL_VALUE_STATUSES = [ 'fresh', 'exception', 'partial', 'stale', 'unavailable' ] as const;
const VISIBILITY_REASONS        = [ 'deprecated', 'strategic', 'collateral_threshold', 'below_threshold', 'data_unavailable' ] as const;

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
type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

type ActivationAction = (typeof ACTIVATION_ACTIONS)[number];

/*
 * Anchored address validation. Accepts any casing, because upstream roots
 * are checksummed, and normalizeAddress lowercases for storage.
 */
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const SHA1_PATTERN    = /^[0-9a-f]{40}$/;

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
 * A market the API serves: one that is not disabled, with its Comet, which
 * is what it is addressed and keyed by (isServed, src/registry/catalog.ts).
 * Validation refuses a market that does not declare its Comet
 * (comet-contract-declared), so of a validated version only the disabled
 * markets are left out. A network the API serves lists only the markets it
 * serves.
 */
type ServedMarket  = MarketV1 & { contracts: MarketV1['contracts'] & { comet: Address } };
type ServedNetwork = Omit<NetworkV1, 'markets'> & { markets: ServedMarket[] };

/*
 * The active version as the active reads serve it — /active and the market
 * reads — beside RegistrySnapshotV1, which stays the version as imported:
 * every collateral also says whether an administrator marked it deprecated in
 * its Comet (migrations/0007_deprecated_collaterals.sql). The flag is a
 * decision about the market, not part of the version, so it takes no part in
 * the version's checksum and is read anew for every answer.
 */
type ActiveCollateralAssetV1 = CollateralAssetV1 & { isDeprecated: boolean };
type ActiveMarketV1          = Omit<ServedMarket, 'collateralAssets'> & { collateralAssets: ActiveCollateralAssetV1[] };
type ActiveNetworkV1         = Omit<NetworkV1, 'markets'> & { markets: ActiveMarketV1[] };
type ActiveSnapshotV1        = Omit<RegistrySnapshotV1, 'networks'> & { networks: ActiveNetworkV1[] };

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

/*
 * One switch of the active version, as the history of a version lists it. It
 * names both versions as the activate answer does, so the version to go back
 * to is read from either under the same name.
 */
type ActivationRecordV1 = {
  id:                string,
  action:            ActivationAction,
  previousVersionId: string | null,
  targetVersionId:   string,
  actor:             string,
  reason:            string,
  createdAt:         string,
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
 * The decision in force for a collateral of a Comet. A collateral nobody has
 * decided about is not deprecated, and has no time or author to name.
 */
type DeprecatedCollateralV1 = {
  isDeprecated: boolean,
  updatedAt:    string | null,
  updatedBy:    string | null,
};

type DeprecatedCollateralEventV1 = {
  id:                   string,
  // null where the collateral had no decision yet, which is not deprecated
  previousIsDeprecated: boolean | null,
  isDeprecated:         boolean,
  actor:                string,
  reason:               string,
  createdAt:            string,
};

/*
 * One collateral's decision, and the changes that led to it, newest committed
 * first. `inActiveVersion` is false for a decision kept while the active
 * version does not hold the collateral in that Comet, which applies again once
 * one does.
 */
type DeprecatedCollateralDetailV1 = DeprecatedCollateralV1 & {
  registryVersion: VersionRefV1,
  chainId:         number,
  cometAddress:    Address,
  tokenAddress:    Address,
  inActiveVersion: boolean,
  events:          DeprecatedCollateralEventV1[],
};

/*
 * The answer to a decision about one collateral. `changed` is false when the
 * decision asked for was already in force, which writes nothing; `updatedAt`
 * is when the decision in force was made, and null where nobody has decided.
 */
type DeprecatedCollateralResultV1 = {
  registryVersion: VersionRefV1,
  chainId:         number,
  cometAddress:    Address,
  tokenAddress:    Address,
  isDeprecated:    boolean,
  changed:         boolean,
  updatedAt:       string | null,
};

/*
 * A list of decisions about collaterals: what the export answers, and what
 * review and apply take, so a list is exported, edited and sent back as one
 * file, as a list of token policies is.
 *
 * A row that changes a decision needs a reason: its own, or the list's.
 * `deploymentKey` and `symbol` are there for the person editing the file; the
 * addresses decide, and a market or a symbol that is not the one the active
 * version names is refused as the mistake it usually is. `registryVersion`
 * and `retained` say where the list was exported from and which decisions
 * the active version does not hold, and are not read.
 */
type DeprecatedCollateralDecisionV1 = {
  chainId:        number,
  cometAddress:   Address,
  deploymentKey?: string | null,
  tokenAddress:   Address,
  symbol?:        string | null,
  isDeprecated:   boolean,
  reason?:        string | null,
};

// a decision kept for a collateral the active version does not hold in that Comet
type RetainedDeprecatedCollateralV1 = DeprecatedCollateralV1 & {
  chainId:      number,
  cometAddress: Address,
  tokenAddress: Address,
};

type DeprecatedCollateralListV1 = {
  registryVersion?: VersionRefV1,
  reason:           string | null,
  collaterals:      DeprecatedCollateralDecisionV1[],
  retained?:        RetainedDeprecatedCollateralV1[],
};

// what applying a list would change, row by row, without writing anything
type DeprecatedCollateralReviewV1 = {
  registryVersion: VersionRefV1,
  summary:         { change: number, unchanged: number, problems: number },
  collaterals:     Array<{
    row:           number,
    chainId:       number,
    cometAddress:  Address,
    deploymentKey: string | null,
    tokenAddress:  Address,
    symbol:        string | null,
    current:       boolean,
    requested:     boolean,
    action:        'change' | 'unchanged',
    reason:        string | null,
    problem:       string | null,
  }>,
};

// what applying a list wrote: every row, as the transaction that wrote it left it
type DeprecatedCollateralApplyV1 = {
  registryVersion: VersionRefV1,
  summary:         { changed: number, unchanged: number },
  collaterals:     Array<{
    row:           number,
    chainId:       number,
    cometAddress:  Address,
    deploymentKey: string,
    tokenAddress:  Address,
    symbol:        string,
    isDeprecated:  boolean,
    changed:       boolean,
    updatedAt:     string | null,
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

/*
 * `deprecatedIn` names the Comets of the chain's served markets that take the
 * token as a collateral an administrator marked deprecated, sorted.
 * `isDeprecated` says it is deprecated in every enabled market that takes it,
 * of which there is at least one, and then discovery does not show it,
 * whatever else holds. A token deprecated in some of them only is shown or
 * hidden by the rest of the rule.
 */
type TokenVisibilityV1 = TokenV1 & {
  roles:                 AssetRole[],
  isStrategic:           boolean,
  isDeprecated:          boolean,
  deprecatedIn:          Address[],
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

/*
 * A Comet as the catalog materializes it: the contract shape, and the
 * registry's description of it.
 *
 * It is the only kind of market a computation takes. The routes resolve every
 * market through the request's catalog, so a computation reads one kind of
 * Comet, and the compiler refuses it a Comet of the static constants, the
 * ones governance still decodes proposals against: those describe none of
 * what a computation reads here. The refusal rests on the constants typing
 * their Comets (WellKnownContractsByNetworkAddress); a cast, or a read the
 * compiler cannot type, is not refused.
 */
type RegistryComet = Contract<StandaloneContract<Comet>> & { registry: RegistryAnnotation };

export type {
  ActivationAction,
  ActivationRecordV1,
  ActivationResultV1,
  ActiveCollateralAssetV1,
  ActiveMarketV1,
  ActiveNetworkV1,
  ActiveSnapshotV1,
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
  DeprecatedCollateralApplyV1,
  DeprecatedCollateralDecisionV1,
  DeprecatedCollateralDetailV1,
  DeprecatedCollateralEventV1,
  DeprecatedCollateralListV1,
  DeprecatedCollateralResultV1,
  DeprecatedCollateralReviewV1,
  DeprecatedCollateralV1,
  ExceptionKind,
  MarketStatus,
  MarketV1,
  NetworkPresentationV1,
  NetworkV1,
  ParsedRoot,
  PriceExceptionV1,
  PriceFeedV1,
  PriceQuote,
  RegistrySnapshotV1,
  RegistryVersionRefV1,
  RegistryAnnotation,
  RegistryComet,
  RetainedDeprecatedCollateralV1,
  RewardAssetV1,
  ServedMarket,
  ServedNetwork,
  TokenPoliciesV1,
  TokenListV1,
  TokenPolicyApplyV1,
  TokenPolicyDecisionV1,
  TokenPolicyDetailV1,
  TokenPolicyEventV1,
  TokenPolicyListV1,
  TokenPolicyResultV1,
  TokenPolicyReviewV1,
  TokenPolicyV1,
  TokenV1,
  UnwrappedCollateralAssetV1,
  ValidationCheckV1,
  ValidationSummaryV1,
  VersionRefV1,
  VisibilityReasonV1,
  TokenVisibilityV1,
};

export {
  checksumAddress,
  ASSET_ROLES,
  COLLATERAL_VALUE_STATUSES,
  VISIBILITY_REASONS,
  CONTRACT_ROLES,
  CONTRACT_ROLE_KEYS,
  EXCEPTION_KINDS,
  MARKET_STATUSES,
  PRICE_QUOTES,
  isAddress,
  isCommitSha,
  MARKET_KEY_SEPARATOR,
  marketKey,
  normalizeAddress,
  parseMarketKey,
};
