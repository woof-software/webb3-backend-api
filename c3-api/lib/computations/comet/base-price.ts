import { BigFixnum }    from '../../bigfixnum.js';
import * as abiFunction from '../abi-function.js';

import type { GetPrice  } from './get-price.js';
import type { PriceRead, ReadPrice } from './read-price.js';

type BasePrice = abiFunction.Spec<{
  name: 'basePrice',
  depends: [ GetPrice ],
  returns: BigFixnum,
}>;

const { implement, pull1 } = abiFunction.Functor<BasePrice>({});
const basePrice = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function baseTokenPriceFeed() view returns (address)`,
  parser: ([ priceFeed ], { apiHost, nodeHost, nodeKey, blockNumber, contract, network }) => {
    return pull1({
      getPrice: {
        apiHost,
        nodeHost,
        nodeKey,
        priceFeed: {
          address: priceFeed,
          decimals: 8, // FIXME: should not assume 8, probably...?
        },
        blockNumber,
        contract,
        network,
      }
    });
  },
});

/*
 * The same price, answered rather than thrown when the feed reverts, for a
 * summary that reports a market it cannot price instead of failing.
 */
type BasePriceRead = abiFunction.Spec<{
  name: 'basePriceRead',
  depends: [ ReadPrice ],
  returns: PriceRead,
}>;

const { implement: implementRead, pull1: pullRead } = abiFunction.Functor<BasePriceRead>({});
const basePriceRead = implementRead({
  version: 1,
  signature: `function baseTokenPriceFeed() view returns (address)`,
  parser: ([ priceFeed ], { apiHost, nodeHost, nodeKey, blockNumber, contract, network }) => {
    return pullRead({
      readPrice: {
        apiHost,
        nodeHost,
        nodeKey,
        priceFeed: {
          address: priceFeed,
          decimals: 8, // FIXME: should not assume 8, no more than basePrice should
        },
        blockNumber,
        contract,
        network,
      }
    });
  },
});

export { BasePrice, basePrice, BasePriceRead, basePriceRead };
