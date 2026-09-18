import { Interface } from '@ethersproject/abi';

import * as Eth      from '../../lib/eth-constants.js';
import * as Fallible from '../../lib/fallible/fallible.js';
import * as jsonRpc  from '../../lib/json-rpc.js';

import type * as KnownNetwork from '../../lib/well-known/networks/network.js';

import {
  Address,
  CONTRACT_ROLES,
  ContractRole,
  ParsedRoot,
  PriceFeedV1,
  TokenV1,
  isAddress,
  normalizeAddress,
} from '../../lib/model/comet-registry.js';

import { RegistryError } from './errors.js';

/*
 * Reads the on-chain facts a registry candidate cannot take from the pinned
 * source: what a Comet says its base asset, price feeds, collateral assets,
 * and reward token are, and the ERC-20 and feed metadata behind them.
 *
 * Reads go through the same node provider proxy as route traffic, batched and
 * bounded. Nothing here decides policy: display names, capabilities, quotes,
 * and reviewed feeds come from the overlay, and validation compares the two.
 */
type ChainEndpoint = {
  apiHost:  string,
  nodeHost: string,
  nodeKey:  string,
  network:  KnownNetwork.Name,
  /*
   * The fetch to reach the node provider with. It is passed in rather than
   * taken from the module-global counting fetch, whose configuration is
   * shared with the request handler and would be reset underneath a
   * long-running import.
   */
  fetch:    (input: Request) => Promise<Response>,
};

/*
 * One batch of JSON-RPC calls, answered in request order. The sync service
 * passes the proxy transport; tests pass their own.
 */
type RpcTransport = (calls: jsonRpc.Call[]) => Promise<Array<{ result?: unknown, error?: unknown }>>;

type MarketEnrichment = {
  baseToken:        TokenV1,
  basePriceFeed:    PriceFeedV1,
  rewardToken:      TokenV1 | null,
  collateralAssets: Array<{ assetIndex: number, token: TokenV1, priceFeed: PriceFeedV1 }>,
  // roles whose declared address has no bytecode on this chain
  missingContracts: ContractRole[],
};

// a Comet holds at most 15 collateral assets today; the bound rejects a
// nonsensical numAssets rather than issuing thousands of calls
const MAX_COLLATERAL_ASSETS = 32;
const MAX_CALLS_PER_BATCH   = 100;

const COMET = new Interface([
  'function baseToken() view returns (address)',
  'function baseTokenPriceFeed() view returns (address)',
  'function numAssets() view returns (uint8)',
  `function getAssetInfo(uint8) view returns (tuple(
    uint8 offset,
    address asset,
    address priceFeed,
    uint64 scale,
    uint64 borrowCollateralFactor,
    uint64 liquidateCollateralFactor,
    uint64 liquidationFactor,
    uint128 supplyCap
  ))`,
]);

const REWARDS = new Interface([
  'function rewardConfig(address) view returns (address token, uint64 rescaleFactor, bool shouldUpscale)',
]);

const ERC20 = new Interface([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);

const ERC20_BYTES32 = new Interface([
  'function symbol() view returns (bytes32)',
  'function name() view returns (bytes32)',
]);

const PRICE_FEED = new Interface([
  'function decimals() view returns (uint8)',
]);

function call(to: Address, data: string): jsonRpc.Call {
  return { method: 'eth_call', params: [ { to, data }, 'latest' ] };
}

/*
 * Sends one batch of calls through the node provider proxy, the same path
 * route traffic takes.
 */
function proxyTransport(endpoint: ChainEndpoint): RpcTransport {
  return async calls => {
    const responses = await jsonRpc.postBatch({
      calls,
      endpoint: Eth.nodeEndpoint(endpoint.nodeHost, endpoint.nodeKey, endpoint.network),
      headers:  { origin: endpoint.apiHost },
      fetch:    endpoint.fetch,
    });
    if (Fallible.isFailure(responses)) {
      throw new RegistryError('CHAIN_REQUEST_FAILED', `the node provider did not answer`, endpoint.network);
    }
    return responses as Array<{ result?: unknown, error?: unknown }>;
  };
}

/*
 * Runs calls in bounded batches and returns their raw results in order. A
 * call that reverts or answers with anything but hex data fails the import:
 * a market the registry cannot read is not a market it can serve.
 */
async function callAll(transport: RpcTransport, calls: jsonRpc.Call[], scope: string): Promise<string[]> {
  const results: string[] = [];
  for (let index = 0; index < calls.length; index += MAX_CALLS_PER_BATCH) {
    const chunk = calls.slice(index, index + MAX_CALLS_PER_BATCH);
    let responses: Array<{ result?: unknown, error?: unknown }>;
    try {
      responses = await transport(chunk);
    } catch (error) {
      if (error instanceof RegistryError) {
        throw error;
      }
      throw new RegistryError('CHAIN_REQUEST_FAILED', `a node provider request failed`, scope);
    }
    if (responses.length !== chunk.length) {
      throw new RegistryError('CHAIN_RESPONSE_INVALID', `the node provider answered ${responses.length} of ${chunk.length} calls`, scope);
    }
    for (const response of responses) {
      if (response.error !== undefined && response.error !== null) {
        throw new RegistryError('CHAIN_CALL_REVERTED', `an on-chain read failed`, scope);
      }
      if (typeof(response.result) !== 'string' || !response.result.startsWith('0x')) {
        throw new RegistryError('CHAIN_RESPONSE_INVALID', `an on-chain read returned no data`, scope);
      }
      results.push(response.result);
    }
  }
  return results;
}

function decodeAddress(data: string, scope: string): Address {
  const [ value ] = COMET.decodeFunctionResult('baseToken', data);
  if (!isAddress(value)) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `expected an address`, scope);
  }
  return normalizeAddress(value);
}

function decodeDecimals(data: string, scope: string): number {
  const [ value ] = PRICE_FEED.decodeFunctionResult('decimals', data);
  const decimals  = Number(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `expected decimals between 0 and 255`, scope);
  }
  return decimals;
}

/*
 * ERC-20 metadata predates the string return type, so a token such as MKR
 * answers with a padded bytes32 instead. Both spellings are accepted.
 */
function decodeText(method: 'symbol' | 'name', data: string, scope: string): string {
  let text: string;
  try {
    [ text ] = ERC20.decodeFunctionResult(method, data);
  } catch {
    try {
      const [ bytes ] = ERC20_BYTES32.decodeFunctionResult(method, data);
      text = new TextDecoder().decode(
        Uint8Array.from((bytes as string).slice(2).match(/../g) ?? [], byte => parseInt(byte, 16))
      ).replace(/\0+$/, '');
    } catch {
      throw new RegistryError('CHAIN_RESPONSE_INVALID', `${method} is neither a string nor bytes32`, scope);
    }
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `${method} is empty`, scope);
  }
  return trimmed;
}

/*
 * Confirms the endpoint really serves the chain the registry maps this
 * network to, so a misrouted proxy cannot import one chain's markets as
 * another's.
 */
async function assertChainId(transport: RpcTransport, expected: number, scope: string): Promise<void> {
  const [ result ] = await callAll(transport, [ { method: 'eth_chainId', params: [] } ], scope);
  const chainId = Number.parseInt(result!, 16);
  if (!Number.isInteger(chainId)) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `the node provider returned a malformed chain id`, scope);
  }
  if (chainId !== expected) {
    throw new RegistryError(
      'CHAIN_MISMATCH',
      `the node provider serves chain ${chainId}, not ${expected}`,
      scope,
    );
  }
}

async function readTokens(
  transport: RpcTransport,
  addresses: Address[],
  scope: string,
): Promise<Map<Address, TokenV1>> {
  const calls = addresses.flatMap(address => [
    call(address, ERC20.encodeFunctionData('symbol')),
    call(address, ERC20.encodeFunctionData('name')),
    call(address, ERC20.encodeFunctionData('decimals')),
  ]);
  const results = await callAll(transport, calls, scope);

  const tokens = new Map<Address, TokenV1>();
  addresses.forEach((address, index) => {
    const [ symbol, name, decimals ] = results.slice(index * 3, index * 3 + 3) as [ string, string, string ];
    tokens.set(address, {
      address,
      symbol:   decodeText('symbol', symbol, address),
      name:     decodeText('name', name, address),
      decimals: decodeDecimals(decimals, address),
    });
  });
  return tokens;
}

async function readFeeds(
  transport: RpcTransport,
  addresses: Address[],
  scope: string,
): Promise<Map<Address, PriceFeedV1>> {
  const results = await callAll(
    transport,
    addresses.map(address => call(address, PRICE_FEED.encodeFunctionData('decimals'))),
    scope,
  );
  const feeds = new Map<Address, PriceFeedV1>();
  addresses.forEach((address, index) => {
    feeds.set(address, { address, decimals: decodeDecimals(results[index]!, address) });
  });
  return feeds;
}

/*
 * Reads one market. The Comet itself is authoritative for base asset, feeds,
 * and collateral assets; the rewards contract names the reward token.
 */
async function enrichMarket(transport: RpcTransport, root: ParsedRoot): Promise<MarketEnrichment> {
  const scope = root.rootPath;
  const comet = root.contracts.comet!;

  await assertChainId(transport, root.chainId, scope);

  const declared = CONTRACT_ROLES
    .map(role => ({ role, address: root.contracts[role] }))
    .filter((entry): entry is { role: ContractRole, address: Address } => entry.address !== undefined);
  const codes = await callAll(
    transport,
    declared.map(({ address }) => ({ method: 'eth_getCode', params: [ address, 'latest' ] })),
    scope,
  );
  const missingContracts = declared
    .filter((_, index) => codes[index] === '0x')
    .map(({ role }) => role);
  if (missingContracts.includes('comet')) {
    throw new RegistryError('CHAIN_CONTRACT_MISSING', `${comet} has no bytecode on chain ${root.chainId}`, scope);
  }

  const [ baseTokenData, basePriceFeedData, numAssetsData ] = await callAll(transport, [
    call(comet, COMET.encodeFunctionData('baseToken')),
    call(comet, COMET.encodeFunctionData('baseTokenPriceFeed')),
    call(comet, COMET.encodeFunctionData('numAssets')),
  ], scope) as [ string, string, string ];

  const baseTokenAddress = decodeAddress(baseTokenData, scope);
  const basePriceFeed    = decodeAddress(basePriceFeedData, scope);
  const numAssets        = decodeDecimals(numAssetsData, scope);
  if (numAssets > MAX_COLLATERAL_ASSETS) {
    throw new RegistryError('CHAIN_RESPONSE_INVALID', `${comet} reports ${numAssets} collateral assets`, scope);
  }

  const assetData = await callAll(
    transport,
    [ ...Array(numAssets).keys() ].map(index => call(comet, COMET.encodeFunctionData('getAssetInfo', [ index ]))),
    scope,
  );
  const collateral = assetData.map((data, assetIndex) => {
    const [ info ] = COMET.decodeFunctionResult('getAssetInfo', data);
    if (!isAddress(info.asset) || !isAddress(info.priceFeed)) {
      throw new RegistryError('CHAIN_RESPONSE_INVALID', `asset ${assetIndex} has a malformed address`, scope);
    }
    return {
      assetIndex,
      token:     normalizeAddress(info.asset),
      priceFeed: normalizeAddress(info.priceFeed),
    };
  });

  const rewardsContract = root.contracts.rewards;
  let rewardTokenAddress: Address | null = null;
  if (rewardsContract !== undefined && !missingContracts.includes('rewards')) {
    const [ configData ] = await callAll(
      transport,
      [ call(rewardsContract, REWARDS.encodeFunctionData('rewardConfig', [ comet ])) ],
      scope,
    ) as [ string ];
    const config = REWARDS.decodeFunctionResult('rewardConfig', configData);
    const token  = config.token;
    // a market with no configured reward token answers with the zero address
    if (isAddress(token) && normalizeAddress(token) !== Eth.NullAddress.toLowerCase()) {
      rewardTokenAddress = normalizeAddress(token);
    }
  }

  const tokenAddresses = [ ...new Set<Address>([
    baseTokenAddress,
    ...collateral.map(asset => asset.token),
    ...(rewardTokenAddress === null ? [] : [ rewardTokenAddress ]),
  ]) ];
  const feedAddresses = [ ...new Set<Address>([
    basePriceFeed,
    ...collateral.map(asset => asset.priceFeed),
  ]) ];

  /*
   * Both reads are issued together, but a rejection must not be left
   * unobserved: when the node provider is unreachable both reject, and
   * Promise.all would drop the second rejection as an unhandled one, which a
   * Worker reports as an uncaught error and retries the whole event over.
   */
  const [ tokenResult, feedResult ] = await Promise.allSettled([
    readTokens(transport, tokenAddresses, scope),
    readFeeds(transport, feedAddresses, scope),
  ]);
  if (tokenResult.status === 'rejected') {
    throw tokenResult.reason;
  }
  if (feedResult.status === 'rejected') {
    throw feedResult.reason;
  }
  const tokens = tokenResult.value;
  const feeds  = feedResult.value;

  return {
    baseToken:     tokens.get(baseTokenAddress)!,
    basePriceFeed: feeds.get(basePriceFeed)!,
    rewardToken:   rewardTokenAddress === null ? null : tokens.get(rewardTokenAddress)!,
    collateralAssets: collateral.map(asset => ({
      assetIndex: asset.assetIndex,
      token:      tokens.get(asset.token)!,
      priceFeed:  feeds.get(asset.priceFeed)!,
    })),
    missingContracts,
  };
}

export type { ChainEndpoint, MarketEnrichment, RpcTransport };

export {
  MAX_CALLS_PER_BATCH,
  MAX_COLLATERAL_ASSETS,
  enrichMarket,
  proxyTransport,
  readFeeds,
  readTokens,
};
