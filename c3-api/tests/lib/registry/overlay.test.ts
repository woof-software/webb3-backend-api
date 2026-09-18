import t from 'tap';

import {
  overlayDigest,
  parseMarketOverlay,
  parseNetworkOverlay,
} from '../../../src/registry/overlay.js';
import { isRegistryError } from '../../../src/registry/errors.js';

/*
 * Overlay documents are complete replacements with exact key sets: a missing
 * key is a missing decision and an unknown key is a mistake, so both are
 * rejected rather than defaulted. Parsing also normalizes, which is what lets
 * an identical overlay produce an identical digest.
 */
const ADDRESS   = '0xC3d688B66703497DAA19211EEdff47f25384cdc3';
const FEED      = '0x8fFfFfd4AFB6115b954Bd326cbe7B4BA576818f6';
const USD_FEED  = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419';
const OTHER     = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const marketOverlay = {
  displayName:          'USDC',
  contractName:         'cUSDCv3',
  isDefault:            true,
  status:               'enabled',
  creationBlock:        15331586,
  collateralValueQuote: 'usd',
  capabilities:         { rewards: true, accountRewards: true, transactionHistory: true },
  baseAsset:            { displayName: 'USD Coin', isWrappedNative: false, usdPriceFeedAddress: null },
  rewardPriceFeed:      { address: FEED, quote: 'usd' },
};

const networkOverlay = {
  displayName:           'Ethereum',
  assetDisplayOverrides: [
    { tokenAddress: OTHER, displayAddress: OTHER, symbol: 'USDC', name: 'USD Coin' },
    { tokenAddress: ADDRESS, displayAddress: ADDRESS, symbol: 'cUSDCv3', name: 'Compound USDC' },
  ],
  unwrappedCollateralAssets: [],
  priceExceptions: [
    { kind: 'zero_price', priceFeedAddress: FEED, provenance: 'feed reverts', expiresAt: null },
    {
      kind:             'fixed_price',
      priceFeedAddress: ADDRESS,
      price:            { value: '102447384', decimals: 8 },
      provenance:       'last answer of a retired aggregator',
      expiresAt:        '2027-01-01T00:00:00.000Z',
    },
  ],
};

function rejects(operation: () => unknown, message: RegExp, name: string): void {
  try {
    operation();
  } catch (error) {
    if (!isRegistryError(error)) {
      throw error;
    }
    t.equal(error.code, 'OVERLAY_INVALID', `${name} is rejected`);
    t.match(error.message, message, `${name} explains why`);
    return;
  }
  throw new Error(`expected ${name} to be rejected`);
}

t.test('a market overlay states every reviewed decision', async t => {
  const parsed = parseMarketOverlay(marketOverlay);
  t.equal(parsed.displayName, 'USDC');
  t.equal(parsed.rewardPriceFeed?.address, FEED.toLowerCase(), 'feed addresses are normalized lowercase');

  const usdQuoted = parseMarketOverlay({
    ...marketOverlay,
    collateralValueQuote: 'base',
    baseAsset: { displayName: 'Ether', isWrappedNative: true, usdPriceFeedAddress: USD_FEED },
    rewardPriceFeed: { address: FEED, quote: 'base' },
  });
  t.equal(usdQuoted.baseAsset.usdPriceFeedAddress, USD_FEED.toLowerCase(), 'a base-quoted market names its USD feed');

  const withoutRewards = parseMarketOverlay({ ...marketOverlay, rewardPriceFeed: null });
  t.equal(withoutRewards.rewardPriceFeed, null, 'a market may have no reward feed');

  const { displayName: _omitted, ...missing } = marketOverlay;
  rejects(() => parseMarketOverlay(missing), /missing: displayName/, 'a missing decision');
  rejects(() => parseMarketOverlay({ ...marketOverlay, sortOrder: 3 }), /unexpected keys: sortOrder/, 'an unknown key');
  rejects(() => parseMarketOverlay({ ...marketOverlay, status: 'paused' }), /must be one of/, 'an unknown status');
  rejects(() => parseMarketOverlay({ ...marketOverlay, collateralValueQuote: 'eth' }), /must be one of/, 'an unknown quote');
  rejects(() => parseMarketOverlay({ ...marketOverlay, creationBlock: -1 }), /non-negative block/, 'a negative block');
  rejects(() => parseMarketOverlay({ ...marketOverlay, creationBlock: 1.5 }), /non-negative block/, 'a fractional block');
  rejects(() => parseMarketOverlay({ ...marketOverlay, isDefault: 'yes' }), /must be a boolean/, 'a non-boolean default');
  rejects(() => parseMarketOverlay({ ...marketOverlay, displayName: '   ' }), /non-empty string/, 'a blank label');
  rejects(
    () => parseMarketOverlay({ ...marketOverlay, capabilities: { rewards: true, accountRewards: true } }),
    /missing: transactionHistory/,
    'a partial capability set',
  );
  rejects(
    () => parseMarketOverlay({ ...marketOverlay, rewardPriceFeed: { address: FEED, quote: 'gbp' } }),
    /must be one of/,
    'an unknown reward feed unit',
  );
  rejects(
    () => parseMarketOverlay({ ...marketOverlay, baseAsset: { displayName: 'USD Coin', isWrappedNative: false, usdPriceFeedAddress: '0x1234' } }),
    /must be an address/,
    'a malformed USD feed',
  );
  rejects(() => parseMarketOverlay(null), /must be an object/, 'a null overlay');
  rejects(() => parseMarketOverlay([ marketOverlay ]), /must be an object/, 'an array');
});

t.test('a network overlay is normalized and duplicate-free', async t => {
  const parsed = parseNetworkOverlay(networkOverlay);
  t.same(
    parsed.assetDisplayOverrides.map(override => override.tokenAddress),
    [ OTHER, ADDRESS.toLowerCase() ].sort(),
    'display overrides are sorted by token address',
  );
  t.same(
    parsed.priceExceptions.map(exception => exception.priceFeedAddress),
    [ ADDRESS.toLowerCase(), FEED.toLowerCase() ].sort(),
    'price exceptions are sorted by feed address',
  );
  t.same(
    parsed.priceExceptions.map(exception => exception.kind),
    [ 'zero_price', 'fixed_price' ],
    'each exception keeps its kind through sorting',
  );

  const remap = parseNetworkOverlay({
    ...networkOverlay,
    priceExceptions: [
      { kind: 'deprecated_price_remap', priceFeedAddress: FEED, replacementPriceFeedAddress: USD_FEED, provenance: 'governance replaced it', expiresAt: null },
    ],
  });
  t.equal(
    remap.priceExceptions[0]!.kind === 'deprecated_price_remap' && remap.priceExceptions[0].replacementPriceFeed.decimals,
    -1,
    'a remap carries no decimals: enrichment reads them from the replacement feed',
  );

  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [
        { kind: 'zero_price', priceFeedAddress: FEED, provenance: 'one', expiresAt: null },
        { kind: 'zero_price', priceFeedAddress: FEED, provenance: 'two', expiresAt: null },
      ],
    }),
    /same address twice/,
    'two exceptions for one feed',
  );
  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [ { kind: 'fixed_price', priceFeedAddress: FEED, price: { value: '1.5', decimals: 8 }, provenance: 'x', expiresAt: null } ],
    }),
    /decimal string/,
    'a fractional fixed price',
  );
  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [ { kind: 'fixed_price', priceFeedAddress: FEED, provenance: 'x', expiresAt: null } ],
    }),
    /missing: price/,
    'a fixed price without a price',
  );
  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [ { kind: 'zero_price', priceFeedAddress: FEED, price: { value: '1', decimals: 8 }, provenance: 'x', expiresAt: null } ],
    }),
    /unexpected keys: price/,
    'a zero price with a price',
  );
  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [ { kind: 'deprecated_price_remap', priceFeedAddress: FEED, replacementPriceFeedAddress: FEED, provenance: 'x', expiresAt: null } ],
    }),
    /remaps a feed onto itself/,
    'a self remap',
  );
  rejects(
    () => parseNetworkOverlay({
      ...networkOverlay,
      priceExceptions: [ { kind: 'zero_price', priceFeedAddress: FEED, provenance: 'x', expiresAt: 'soon' } ],
    }),
    /ISO-8601/,
    'a malformed expiry',
  );
  rejects(
    () => parseNetworkOverlay({ ...networkOverlay, unwrappedCollateralAssets: {} }),
    /must be an array/,
    'a non-array pair list',
  );
});

t.test('the digest identifies an overlay, not its spelling', async t => {
  const digest = await overlayDigest(parseNetworkOverlay(networkOverlay));

  const reordered = await overlayDigest(parseNetworkOverlay({
    ...networkOverlay,
    assetDisplayOverrides: [ ...networkOverlay.assetDisplayOverrides ].reverse(),
    priceExceptions:       [ ...networkOverlay.priceExceptions ].reverse(),
  }));
  t.equal(reordered, digest, 'array order does not change the digest');

  const recased = await overlayDigest(parseNetworkOverlay({
    ...networkOverlay,
    priceExceptions: networkOverlay.priceExceptions.map(exception => ({
      ...exception,
      priceFeedAddress: exception.priceFeedAddress.toUpperCase().replace('0X', '0x'),
    })),
  }));
  t.equal(recased, digest, 'address casing does not change the digest');

  const changed = await overlayDigest(parseNetworkOverlay({ ...networkOverlay, displayName: 'Ethereum Mainnet' }));
  t.not(changed, digest, 'a reviewed change does change the digest');
});
