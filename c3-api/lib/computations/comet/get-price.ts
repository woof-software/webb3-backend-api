import { BigFixnum }    from '../../bigfixnum.js';
import * as Eth         from '../../eth-constants.js';
import * as Key         from '../../symbolic/key.js';
import * as abiFunction from '../abi-function.js';

/*
 * A price as a Comet reads it, or why it could not be read.
 *
 * Comet.getPrice calls latestRoundData on the feed and reverts with it, so a
 * feed Chainlink retired reverts every read of that price. The read answers
 * the revert instead of failing, so a summary can report the price it could
 * not read beside the ones it could. A node that does not answer still fails.
 */
type PriceError = { status: 'error', message: string };
type PriceRead  = { status: 'success', price: BigFixnum } | PriceError;

type GetPrice = abiFunction.Spec<{
  name: 'getPrice',
  expects: {
    priceFeed: {
      address: Eth.Address,
      decimals: number,
    },
  },
  returns: PriceRead,
}>;

const { implement } = abiFunction.Functor<GetPrice>({});
const getPrice = implement({
  // 1: a feed that reverts is answered, not thrown
  version: 1,
  signature: `function getPrice(address) view returns (uint256)`,
  key(name, { priceFeed, ...context }) {
    return Key.toKey(name, { priceFeed: priceFeed.address, ...context });
  },
  parameters: ({ priceFeed }) => [ priceFeed.address ],
  parser: ([ u256 ], { priceFeed: { decimals } }) => ({
    status: 'success',
    price:  BigFixnum.from({ decimals, value: u256 }),
  }),
  reverted: ({ message }, { priceFeed, contract, network, blockNumber }) => {
    console.error(
      `price feed reverted: ${priceFeed.address} read by ${contract.address} on ${network}`
      + ` at block ${blockNumber}: ${message}`
    );
    return { status: 'error', message };
  },
});

export { GetPrice, PriceError, PriceRead, getPrice };
