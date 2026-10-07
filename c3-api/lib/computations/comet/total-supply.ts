import { BigFixnum }    from '../../bigfixnum.js';
import * as Eth         from '../../eth-constants.js';
import * as abiFunction from '../abi-function.js';

import { Comet } from '../../well-known/contracts/types.js';

type TotalSupply = abiFunction.Spec<{
  name: 'totalSupply',
  returns: BigFixnum,
}>;

const { implement } = abiFunction.Functor<TotalSupply>({});
const totalSupply = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function totalSupply() view returns (uint256)`,
  parser: ([ u256 ], { contract }) => {
    if (!Comet.is(contract)) {
      throw new Error(`invariant violated: contract is not a Comet contract`);
    }
    return BigFixnum.from({ value: u256, decimals: contract.base.asset.decimals });
  },
});

/*
 * What an amount a Comet reports is read from: the Comet, and the scale of
 * its base asset, which the parser above reads it at. A balance keyed by this
 * rather than by the contract's own key does not depend on the rest of what
 * describes the market — its feeds, its exceptions, its labels — and so
 * survives a version that changes only those.
 */
function cometAmountKey(contract: Eth.Contract): string {
  const comet = contract.address.toLowerCase();
  return Comet.is(contract) ? `${comet}:${contract.base.asset.decimals}` : comet;
}

export { TotalSupply, cometAmountKey, totalSupply };
