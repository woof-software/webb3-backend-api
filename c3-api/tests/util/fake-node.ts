import { Interface, type FunctionFragment } from '@ethersproject/abi';
import { BigNumber } from '@ethersproject/bignumber';

import type { RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';

/*
 * A node provider for the token list's reads, answering from a registry
 * snapshot: every collateral as the registry describes it, one unit of every
 * token held, and every price at 1.0, at one latest block. `script` changes
 * what one read answers — a value, a revert, or a failure of the call — and
 * can hold a request back, for a while or for good.
 *
 * It is a fetch: a test puts it in place of the global one, or behind the
 * node proxy's service binding.
 */
const COMET = new Interface([
  'function getAssetInfo(uint8) view returns (tuple(uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
  'function getPrice(address) view returns (uint256)',
  'function totalsCollateral(address) view returns (uint128)',
]);

type Block = { number: number, timestamp: number };
type Call  = { id: number, method: string, params: any[] };
type Read  = { network: string, comet: string, name: string, argument: string };

type NodeScript = {
  answer?: (read: Read) => unknown[] | 'revert' | 'fail' | undefined,
  block?:  () => Block | 'fail',
  // what a request waits for before it is answered; 'forever' never answers it
  hold?:   (request: { network: string, calls: Call[] }) => Promise<unknown> | 'forever' | undefined,
};

type FakeNode = {
  fetch:    (input: string | Request, init?: RequestInit) => Promise<Response>,
  requests: Array<{ network: string, calls: Call[] }>,
};

function fakeNode(snapshot: RegistrySnapshotV1, latest: Block, script: NodeScript = {}): FakeNode {
  const markets = new Map(snapshot.networks.flatMap(network => network.markets.map(entry => (
    [ entry.contracts.comet!.toLowerCase(), entry ] as const
  ))));
  const requests: FakeNode['requests'] = [];

  const answer = (network: string, { id, method, params }: Call) => {
    if (method === 'eth_getBlockByNumber') {
      const block = script.block?.() ?? latest;
      return block === 'fail'
        ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'header not found' } }
        : { jsonrpc: '2.0', id, result: { number: `0x${block.number.toString(16)}`, timestamp: `0x${block.timestamp.toString(16)}`, transactions: [] } };
    }
    const [ { to, data } ] = params;
    const fragment = COMET.getFunction(data.slice(0, 10)) as FunctionFragment;
    const argument = String(COMET.decodeFunctionData(fragment, data)[0]).toLowerCase();
    const scripted = script.answer?.({ network, comet: to.toLowerCase(), name: fragment.name, argument });
    if (scripted === 'revert') {
      return { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted', data: '0x' } };
    }
    if (scripted === 'fail') {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: 'missing trie node' } };
    }
    const entry = markets.get(to.toLowerCase())!;
    const values = scripted ?? ((): unknown[] => {
      switch (fragment.name) {
        case 'getAssetInfo': {
          const asset = entry.collateralAssets.find(candidate => String(candidate.assetIndex) === argument)!;
          return [ [ asset.assetIndex, asset.token.address, asset.priceFeed.address, BigNumber.from(10).pow(asset.token.decimals), 0, 0, 0, 0 ] ];
        }
        case 'totalsCollateral': {
          const asset = entry.collateralAssets.find(candidate => candidate.token.address === argument)!;
          return [ BigNumber.from(10).pow(asset.token.decimals) ];
        }
        default:
          return [ BigNumber.from(10).pow(8) ];
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
    const hold = script.hold?.({ network, calls });
    if (hold === 'forever') {
      return new Promise<Response>(() => {});
    }
    await hold;
    const responses = calls.map(call => answer(network, call));
    return new Response(JSON.stringify(body instanceof Array ? responses : responses[0]));
  };
  return { fetch, requests };
}

const isBlockRead = (request: { calls: Call[] }) => request.calls[0]!.method === 'eth_getBlockByNumber';

// what a node was asked: its latest-block reads, and the batches of everything else
const blockReads = (node: FakeNode) => node.requests.filter(isBlockRead);
const batches    = (node: FakeNode) => node.requests.filter(request => !isBlockRead(request));

export type { Block, Call, FakeNode, NodeScript, Read };
export { COMET, batches, blockReads, fakeNode };
