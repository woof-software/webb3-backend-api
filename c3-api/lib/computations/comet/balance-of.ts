import { BigFixnum }    from '../../bigfixnum.js';
import * as abiFunction from '../abi-function.js';
import * as Eth from '../../eth-constants.js';
import * as Key from '../../symbolic/key.js';

import { cometAmountKey, totalSupply } from './total-supply.js';

type BalanceOf = abiFunction.Spec<{
  name: 'balanceOf',
  expects: {
    address: Eth.Address
  },
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<BalanceOf>({});
const balanceOf = implement({
  // 2: keyed by the Comet and its base scale, not by everything its market says
  version: 2,
  signature: `function balanceOf(address) view returns (uint256)`,
  key(name, { address, contract, ...context }) {
    return Key.toKey(name, { ...context, address, contract: cometAmountKey(contract) });
  },
  parameters: ({ address }) => [address],
  parser: totalSupply['parser']
});

export { BalanceOf, balanceOf };
