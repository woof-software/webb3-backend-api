import {
  MarketV1,
  NetworkV1,
} from '../../lib/model/comet-registry.js';

import type { MarketEnrichment } from './enrichment.js';

/*
 * Candidate validation. Every invariant that cannot be expressed as a column
 * constraint is checked here, and every check is persisted: a candidate is
 * validated only when the latest attempt passes completely, and an invalid
 * candidate keeps its diagnostics for review.
 *
 * Checks are pure and operate on the assembled snapshot, so the same function
 * decides a scheduled import and answers an operator asking why a candidate
 * failed.
 */
type CheckResult = {
  check_name: string,
  scope:      string,
  passed:     number,
  details?:   Record<string, unknown>,
};

type CandidateInput = {
  networks: NetworkV1[],
  /*
   * What the run checkpointed, so a candidate assembled from an incomplete
   * import cannot validate. A root that exhausted its retries stops being
   * outstanding work, but the market it describes is still missing.
   */
  roots?: { expected: number, imported: number },
};

type MarketImportInput = {
  chainId:       number,
  deploymentKey: string,
  market:        MarketV1,
  enrichment:    MarketEnrichment,
};

function marketScope(network: NetworkV1, market: MarketV1): string {
  return `market:${network.chainId}/${market.deploymentKey}`;
}

function check(
  check_name: string,
  scope: string,
  passed: boolean,
  details?: Record<string, unknown>,
): CheckResult {
  return details === undefined || passed
    ? { check_name, scope, passed: passed ? 1 : 0 }
    : { check_name, scope, passed: 0, details };
}

/*
 * The checks that need what the chain just said. They run while a market is
 * being imported, because afterwards only the stored rows remain, and
 * comparing those with themselves would assure nothing.
 */
function validateMarketImport({ chainId, deploymentKey, market, enrichment }: MarketImportInput): CheckResult[] {
  const scope = `market:${chainId}/${deploymentKey}`;
  return [
    /*
     * A market the registry cannot fully read is not a market it can serve,
     * so a declared contract without bytecode fails the import rather than
     * silently dropping the role.
     */
    check(
      'market-contracts-deployed',
      scope,
      enrichment.missingContracts.length === 0,
      { missingContracts: enrichment.missingContracts },
    ),
    // the reward token is the one the rewards contract names, not a reviewed one
    check(
      'reward-token-matches-chain',
      scope,
      (market.rewardAsset?.token.address ?? null) === (enrichment.rewardToken?.address ?? null),
      { market: market.rewardAsset?.token.address ?? null, chain: enrichment.rewardToken?.address ?? null },
    ),
    check(
      'base-asset-matches-chain',
      scope,
      market.baseAsset.token.address === enrichment.baseToken.address
        && market.baseAsset.priceFeed.address === enrichment.basePriceFeed.address,
      { market: market.baseAsset.token.address, chain: enrichment.baseToken.address },
    ),
  ];
}

/*
 * The names of those checks. A candidate is validated against its stored rows
 * long after the chain answered, so what the chain said is carried forward
 * from the attempt that heard it rather than dropped.
 */
const IMPORT_CHECKS = [
  'market-contracts-deployed',
  'reward-token-matches-chain',
  'base-asset-matches-chain',
] as const;

function validateMarket(network: NetworkV1, market: MarketV1): CheckResult[] {
  const scope   = marketScope(network, market);
  const results: CheckResult[] = [];

  /*
   * collateralValueQuote states the unit the on-chain feeds answer in. A
   * base-quoted market needs the reviewed feed that converts that unit to
   * USD, and a USD-quoted market must not carry one.
   */
  const quotedInBase = market.collateralValueQuote === 'base';
  results.push(check(
    'base-usd-feed-matches-quote',
    scope,
    quotedInBase === (market.baseAsset.usdPriceFeed !== null),
    { collateralValueQuote: market.collateralValueQuote, usdPriceFeed: market.baseAsset.usdPriceFeed },
  ));

  const reward = market.rewardAsset;
  results.push(check(
    'reward-feed-paired',
    scope,
    reward === null || (reward.priceFeed === null) === (reward.priceFeedQuote === null),
    { priceFeed: reward?.priceFeed ?? null, priceFeedQuote: reward?.priceFeedQuote ?? null },
  ));
  // a reward feed denominated in the market's quote unit only makes sense
  // where that unit is not USD, as with mainnet COMP/ETH
  results.push(check(
    'reward-feed-quote-supported',
    scope,
    reward === null || reward.priceFeedQuote !== 'base' || quotedInBase,
    { priceFeedQuote: reward?.priceFeedQuote ?? null, collateralValueQuote: market.collateralValueQuote },
  ));
  /*
   * Transaction history is read from one range of logs covering a market and
   * the rewards contract its claims are emitted by, so a market whose history
   * is served must name that contract. Without it the market would be
   * addressable and answer an empty page, which is indistinguishable from a
   * market nobody has used. The capability is a reviewed decision, made after
   * the import, so this is checked over the stored rows.
   */
  results.push(check(
    'transaction-history-requires-rewards-contract',
    scope,
    !market.capabilities.transactionHistory || market.contracts.rewards !== null,
    { transactionHistory: market.capabilities.transactionHistory, rewards: market.contracts.rewards },
  ));

  // rewards cannot be priced without a feed, so the capability must be off
  results.push(check(
    'rewards-capability-has-feed',
    scope,
    !market.capabilities.rewards || (reward !== null && reward.priceFeed !== null),
    { rewards: market.capabilities.rewards, priceFeed: reward?.priceFeed ?? null },
  ));

  const indices = market.collateralAssets.map(asset => asset.assetIndex);
  results.push(check(
    'collateral-indices-contiguous',
    scope,
    indices.every((index, position) => index === position),
    { assetIndices: indices },
  ));
  const collateralAddresses = market.collateralAssets.map(asset => asset.token.address);
  results.push(check(
    'collateral-assets-distinct',
    scope,
    new Set(collateralAddresses).size === collateralAddresses.length,
    { collateralAssets: collateralAddresses },
  ));
  results.push(check(
    'collateral-excludes-base-asset',
    scope,
    !collateralAddresses.includes(market.baseAsset.token.address),
    { baseAsset: market.baseAsset.token.address },
  ));

  /*
   * History and indexes start from the creation block, so a market the API
   * serves must state it. One that is disabled is not served; a market
   * nobody has reviewed is disabled and does not know it yet.
   */
  results.push(check(
    'creation-block-known',
    scope,
    market.status === 'disabled' || market.creationBlock > 0,
    { creationBlock: market.creationBlock, status: market.status },
  ));
  results.push(check(
    'comet-contract-declared',
    scope,
    market.contracts.comet !== null,
  ));
  // a deprecated or disabled market stays in the snapshot, but cannot be the
  // one the frontend opens by default
  results.push(check(
    'default-market-is-enabled',
    scope,
    !market.isDefault || market.status === 'enabled',
    { isDefault: market.isDefault, status: market.status },
  ));

  return results;
}

function validateNetwork(network: NetworkV1): CheckResult[] {
  const scope   = `network:${network.chainId}`;
  const results: CheckResult[] = [];

  results.push(check('network-has-markets', scope, network.markets.length > 0));

  const deploymentKeys = network.markets.map(market => market.deploymentKey);
  results.push(check(
    'deployment-keys-unique',
    scope,
    new Set(deploymentKeys).size === deploymentKeys.length,
    { deploymentKeys },
  ));

  const comets = network.markets.map(market => market.contracts.comet);
  results.push(check(
    'comet-addresses-unique',
    scope,
    new Set(comets).size === comets.length,
    { comets },
  ));

  /*
   * The frontend addresses a market of a network by its slug, or by its label
   * where it has none, so no two markets it lists may answer to the same one:
   * the second would be unreachable, and a link to it would open the first.
   * Two markets may share a label only if a slug tells them apart. A disabled
   * market is not listed, so it takes no key.
   */
  const listingKeys = network.markets
    .filter(market => market.status !== 'disabled')
    .map(market => (market.slug ?? market.displayName).toLowerCase());
  results.push(check(
    'market-listing-keys-unique',
    scope,
    new Set(listingKeys).size === listingKeys.length,
    { listingKeys: listingKeys.filter((key, index) => listingKeys.indexOf(key) !== index) },
  ));

  /*
   * A remap must name a feed that answers, which enrichment proves by having
   * read its decimals. The placeholder decimals of an unresolved remap are
   * negative.
   */
  const unreadable = network.priceExceptions.filter(
    exception => exception.kind === 'deprecated_price_remap' && exception.replacementPriceFeed.decimals < 0
  );
  results.push(check(
    'price-exception-feeds-readable',
    scope,
    unreadable.length === 0,
    { unreadable: unreadable.map(exception => exception.priceFeedAddress) },
  ));

  // markets are served in this order, so the snapshot must already be sorted
  const ordered = [ ...network.markets ].sort((left, right) => (
    left.creationBlock - right.creationBlock
      || (left.deploymentKey < right.deploymentKey ? -1 : left.deploymentKey > right.deploymentKey ? 1 : 0)
  ));
  results.push(check(
    'markets-ordered',
    scope,
    ordered.every((market, index) => market.deploymentKey === network.markets[index]?.deploymentKey),
  ));

  return results;
}

/*
 * Every check of one candidate. The caller persists the results and uses
 * hasFailures to decide between validated and invalid.
 */
function validateCandidate({ networks, roots }: CandidateInput): CheckResult[] {
  const results: CheckResult[] = [];

  results.push(check('networks-present', 'global', networks.length > 0));

  if (roots !== undefined) {
    // every root the run discovered must have produced a market
    results.push(check(
      'all-roots-imported',
      'global',
      roots.imported === roots.expected,
      { expected: roots.expected, imported: roots.imported },
    ));
  }

  const chainIds = networks.map(network => network.chainId);
  results.push(check(
    'networks-unique',
    'global',
    new Set(chainIds).size === chainIds.length,
    { chainIds },
  ));
  results.push(check(
    'networks-ordered',
    'global',
    chainIds.every((chainId, index) => index === 0 || chainId > chainIds[index - 1]!),
    { chainIds },
  ));

  const defaults = networks.flatMap(network => network.markets
    .filter(market => market.isDefault)
    .map(market => `${network.chainId}/${market.deploymentKey}`));
  // exactly one market opens by default across the whole registry
  results.push(check('single-default-market', 'global', defaults.length === 1, { defaults }));

  for (const network of networks) {
    results.push(...validateNetwork(network));
    for (const market of network.markets) {
      results.push(...validateMarket(network, market));
    }
  }

  return results;
}

function hasFailures(results: CheckResult[]): boolean {
  return results.some(result => result.passed === 0);
}

function failures(results: CheckResult[]): CheckResult[] {
  return results.filter(result => result.passed === 0);
}

export type { CandidateInput, CheckResult, MarketImportInput };

export {
  IMPORT_CHECKS,
  failures,
  hasFailures,
  validateCandidate,
  validateMarketImport,
};
