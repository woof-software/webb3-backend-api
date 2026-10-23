import t from 'tap';

import { adminClient, count, freshActive } from '../../util/registry-admin.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { registryHarness } from '../../util/registry-harness.js';

import { DEPRECATED_COLLATERALS, decisionRouteScenarios } from './decision-scenarios.js';

/*
 * What the deprecated collateral routes refuse, through the real worker: a
 * caller without the token, a malformed request, a chain, a Comet or a
 * collateral the active registry does not hold, a registry with nothing
 * active, and a database without the migration. Every refusal writes
 * nothing. The routes of every kind of decision refuse alike, so the
 * scenarios are decision-scenarios.ts's, run here for deprecated
 * collaterals, beside the old paths only this kind had.
 *
 * The token list is among the reads refused for a missing migration, and it
 * values collateral beside reading its decisions, so the node is one that
 * refuses every connection: a developer's .dev.vars may name a real one.
 */
const harness = await registryHarness({
  admin: true,
  vars:  { NODE_PROXY_HOST: '127.0.0.1:1', NODE_PROXY_KEY: '' },
});
const admin = adminClient(harness.server);

decisionRouteScenarios(harness, DEPRECATED_COLLATERALS);

const snapshot = loadRegistrySnapshotFixture();
const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;
const market   = (key: string) => mainnet.markets.find(entry => entry.deploymentKey === key)!;
const USDT     = market('usdt').contracts.comet!;
// collateral of the USDT market alone
const METH     = market('usdt').collateralAssets.find(asset => asset.token.symbol === 'mETH')!.token.address;

type ErrorBody = { error: { code: string, message: string, details?: { problems?: string[] } } };

/*
 * Until migration 0007 these routes were …/legacy and
 * /admin/legacy-collaterals, with isLegacy. API.md and the runbook tell a
 * caller of the old ones that they are gone, so nothing may answer them in
 * place of the new ones, nor take the old flag.
 */
t.test('the paths and the flag of legacy collaterals are not taken any more', async t => {
  const { db } = await freshActive(harness, { activate: true });
  const oldPath = `/registry/v1/admin/networks/1/markets/${USDT}/collaterals/${METH}/legacy`;
  const oldList = { collaterals: [ { chainId: 1, cometAddress: USDT, tokenAddress: METH, isLegacy: true } ] };

  for (const [ name, response ] of [
    [ 'a read of one collateral', await admin.read<ErrorBody>(oldPath) ],
    [ 'a change',                 await admin.patch<ErrorBody>(oldPath, { isLegacy: true, reason: 'COM-18' }) ],
    [ 'the export',               await admin.read<ErrorBody>('/registry/v1/admin/legacy-collaterals') ],
    [ 'review',                   await admin.post<ErrorBody>('/registry/v1/admin/legacy-collaterals/review', oldList) ],
    [ 'apply',                    await admin.post<ErrorBody>('/registry/v1/admin/legacy-collaterals/apply', oldList) ],
  ] as const) {
    t.equal(response.status, 404, `${name} at the old path is not found`);
    t.equal(response.body.error.code, 'NOT_FOUND');
    t.match(response.body.error.message, /^no registry route matches \/registry\/v1\/admin\/.*legacy/, 'as a path no route takes');
  }

  const flag = await admin.patch<ErrorBody>(DEPRECATED_COLLATERALS.path(1, { cometAddress: USDT, tokenAddress: METH }), { isLegacy: true, reason: 'COM-18' });
  t.equal(flag.status, 400, 'a change that sends the old flag is refused');
  t.match(flag.body.error.message, /unexpected properties: isLegacy/);

  const row = await admin.post<ErrorBody>(DEPRECATED_COLLATERALS.list.review, oldList);
  t.equal(row.status, 400, 'and so is a list whose rows send it');
  t.same(row.body.error.details?.problems,
    [ 'row 1 has unexpected properties: isLegacy', 'row 1: isDeprecated must be a boolean' ]);

  t.equal(await count(db, 'deprecated_collateral_events') + await count(db, 'deprecated_collaterals'), 0, 'nothing was written');
});
