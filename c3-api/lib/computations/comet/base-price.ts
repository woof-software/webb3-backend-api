import * as Eth     from '../../eth-constants.js';
import * as Compute from '../../symbolic/computation.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import type { RegistryComet } from '../../model/comet-registry.js';

import type { GetPrice, PriceRead } from './get-price.js';

/*
 * The base asset's price in the unit the market's own feeds answer in, or
 * why it could not be read.
 *
 * The feed is the one the registry version names for the base asset, at the
 * scale the import read from it: what the Comet answered baseTokenPriceFeed()
 * with then, which the market rewards report as the market's feed and the
 * chain drift check holds against what the Comet answers now. Asking the
 * Comet again on every read made a second source for the same feed, which a
 * market whose feed governance changed would set apart. A summary of a past
 * block reads it too: once a version names a base feed governance put in
 * place, a day before that feed existed is an error, whatever the quote.
 */
type BasePrice = Compute.Spec<{
  name: 'basePrice',
  depends: [ GetPrice ],
  expects: {
    apiHost:     string,
    nodeHost:    string,
    nodeKey:     string,
    network:     KnownNetwork.Name,
    // a Comet the registry materialized, whose version names its base feed
    contract:    RegistryComet,
    blockNumber: Eth.BlockNumber,
  },
  returns: PriceRead,
}>;

const { implement, pull1 } = Compute.Functor<BasePrice>({});
const basePrice = implement({
  // 2: the feed is the one the registry version names, not one asked of the Comet
  version: 2,
  compute: ({ apiHost, nodeHost, nodeKey, blockNumber, contract, network }) => pull1({
    getPrice: {
      apiHost,
      nodeHost,
      nodeKey,
      network,
      contract,
      blockNumber,
      priceFeed: contract.base.priceFeed,
    },
  }),
});

export { BasePrice, basePrice };
