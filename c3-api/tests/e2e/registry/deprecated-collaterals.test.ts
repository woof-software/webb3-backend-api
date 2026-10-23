import t from 'tap';

import { readFileSync } from 'node:fs';

import type {
  ActiveMarketV1,
  DeprecatedCollateralApplyV1,
  DeprecatedCollateralListV1,
  DeprecatedCollateralReviewV1,
} from '../../../lib/model/comet-registry.js';

import { foreignKeyViolations } from '../../util/d1.js';
import { ADMIN_ACTOR, adminClient, count, seedValidated } from '../../util/registry-admin.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { registryHarness } from '../../util/registry-harness.js';

import { DEPRECATED_COLLATERALS, decisionScenarios } from './decision-scenarios.js';

/*
 * Deprecated collaterals, through the real worker in workerd over local D1.
 * What every kind of decision does is in decision-scenarios.ts, run here for
 * deprecated collaterals: a decision and its audit, idempotency under a race,
 * survival across activations, the database guard against an activation
 * that races a write, a list refused for its problems or for a race, and the
 * market reads that flag a deprecated collateral. Beside them, the test of
 * deprecated collaterals alone: the seed document of the runbook, reviewed,
 * applied and exported through the deprecated-collaterals routes.
 *
 * Refusals of malformed requests are in deprecated-collateral-routes.test.ts,
 * and what the active reads answer in deprecated-collateral-reads.test.ts.
 */
const harness = await registryHarness({ admin: true, vars: { COMET_REGISTRY_ADMIN_ACTOR: ADMIN_ACTOR } });
const admin   = adminClient(harness.server);

decisionScenarios(harness, DEPRECATED_COLLATERALS);

const snapshot = loadRegistrySnapshotFixture();
const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;

// a market of the fixture's mainnet by its deployment key, and a collateral of it by symbol
const comet = (key: string) => mainnet.markets.find(market => market.deploymentKey === key)!.contracts.comet!;
const collateral = (key: string, symbol: string) => mainnet.markets.find(market => market.deploymentKey === key)!
  .collateralAssets.find(asset => asset.token.symbol === symbol)!.token.address;

const USDT = comet('usdt');
const USDC = comet('usdc');
const WETH = comet('weth');
const METH = collateral('usdt', 'mETH');

// the collaterals a public market read flags deprecated, by symbol
async function flagged(market: string): Promise<string[]> {
  const { body } = await admin.read<{ market: ActiveMarketV1 }>(`/registry/v1/networks/1/markets/${market}`, {});
  return body.market.collateralAssets.filter(asset => asset.isDeprecated).map(asset => asset.token.symbol);
}

const REVIEW = DEPRECATED_COLLATERALS.list.review;
const APPLY  = DEPRECATED_COLLATERALS.list.apply;

/*
 * The document the runbook gives an operator to apply once per environment:
 * the first JSON block under its heading, read as the operator copies it.
 */
function seedDocument(): DeprecatedCollateralListV1 {
  const runbook = readFileSync('./REGISTRY_RUNBOOK.md', 'utf8');
  const section = runbook.slice(runbook.indexOf('### The initial list of deprecated collaterals'));
  return JSON.parse(/```json\n([\s\S]*?)\n```/.exec(section)![1]!);
}

/*
 * The seed document of the runbook applies to the fixture, whose mainnet
 * holds the USDC, WETH, USDT and WBTC markets: exactly as written, with every
 * address resolved, the Comets' deployment keys and the tokens' symbols
 * checked, and nothing else touched. The export is a file review and apply
 * take back as it is.
 */
t.test('the seed document of the runbook is reviewed and applied as one', async t => {
  const db        = await harness.freshDatabase();
  const versionId = await seedValidated(db);
  await admin.switchTo(versionId);
  const seed = seedDocument();

  t.same(
    seed.collaterals.map(row => `${row.deploymentKey}/${row.symbol}`),
    [
      'usdt/mETH', 'usdt/weETH', 'usdt/sdeUSD', 'usdt/wUSDM', 'usdt/deUSD', 'usdt/USDe',
      'usdc/rsETH', 'usdc/USDe', 'usdc/deUSD', 'usdc/sdeUSD',
      'wbtc/LBTC', 'wbtc/pumpBTC',
    ],
    'the document names the twelve pairs the repository resolves, in the order the frontend lists them',
  );
  t.ok(seed.collaterals.every(row => row.chainId === 1 && row.isDeprecated === true), 'all on mainnet, all deprecated');

  const review = await admin.post<DeprecatedCollateralReviewV1>(REVIEW, seed);
  t.equal(review.status, 200);
  t.same(review.body.summary, { change: 12, unchanged: 0, problems: 0 }, 'every pair is a collateral of its Comet, and changes');
  t.equal(await count(db, 'deprecated_collateral_events'), 0, 'and the review writes nothing');

  const applied = await admin.post<DeprecatedCollateralApplyV1>(APPLY, seed);
  t.equal(applied.status, 200);
  t.same(applied.body.summary, { changed: 12, unchanged: 0 }, 'applying writes exactly the reviewed changes');
  t.equal(applied.header('x-registry-version'), versionId);
  t.same(
    (await db.prepare(`SELECT DISTINCT reason FROM deprecated_collateral_events`).all<{ reason: string }>()).results?.map(row => row.reason),
    [ seed.reason ],
    'each with the document\'s reason',
  );
  t.same(await flagged(USDT), [ 'wUSDM', 'mETH', 'weETH', 'sdeUSD', 'deUSD', 'USDe' ], 'the USDT market flags its six');
  t.same(await flagged(USDC), [ 'deUSD', 'sdeUSD', 'rsETH', 'USDe' ], 'the USDC market its four, and not its weETH');
  t.same(await flagged(WETH), [], 'and the WETH market, which the list does not name, none');

  const again = await admin.post<DeprecatedCollateralApplyV1>(APPLY, seed);
  t.same(again.body.summary, { changed: 0, unchanged: 12 }, 'applying the document again changes nothing');
  t.equal(await count(db, 'deprecated_collateral_events'), 12, 'and records nothing');

  const exported = await admin.read<DeprecatedCollateralListV1>(DEPRECATED_COLLATERALS.list.export);
  t.equal(exported.status, 200);
  t.equal(exported.header('x-registry-version'), versionId, 'the export names the version it lists');
  t.equal(exported.body.reason, null, 'with a place for the reason of the changes');
  const every = mainnet.markets.flatMap(market => market.collateralAssets.map(asset => `${market.contracts.comet}:${asset.token.address}`));
  t.same(exported.body.collaterals.filter(row => row.chainId === 1).map(row => `${row.cometAddress}:${row.tokenAddress}`).sort(), every.sort(),
    'and every collateral of every market of mainnet, once');
  t.same(exported.body.collaterals.filter(row => row.isDeprecated).length, 12, 'twelve of them deprecated');
  t.same(exported.body.collaterals.find(row => row.cometAddress === USDT && row.tokenAddress === METH),
    { chainId: 1, cometAddress: USDT, deploymentKey: 'usdt', tokenAddress: METH, symbol: 'mETH', isDeprecated: true },
    'each with its market, its symbol, and the decision in force');

  const untouched = await admin.post<DeprecatedCollateralReviewV1>(REVIEW, exported.body);
  t.equal(untouched.status, 200, 'the export is a list review takes back as it is');
  t.same(untouched.body.summary, { change: 0, unchanged: exported.body.collaterals.length, problems: 0 }, 'and it changes nothing');
  t.same(await foreignKeyViolations(db), [], 'no foreign key violations');
});
