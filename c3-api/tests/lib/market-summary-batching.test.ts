import t from 'tap';

import { Interface, type FunctionFragment } from '@ethersproject/abi';
import { BigNumber as EthersBigNumber } from '@ethersproject/bignumber';

import * as Debug    from '../../lib/debug-log.js';
import * as Flags    from '../../lib/flags.js';
import { BigNumber } from '../../lib/bignumber.js';
import { BigFixnum } from '../../lib/bigfixnum.js';

import * as Evaluator  from '../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../lib/symbolic/cache.js';

import * as evm    from '../../lib/computations/evm.js';
import * as comet  from '../../lib/computations/comet.js';
import * as market from '../../lib/computations/market.js';

import * as marketHandlers from '../../src/market.js';
import {
  AllContracts,
  AllNetworks,
  type UninstantiatedContext,
} from '../../src/router.js';

import { fixtureCatalog, loadRegistrySnapshotFixture } from '../util/registry-fixture.js';

import '../../shim/node-self.js';

/*
 * The summary of every market, on the real evaluator against a fake node,
 * counting what reaches the node. Each request to the node provider proxy is
 * a subrequest, of which a Worker invocation has a budget (README, "Workers
 * Plan"), so what the summary of every market costs has to grow with the
 * networks, not with the markets.
 *
 * This is where the batching of that summary is counted, and only here: what
 * the route asks the node is the cost that matters, however the handler and
 * the evaluator share the work out between them.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const snapshot = loadRegistrySnapshotFixture();
const catalog  = fixtureCatalog(snapshot);

const LATEST = { number: 30_000_000, timestamp: 1_790_000_000 };

const COMET = new Interface([
  'function numAssets() view returns (uint8)',
  'function getAssetInfo(uint8) view returns (tuple(uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
  'function baseTokenPriceFeed() view returns (address)',
  'function getPrice(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalBorrow() view returns (uint256)',
  'function getUtilization() returns (uint256)',
  'function getSupplyRate(uint) returns (uint)',
  'function getBorrowRate(uint) returns (uint)',
  'function totalsCollateral(address) view returns (uint128)',
  'function symbol() view returns (string)',
]);

type Call = { id: number, method: string, params: any[] };

/*
 * A node that answers the summary's reads from the fixture snapshot, and
 * records every request it receives: its network and its calls.
 */
function fakeNode() {
  const markets = new Map(snapshot.networks.flatMap(network => network.markets.map(entry => (
    [ entry.contracts.comet!.toLowerCase(), entry ] as const
  ))));
  const symbols = new Map(snapshot.networks.flatMap(network => network.markets.flatMap(entry => (
    entry.collateralAssets.map(asset => [ asset.token.address.toLowerCase(), asset.token.symbol ] as const)
  ))));
  const requests: Array<{ network: string, calls: Call[] }> = [];

  const answer = ({ id, method, params }: Call) => {
    if (method === 'eth_getBlockByNumber') {
      return { jsonrpc: '2.0', id, result: { number: `0x${LATEST.number.toString(16)}`, timestamp: `0x${LATEST.timestamp.toString(16)}`, transactions: [] } };
    }
    const [ { to, data } ] = params;
    const fragment = COMET.getFunction(data.slice(0, 10)) as FunctionFragment;
    const entry = markets.get(to.toLowerCase());
    const values = ((): unknown[] => {
      switch (fragment.name) {
        case 'numAssets':          return [ entry!.collateralAssets.length ];
        case 'getAssetInfo': {
          const asset = entry!.collateralAssets[Number(COMET.decodeFunctionData(fragment, data)[0])]!;
          return [ [ asset.assetIndex, asset.token.address, asset.priceFeed.address, EthersBigNumber.from(10).pow(asset.token.decimals), 0, 0, 0, 0 ] ];
        }
        case 'baseTokenPriceFeed': return [ entry!.baseAsset.priceFeed.address ];
        case 'symbol':             return [ symbols.get(to.toLowerCase()) ?? 'TKN' ];
        default:                   return [ EthersBigNumber.from(10).pow(8) ];
      }
    })();
    return { jsonrpc: '2.0', id, result: COMET.encodeFunctionResult(fragment, values) };
  };

  const fetch = async (input: string | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const network = new URL(request.url).pathname.split('/')[1]!;
    const body = await request.json() as Call | Call[];
    const calls = body instanceof Array ? body : [ body ];
    requests.push({ network, calls });
    const responses = calls.map(answer);
    return new Response(JSON.stringify(body instanceof Array ? responses : responses[0]));
  };
  return { fetch, requests };
}

function context(): UninstantiatedContext {
  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  return {
    flags,
    instantiateEvaluator: (_: string, overrides: { flags?: Flags.SomeFlags } = {}) => Evaluator.instantiate(
      { ...evm, ...comet, ...market } as any,
      { cache, debug, flags: { ...flags, ...overrides.flags } },
    ),
  } as unknown as UninstantiatedContext;
}

t.test('the summary of every market makes four node requests per network', async t => {
  const node = fakeNode();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = node.fetch as typeof globalThis.fetch;
  t.teardown(() => { globalThis.fetch = fetchBefore; });

  const response = await marketHandlers.latestSummary(
    { apiHost: '', nodeHost: 'node.test', nodeKey: 'key', network: AllNetworks, contract: AllContracts, catalog, queryParams: new URLSearchParams() },
    context(),
  );
  const body = await response.json() as Array<{ status: string }>;

  t.equal(response.status, 200);
  t.equal(body.length, catalog.markets().length, 'every market is answered');
  t.ok(body.every(entry => entry.status === 'success'));

  const networks = [ ...new Set(catalog.markets().map(entry => entry.network)) ];
  for (const network of networks) {
    const requests = node.requests.filter(request => request.network === network);
    t.equal(requests.length, 4, `${network}: the latest block, then three rounds of reads, whatever its market count`);
  }
  t.equal(node.requests.length, 4 * networks.length);

  for (const { network, calls } of node.requests) {
    const distinct = new Set(calls.map(({ method, params }) => JSON.stringify([ method, params ])));
    t.equal(distinct.size, calls.length, `${network}: no call is sent twice in one batch`);
  }
});
