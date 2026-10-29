import t from 'tap';

import { randomUUID } from 'node:crypto';

import type {
  InactiveMarketApplyV1,
  InactiveMarketDetailV1,
  InactiveMarketListV1,
  InactiveMarketResultV1,
  InactiveMarketReviewV1,
  NetworkV1,
} from '../../../lib/model/comet-registry.js';
import { DEPRECATED_COLLATERAL_KIND, HIDDEN_COLLATERAL_KIND, setCollateral } from '../../../src/registry/collateral-decision-repository.js';
import { applyInactiveMarkets, exportInactiveMarkets, setInactiveMarket } from '../../../src/registry/inactive-market-repository.js';
import { activateVersion } from '../../../src/registry/repository.js';

import { foreignKeyViolations } from '../../util/d1.js';
import { ADMIN_ACTOR, adminClient, count, freshActive, seedValidated } from '../../util/registry-admin.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { registryHarness } from '../../util/registry-harness.js';
import { readSeedInactive, readSeedInactiveText } from '../../util/registry-seed.js';

import { INACTIVE_MARKETS, decisionScenarios } from './decision-scenarios.js';

/*
 * Inactive markets, through the real worker in workerd over local D1. What
 * every kind of decision does is in decision-scenarios.ts, run here for
 * inactive markets: a decision and its audit, idempotency under a race,
 * survival across activations, the database guard against an activation that
 * races a write, and a list refused for its problems or for a race. Beside
 * them, the tests of inactive markets alone: a list exported, edited,
 * reviewed and applied apart from the decisions about collaterals; a market
 * of any status decided about; the first list the seed holds
 * (registry/seed/production.inactive-markets.json); and one Comet on two
 * chains, which is two markets.
 *
 * Every request here spends from one budget of the address limiter, so what
 * a test only sets up, its version and the decisions it starts from, is
 * written through the repository. Refusals of malformed requests are in
 * inactive-market-routes.test.ts, and the record an outage answers /summary
 * with in inactive-market-reads.test.ts.
 */
const harness = await registryHarness({ admin: true, vars: { COMET_REGISTRY_ADMIN_ACTOR: ADMIN_ACTOR } });
const admin   = adminClient(harness.server);

decisionScenarios(harness, INACTIVE_MARKETS);

const snapshot = loadRegistrySnapshotFixture();
const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;

const comet = (key: string) => mainnet.markets.find(market => market.deploymentKey === key)!.contracts.comet!;
const collateral = (key: string, symbol: string) => mainnet.markets.find(market => market.deploymentKey === key)!
  .collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address;

const USDC   = comet('usdc');
const USDT   = comet('usdt');
const WBTC   = comet('wbtc');
const WETH   = comet('weth');
const SCROLL = snapshot.networks.find(network => network.chainId === 534352)!.markets[0]!.contracts.comet!;
const METH   = collateral('usdt', 'mETH');
const WEETH  = collateral('usdc', 'weETH');

const EXPORT = INACTIVE_MARKETS.list.export;
const REVIEW = INACTIVE_MARKETS.list.review;
const APPLY  = INACTIVE_MARKETS.list.apply;

type Refused = { error: { code: string, message: string, details?: { problems?: unknown[] } } };

// every market of the fixture, as the export lists it: by chain id, then by deployment key
const EVERY = snapshot.networks
  .flatMap(network => network.markets.map(market => ({ chainId: network.chainId, cometAddress: market.contracts.comet!, deploymentKey: market.deploymentKey })))
  .sort((a, b) => a.chainId - b.chainId || (a.deploymentKey < b.deploymentKey ? -1 : a.deploymentKey > b.deploymentKey ? 1 : 0));

// the markets a list marks inactive, as `chainId/deploymentKey`
function marked(rows: Array<{ chainId: number, deploymentKey?: string | null, isInactive: boolean }>): string[] {
  return rows.filter(row => row.isInactive).map(row => `${row.chainId}/${row.deploymentKey}`);
}

/*
 * A fresh database with `networks` validated and active, switched on through
 * the repository so that the setup spends nothing of the limiter's budget.
 */
async function activeWith(networks: NetworkV1[]): Promise<{ db: D1Database, versionId: string }> {
  const db        = await harness.freshDatabase();
  const versionId = await seedValidated(db, { networks });
  await activateVersion(db, { versionId, action: 'activate', actor: 'test-seed', reason: 'seeded for a test' });
  return { db, versionId };
}

/*
 * A list of decisions: exported as a file, edited, reviewed as the diff it
 * would make, and applied in one transaction. The file is the export itself,
 * so nobody writes a Comet by hand, and the body applied is the one the docs
 * build from a review: its changed rows, each with the export's members and
 * the reason it will be recorded with. The default market is decided about
 * as any other. A market's decision is its own: the decisions about its
 * collaterals keep their rows and their events.
 */
t.test('a list of inactive markets is exported, reviewed, and applied as one, apart from the collateral decisions', async t => {
  const { db, versionId } = await freshActive(harness, { activate: true });
  await setInactiveMarket(db, { chainId: 1, cometAddress: WBTC, isInactive: true, actor: ADMIN_ACTOR, reason: 'decided by hand' });
  await setCollateral(db, DEPRECATED_COLLATERAL_KIND, {
    chainId: 1, cometAddress: USDT, tokenAddress: METH, isDeprecated: true, actor: ADMIN_ACTOR, reason: 'Linear COM-18',
  });
  await setCollateral(db, HIDDEN_COLLATERAL_KIND, {
    chainId: 1, cometAddress: USDC, tokenAddress: WEETH, isHidden: true, actor: ADMIN_ACTOR, reason: 'not for discovery',
  });

  const exported = await admin.read<InactiveMarketListV1>(EXPORT);
  t.equal(exported.status, 200);
  t.equal(exported.header('x-registry-version'), versionId, 'the export names the version it lists');
  t.same(exported.body.registryVersion, { id: versionId, checksum: snapshot.registryVersion.checksum });
  t.equal(exported.body.reason, null, 'with a place for the reason of the changes');
  t.strictSame(exported.body.inactiveMarkets, EVERY.map(market => ({ ...market, isInactive: market.cometAddress === WBTC })),
    'and every market of the active version, once, by chain and deployment key, with the decision in force');
  t.same(exported.body.retained, [], 'with nothing kept apart, since the version holds every market decided about');

  const untouched = await admin.post<InactiveMarketReviewV1>(REVIEW, exported.body);
  t.equal(untouched.status, 200, 'the export is a list review takes back as it is');
  t.same(untouched.body.summary, { change: 0, unchanged: EVERY.length, problems: 0 }, 'and it changes nothing');

  // what an operator does with the file: mark the default market and Scroll's inactive, take WBTC's back, and give the reason once
  const edited = {
    ...exported.body,
    reason:          'reviewed for the app',
    inactiveMarkets: exported.body.inactiveMarkets.map(row =>
        row.cometAddress === USDC   ? { ...row, isInactive: true }
      : row.cometAddress === SCROLL ? { ...row, isInactive: true, reason: 'its chain is no longer offered' }
      : row.cometAddress === WBTC   ? { ...row, isInactive: false }
      : row),
  };
  const review = await admin.post<InactiveMarketReviewV1>(REVIEW, edited);
  t.same(review.body.summary, { change: 3, unchanged: EVERY.length - 3, problems: 0 }, 'the default market among them, which nothing refuses');
  t.same(
    review.body.inactiveMarkets.filter(row => row.action === 'change')
      .map(row => [ `${row.chainId}/${row.deploymentKey}`, row.current, row.requested, row.reason ]),
    // in the export's order: by chain, then by deployment key
    [
      [ '1/usdc',      false, true,  'reviewed for the app' ],
      [ '1/wbtc',      true,  false, 'reviewed for the app' ],
      [ '534352/usdc', false, true,  'its chain is no longer offered' ],
    ],
    'the review names every change, with the reason it will be recorded with',
  );
  t.equal(await count(db, 'inactive_market_events'), 1, 'and writes nothing');

  // {reason: null, inactiveMarkets: [.inactiveMarkets[] | select(.action == "change") | {chainId, cometAddress, deploymentKey, isInactive: .requested, reason}]}
  const changes = {
    reason:          null,
    inactiveMarkets: review.body.inactiveMarkets.filter(row => row.action === 'change')
      .map(({ chainId, cometAddress, deploymentKey, requested, reason }) => ({ chainId, cometAddress, deploymentKey, isInactive: requested, reason })),
  };
  const applied = await admin.post<InactiveMarketApplyV1>(APPLY, changes);
  t.equal(applied.status, 200, 'the changes a review names are a list apply takes');
  t.same(applied.body.summary, { changed: review.body.summary.change, unchanged: 0 }, 'and applying them writes exactly the reviewed changes');
  t.equal(applied.header('x-registry-version'), versionId);
  t.same(
    (await db.prepare(`SELECT chain_id, comet_address, reason, actor FROM inactive_market_events WHERE reason <> 'decided by hand' ORDER BY rowid`)
      .all()).results,
    [
      { chain_id: 1,      comet_address: USDC,   reason: 'reviewed for the app',           actor: ADMIN_ACTOR },
      { chain_id: 1,      comet_address: WBTC,   reason: 'reviewed for the app',           actor: ADMIN_ACTOR },
      { chain_id: 534352, comet_address: SCROLL, reason: 'its chain is no longer offered', actor: ADMIN_ACTOR },
    ],
    'one event per change, each with its reason',
  );
  const after = await admin.read<InactiveMarketListV1>(EXPORT);
  t.same(marked(after.body.inactiveMarkets), [ '1/usdc', '534352/usdc' ], 'and the decisions are what the list says');

  const again = await admin.post<InactiveMarketApplyV1>(APPLY, edited);
  t.same(again.body.summary, { changed: 0, unchanged: EVERY.length }, 'applying the whole list again changes nothing');
  t.equal(await count(db, 'inactive_market_events'), 4, 'and records nothing');

  t.same(
    [ await count(db, 'deprecated_collaterals'), await count(db, 'deprecated_collateral_events'), await count(db, 'hidden_collaterals'), await count(db, 'hidden_collateral_events') ],
    [ 1, 1, 1, 1 ],
    'while the decisions about collaterals are the ones made by hand, which none of it changed',
  );
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});

/*
 * A decision is about a market the active version holds, whatever its
 * status, as the decisions about collaterals are: one about a disabled
 * market, which nobody is offered, applies once a version serves it.
 */
t.test('a disabled market is decided about, and listed, as any market of the version', async t => {
  await activeWith(snapshot.networks.map(network => network !== mainnet ? network : {
    ...network,
    markets: network.markets.map(market => market.contracts.comet === WETH ? { ...market, status: 'disabled' as const } : market),
  }));

  const decided = await admin.patch<{ isInactive: boolean, changed: boolean }>(INACTIVE_MARKETS.path(1, { cometAddress: WETH }),
    { isInactive: true, reason: 'decided while disabled' });
  t.same([ decided.status, decided.body.isInactive, decided.body.changed ], [ 200, true, true ], 'WETH\'s market, disabled, is marked inactive');
  const detail = await admin.read<InactiveMarketDetailV1>(INACTIVE_MARKETS.path(1, { cometAddress: WETH }));
  t.same([ detail.body.inActiveVersion, detail.body.isInactive ], [ true, true ], 'which the version holds, whatever its status');
  const exported = await admin.read<InactiveMarketListV1>(EXPORT);
  t.same(marked(exported.body.inactiveMarkets), [ '1/weth' ], 'and the export lists it with its decision');
});

/*
 * The first list of inactive markets applies where the version holds every
 * market it names, and the fixture holds Scroll's alone of them: review names
 * the other nine by the chain the fixture does not hold, and apply refuses
 * the file whole. Scroll's row applies as the file writes it, with the file's
 * reason.
 */
t.test('the first list of inactive markets is reviewed and applied as one', async t => {
  const { db } = await freshActive(harness, { activate: true });
  const list   = readSeedInactive();
  const unheld = list.inactiveMarkets.filter(row => row.chainId !== 534352)
    .map(({ chainId, cometAddress }, index) => ({ row: index + 1, chainId, cometAddress, problem: `chain ${chainId} is not part of the active registry` }));
  t.equal(unheld.length, 9, 'nine of its rows are on chains the fixture does not hold');

  const whole = await admin.post<InactiveMarketReviewV1>(REVIEW, readSeedInactiveText());
  t.equal(whole.status, 200, 'review takes the file as it is');
  t.same(whole.body.summary, { change: 10, unchanged: 0, problems: 9 }, 'every row changes, and nine cannot be applied');
  t.same(
    whole.body.inactiveMarkets.filter(row => row.problem !== null).map(({ row, chainId, cometAddress, problem }) => ({ row, chainId, cometAddress, problem })),
    unheld,
    'the nine of Unichain, Polygon, Ronin, Mantle and Linea, which the fixture does not hold',
  );
  t.same(whole.body.inactiveMarkets.find(row => row.chainId === 534352),
    { row: 10, chainId: 534352, cometAddress: SCROLL, deploymentKey: 'usdc', current: false, requested: true, action: 'change', reason: list.reason, problem: null },
    'while Scroll\'s resolves to the market the fixture holds, with the file\'s reason');

  const refused = await admin.post<Refused>(APPLY, readSeedInactiveText());
  t.equal(refused.status, 422, 'so apply refuses the file');
  t.same(refused.body.error.details?.problems, unheld, 'naming the same nine');
  t.equal(await count(db, 'inactive_market_events'), 0, 'and neither writes anything');

  const scroll  = { reason: list.reason, inactiveMarkets: list.inactiveMarkets.filter(row => row.chainId === 534352) };
  const applied = await admin.post<InactiveMarketApplyV1>(APPLY, scroll);
  t.same([ applied.status, applied.body.summary ], [ 200, { changed: 1, unchanged: 0 } ], 'Scroll\'s row alone applies');
  t.same((await db.prepare(`SELECT chain_id, comet_address, is_inactive, reason, actor FROM inactive_market_events`).all()).results,
    [ { chain_id: 534352, comet_address: SCROLL, is_inactive: 1, reason: list.reason, actor: ADMIN_ACTOR } ],
    'with the file\'s reason');
  const again = await admin.post<InactiveMarketApplyV1>(APPLY, scroll);
  t.same(again.body.summary, { changed: 0, unchanged: 1 }, 'and applying it again changes nothing');
});

/*
 * Production holds one Comet at the same address on two chains, Base's USDbC
 * and Arbitrum's USDC (registry/seed/production.comets.json): a decision is
 * about a Comet on its own chain, so the two are two markets, decided apart.
 * Here Base's one market takes the Comet of mainnet's USDT market. A list
 * that leaves one of the two as it is expects that one's decision, not the
 * other's. A version that drops one of the two keeps that one's decision
 * apart, as it stands, though it holds the Comet on the other chain, and
 * lists the other with its own. That list is applied, and those versions are
 * switched on and exported, through the repository, which spends nothing of
 * the limiter's budget.
 */
t.test('one Comet on two chains is two markets, each decided apart', async t => {
  const networks = snapshot.networks.map(network => network.chainId !== 8453 ? network : {
    ...network,
    markets: network.markets.map(market => ({ ...market, contracts: { ...market.contracts, comet: USDT } })),
  });
  const { db } = await activeWith(networks);
  const onMainnet = INACTIVE_MARKETS.path(1, { cometAddress: USDT });
  const onBase    = INACTIVE_MARKETS.path(8453, { cometAddress: USDT });
  const inForce   = async () => (await admin.read<InactiveMarketListV1>(EXPORT)).body.inactiveMarkets
    .filter(row => row.cometAddress === USDT).map(row => [ row.chainId, row.deploymentKey, row.isInactive ]);

  t.equal((await admin.patch(onMainnet, { isInactive: true, reason: 'decided on mainnet' })).status, 200, 'mainnet\'s USDT market is marked inactive');
  t.same(await inForce(), [ [ 1, 'usdt', true ], [ 8453, 'aero', false ] ], 'and the export lists Base\'s market, of the same Comet, as not inactive');
  const base = await admin.read<InactiveMarketDetailV1>(onBase);
  t.same([ base.body.inActiveVersion, base.body.isInactive, base.body.events ], [ true, false, [] ], 'as Base\'s own decision says');

  const decidedOnBase = await admin.patch<InactiveMarketResultV1>(onBase, { isInactive: true, reason: 'decided on Base' });
  t.equal(decidedOnBase.status, 200);
  const takenBack = await admin.patch<InactiveMarketResultV1>(onMainnet, { isInactive: false, reason: 'taken back on mainnet' });
  t.equal(takenBack.status, 200);
  t.same(await inForce(), [ [ 1, 'usdt', false ], [ 8453, 'aero', true ] ], 'and the other way round');
  const back = await admin.read<InactiveMarketDetailV1>(onMainnet);
  t.same([ back.body.isInactive, back.body.events.map(event => event.reason) ], [ false, [ 'taken back on mainnet', 'decided on mainnet' ] ],
    'each with a history of its own');
  t.same((await db.prepare(`SELECT chain_id, comet_address, is_inactive FROM inactive_markets ORDER BY chain_id`).all()).results,
    [ { chain_id: 1, comet_address: USDT, is_inactive: 0 }, { chain_id: 8453, comet_address: USDT, is_inactive: 1 } ],
    'and a row of its own');
  const leftAsItIs = await applyInactiveMarkets(db, {
    reason:    null,
    decisions: [ { chainId: 8453, cometAddress: USDT, deploymentKey: null, isInactive: true, reason: null } ],
  }, ADMIN_ACTOR);
  t.same(leftAsItIs.summary, { changed: 0, unchanged: 1 }, 'a list that leaves Base\'s market as it is applies, expecting Base\'s decision, not mainnet\'s');

  // a version of these networks switched on, then what the export lists of the Comet, and the decisions it keeps apart
  const under = async (held: NetworkV1[]) => {
    const versionId = await seedValidated(db, { networks: held, versionId: randomUUID() });
    await activateVersion(db, { versionId, action: 'activate', actor: 'test-seed', reason: 'seeded for a test' });
    const { inactiveMarkets, retained } = await exportInactiveMarkets(db);
    return { listed: inactiveMarkets.filter(row => row.cometAddress === USDT).map(row => [ row.chainId, row.deploymentKey, row.isInactive ]), retained };
  };
  const withoutBase = await under(networks.filter(network => network.chainId !== 8453));
  t.same(withoutBase.listed, [ [ 1, 'usdt', false ] ], 'a version without Base lists mainnet\'s market with its own decision');
  t.same(withoutBase.retained, [ { chainId: 8453, cometAddress: USDT, isInactive: true, updatedAt: decidedOnBase.body.updatedAt, updatedBy: ADMIN_ACTOR } ],
    'and keeps Base\'s apart, though mainnet still holds the Comet');
  const withoutUsdt = await under(networks.map(network => network.chainId !== 1 ? network : {
    ...network,
    markets: network.markets.filter(market => market.contracts.comet !== USDT),
  }));
  t.same(withoutUsdt.listed, [ [ 8453, 'aero', true ] ], 'one without mainnet\'s USDT market lists Base\'s with its own');
  t.same(withoutUsdt.retained, [ { chainId: 1, cometAddress: USDT, isInactive: false, updatedAt: takenBack.body.updatedAt, updatedBy: ADMIN_ACTOR } ],
    'and keeps mainnet\'s apart, taken back as it was, though Base still holds the Comet');
});
