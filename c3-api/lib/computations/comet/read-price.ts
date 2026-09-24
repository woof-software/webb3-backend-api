import { BigFixnum }    from '../../bigfixnum.js';
import * as Key         from '../../symbolic/key.js';
import * as Compute     from '../../symbolic/computation.js';
import * as abiFunction from '../abi-function.js';

import type { EvmRpc } from '../evm/rpc.js';
import { callOf, isCallReverted, resultOf } from '../evm/eth-call.js';

import type { GetPrice } from './get-price.js';

/*
 * A price as a Comet reads it, or why it could not be read.
 *
 * Comet.getPrice calls latestRoundData on the feed and reverts with it, so a
 * feed Chainlink retired reverts every read of that price. getPrice fails the
 * whole computation on it; readPrice answers it as a value, so a summary can
 * report the price it could not read beside the ones it could. Only a revert
 * is answered: a node that does not answer still fails.
 */
type PriceRead = (
  | { status: 'success', price:   BigFixnum }
  | { status: 'error',   message: string    }
);

type ReadPrice = Compute.Spec<{
  name: 'readPrice',
  depends: [ EvmRpc ],
  expects: GetPrice['expects'],
  returns: PriceRead,
}>;

const coder = abiFunction.getCoder(`function getPrice(address) view returns (uint256)`);

const { implement, pipe1 } = Compute.Functor<ReadPrice>({});
const readPrice = implement({
  version: 1,
  key(name, { priceFeed, ...context }) {
    return Key.toKey(name, { priceFeed: priceFeed.address, ...context });
  },
  compute({ apiHost, nodeHost, nodeKey, network, contract, blockNumber: block, priceFeed }) {
    const call = { network, to: contract.address, data: coder.encode([ priceFeed.address ]), block };
    return pipe1([
      { evmRpc: { frame: { apiHost, nodeHost, nodeKey, network }, items: [ callOf(call) ] } },
      ([ response ]): PriceRead => {
        try {
          const [ price ] = coder.decode(resultOf(response, call));
          return { status: 'success', price: BigFixnum.from({ decimals: priceFeed.decimals, value: price }) };
        } catch (error) {
          if (!isCallReverted(error)) {
            throw error;
          }
          console.error(
            `price feed reverted: ${priceFeed.address} read by ${contract.address} on ${network}`
            + ` at block ${block}: ${error.error.message}`
          );
          return { status: 'error', message: error.error.message };
        }
      },
    ]);
  },
});

export { PriceRead, ReadPrice, readPrice };
