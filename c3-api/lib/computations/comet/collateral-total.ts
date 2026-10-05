import { BigNumber } from '@ethersproject/bignumber';

import * as Eth         from '../../eth-constants.js';
import * as abiFunction from '../abi-function.js';

/*
 * How much of one collateral token a Comet holds, in the token's own units.
 *
 * The token comes from the registry rather than from a read of the asset's
 * info, so the amount is read in the same round as everything else about the
 * asset, and a revert is an answer, as it is for collateralAssetInfo.
 */
type CollateralTotalRead = (
  | { status: 'success', total: BigNumber }
  | { status: 'reverted', message: string }
);

type CollateralTotal = abiFunction.Spec<{
  name: 'collateralTotal',
  expects: { token: Eth.Address },
  returns: CollateralTotalRead,
}>;

const { implement } = abiFunction.Functor<CollateralTotal>({});
const collateralTotal = implement<CollateralTotalRead>({
  version: 1,
  signature: `function totalsCollateral(address) view returns (uint128)`,
  parameters: ({ token }) => [ token ],
  parser: ([ total ]) => ({ status: 'success', total: BigNumber.from(total) }),
  reverted: ({ message }) => ({ status: 'reverted', message }),
});

export { CollateralTotal, CollateralTotalRead, collateralTotal };
