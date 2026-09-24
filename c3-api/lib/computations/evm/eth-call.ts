import { BytesLike } from '@ethersproject/bytes';

import * as Eth     from '../../eth-constants.js';
import * as jsonRpc from '../../json-rpc.js';
import * as Compute from '../../symbolic/computation.js';
import { Contract } from '../../well-known/contracts/utils.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import { EvmRpc } from './rpc.js';

type EthCall = Compute.Spec<{
  name: 'ethCall',
  depends: [ EvmRpc ],
  expects: {
    data: string,
    apiHost: string,
    nodeHost: string,
    nodeKey: string,
    network: KnownNetwork.Name,
    contract: Contract,
    blockNumber: Eth.BlockNumber,
  },
  returns: BytesLike,
}>;

const { implement, pipe1 } = Compute.Functor<EthCall>({});

const ethCall = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  async compute({ blockNumber: block, apiHost, nodeHost, nodeKey, network, contract, data }) {
    const call = { network, to: contract.address, data, block };
    return pipe1([
      { evmRpc: { frame: { apiHost, nodeHost, nodeKey, network }, items: [ callOf(call) ] } },
      ([ response ]) => resultOf(response, call),
    ]);
  },
});

/*
 * The JSON-RPC eth_call of `data` against `to` at a block.
 */
function callOf({ to, data, block }: CallReverted['call']): jsonRpc.Call {
  return {
    method: 'eth_call',
    params: [
      { to, data },
      `0x${block.toString(16)}`,
    ],
  };
}

/*
 * What a call returned. A revert throws CallReverted; any other answer that
 * is not a result throws a plain error.
 */
function resultOf({ result, error }: { result?: unknown, error?: jsonRpc.Error }, call: CallReverted['call']): BytesLike {
  if (error) {
    console.error({ error });
    if (isRevert(error)) {
      throw new CallReverted(error, call);
    }
    throw new Error(`ethCall: call error: ${JSON.stringify(error)}`);
  }
  if (!isBytesLike(result) || result === '0x') {
    console.error({ error: { message: 'malformed result' }, result });
    throw new Error(`ethCall: result is not byteslike`);
  }
  return result;
}

function isBytesLike(data: any): data is BytesLike {
  return typeof data === 'string' || (data instanceof Array);
}

/*
 * A call the node executed and the contract refused: a Comet reading a price
 * feed Chainlink retired, for one. It is a fact about the contract at that
 * block, not about the node, so asking again or asking another provider gets
 * the same answer — which is what tells it apart from a node that did not
 * answer at all.
 *
 * Geth and its forks answer `3` when the revert carries data, and `-32000`
 * with the same message when it does not.
 */
function isRevert(error: jsonRpc.Error): boolean {
  return error.code === 3 || /revert/i.test(error.message);
}

class CallReverted extends Error {
  // what the node answered, whose message is the one a route reports
  readonly error: jsonRpc.Error;
  readonly call: {
    network: KnownNetwork.Name,
    to:      Eth.Address,
    data:    string,
    block:   Eth.BlockNumber,
  };

  constructor(error: jsonRpc.Error, call: CallReverted['call']) {
    super(`ethCall: call error: ${JSON.stringify(error)}`);
    this.name  = 'CallReverted';
    this.error = error;
    this.call  = call;
  }
}

function isCallReverted(error: unknown): error is CallReverted {
  return error instanceof CallReverted;
}

export { EthCall, ethCall, CallReverted, callOf, isCallReverted, resultOf };
