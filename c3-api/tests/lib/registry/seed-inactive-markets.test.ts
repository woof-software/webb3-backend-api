import t from 'tap';

import { isAddress } from '../../../lib/model/comet-registry.js';

import { readSeed, readSeedComets, readSeedInactive, readSeedInactiveText } from '../../util/registry-seed.js';

/*
 * The first list of inactive markets is the body of
 * `POST …/inactive-markets/review` and `/apply` that step 8 of the runbook's
 * first bring-up sends once the seed's version is on, and review holds every
 * row against that version. What holds without one is held here: the file's
 * form, and each row against what the repository knows — the chains the app
 * listed apart by its own list (INACTIVE_CHAIN_IDS), every market the seed
 * holds on them, and the Comet the seed names for each. Whether a version
 * holds a market, the fixture answers for the one of them it holds,
 * Scroll's (tests/e2e/registry/inactive-markets.test.ts), and only a version
 * imported from the source for the others.
 */
const text   = readSeedInactiveText();
const list   = readSeedInactive();
const comets = readSeedComets();
const seed   = readSeed();

const REASON = 'Inactive market the app listed apart by its own list of chains (INACTIVE_CHAIN_IDS) until the registry served it (Linear COM-19)';

// the chains of the app's list: Scroll, Linea, Ronin, Polygon, Unichain and Mantle
const CHAINS = [ 534352, 59144, 2020, 137, 130, 5000 ];

// a row as the export writes one
const ROW = [ 'chainId', 'cometAddress', 'deploymentKey', 'isInactive' ];

// a market as the seed keys it
const keyOf = (row: { chainId: number, deploymentKey?: string | null }) => `${row.chainId}/${row.deploymentKey}`;

t.test('the file is a list review and apply take as it is', async t => {
  t.equal(text, `${JSON.stringify(list, null, 2)}\n`, 'written as JSON.stringify writes it, two spaces and a newline');
  t.same(Object.keys(list), [ 'reason', 'inactiveMarkets' ], 'a reason and its rows, and nothing else an export answers');
  t.equal(list.reason, REASON, 'the one reason every row is recorded with');
  t.equal(list.inactiveMarkets.length, 10, 'ten rows, as the six chains hold ten markets');
  t.same(list.inactiveMarkets.filter(row => Object.keys(row).join() !== ROW.join()), [],
    'each with the members of an exported row, in their order, and no reason of its own');
  const ordered = [ ...list.inactiveMarkets ].sort((a, b) => a.chainId - b.chainId || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
  t.same(list.inactiveMarkets.map(keyOf), ordered.map(keyOf), 'in the order the export lists them: by chain id, then by deployment key');
});

t.test('every row marks inactive one market of a chain the app listed apart', async t => {
  t.same(list.inactiveMarkets.filter(row => !CHAINS.includes(row.chainId)).map(keyOf), [], 'each on one of the six chains');
  t.ok(list.inactiveMarkets.every(row => row.isInactive === true), 'all inactive');
  t.same(
    list.inactiveMarkets.map(row => row.cometAddress).filter(address => !isAddress(address) || address !== address.toLowerCase()),
    [],
    'every address lowercase',
  );
  const markets = list.inactiveMarkets.map(row => `${row.chainId}:${row.cometAddress}`);
  t.same(markets.filter((market, index) => markets.indexOf(market) !== index), [], 'and no market twice');
});

/*
 * The app listed whole chains apart, so the list holds every market the seed
 * holds on them, none of which is the default market.
 */
t.test('every row names its market as the seed does, and the list holds every market the seed holds on the six chains', async t => {
  t.same(
    list.inactiveMarkets.map(row => row.cometAddress),
    list.inactiveMarkets.map(row => comets[keyOf(row)]),
    'each Comet the one production.comets.json names for the row\'s market',
  );
  t.same(
    list.inactiveMarkets.map(keyOf).sort(),
    Object.keys(seed.markets).filter(key => CHAINS.includes(Number(key.split('/')[0]))).sort(),
    'and every market production.json holds on those chains, and no other',
  );
  t.same(list.inactiveMarkets.filter(row => (seed.markets[keyOf(row)] as { isDefault?: unknown } | undefined)?.isDefault !== false).map(keyOf), [],
    'none of them the default market');
});
