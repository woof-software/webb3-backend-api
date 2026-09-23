import t from 'tap';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import { sha256Hex } from '../../../src/http/bearer-auth.js';
import { markValidated, readSnapshot, readUnreviewed, recordValidationResults, snapshotChecksum } from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * The first review of an environment, as an operator does it: read the
 * proposal the deployed release makes for the candidate, then apply it by the
 * digest the review names. Nothing runs outside the Worker.
 *
 * The values the proposal derives are checked in
 * tests/lib/registry/bootstrap-overlays.test.ts; these tests are about the
 * routes — that what is read is what is applied, all of it or none.
 */
const ADMIN_TOKEN = 'registry-admin-token-for-tests';

const server = createTestHarness({
  workers: [ {
    configPath: './wrangler.toml',
    secrets:    { COMET_REGISTRY_ADMIN_TOKEN_HASH: await sha256Hex(ADMIN_TOKEN) },
  } ],
});

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

// a deployment the source has and the constants do not describe
const UNDESCRIBED = '0x5555555555555555555555555555555555555555';

/*
 * A candidate as the first import of an environment leaves it: every market
 * written, none reviewed — the fixture's six, and one the constants know
 * nothing about.
 */
async function unreviewedCandidate(): Promise<{ db: D1Database, versionId: string }> {
  await server.reset();
  const { APP_DB: db } = await server.getWorker<Env>().getEnv();
  await applyMigrations(db);

  const snapshot = loadRegistrySnapshotFixture();
  const mainnet  = snapshot.networks.find(network => network.chainId === 1)!;
  const usdt     = mainnet.markets.find(market => market.deploymentKey === 'usdt')!;
  mainnet.markets.push({
    ...structuredClone(usdt),
    id:            '00000000-0000-4000-8000-0000000005ff',
    deploymentKey: 'undescribed',
    isDefault:     false,
    creationBlock: usdt.creationBlock + 1,
    contracts:     { ...usdt.contracts, comet: UNDESCRIBED },
  });

  const { versionId } = await seedCandidate(db, snapshot);
  await db.batch([
    db.prepare(
      `UPDATE markets SET status = 'disabled', is_default = 0, reviewed = 0, display_name = deployment_key,
              contract_name = NULL, rewards_enabled = 0, account_rewards_enabled = 0,
              transaction_history_enabled = 0
       WHERE registry_version_id = ?1`
    ).bind(versionId),
    db.prepare(`UPDATE registry_networks SET reviewed = 0 WHERE registry_version_id = ?1`).bind(versionId),
  ]);
  return { db, versionId };
}

const auth = { 'Authorization': `Bearer ${ADMIN_TOKEN}` };

function apply(versionId: string, body: unknown): Promise<Response> {
  return server.fetch(`/registry/v1/admin/versions/${versionId}/proposal/apply`, {
    method:  'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }) as unknown as Promise<Response>;
}

type Proposal = {
  versionId:     string,
  digest:        string,
  needsDecision: Array<{ scope: string, field: string, reason: string }>,
  bundle:        { reason: string, networks: Record<string, unknown>, markets: Record<string, unknown> },
};

t.test('the proposal is read, and applied by the digest its review names', async t => {
  const { db, versionId } = await unreviewedCandidate();

  const proposal = await (await server.fetch(`/registry/v1/admin/versions/${versionId}/proposal`, { headers: auth })).json() as Proposal;
  t.match(proposal.digest, /^[0-9a-f]{16}$/, 'the proposal has a digest');
  t.same(Object.keys(proposal.bundle.networks).sort(), [ '1', '534352', '8453' ], 'a network overlay for every network');
  t.same(Object.keys(proposal.bundle.markets).sort(), [
    '1/usdc', '1/usdt', '1/wbtc', '1/weth', '534352/usdc', '8453/aero',
  ], 'and a market overlay for every market the constants describe');
  t.same(proposal.needsDecision.map(({ scope, field }) => [ scope, field ]), [
    [ 'undescribed on ethereum-mainnet', 'the whole market' ],
  ], 'the one they do not is not proposed, and is named as a decision to make');

  const review = await server.fetch(`/registry/v1/admin/versions/${versionId}/proposal/review`, { headers: auth });
  t.equal(review.status, 200);
  t.match(review.headers.get('content-type') ?? '', /^text\/markdown/, 'the review is a document to read');
  const text = await review.text();
  t.match(text, `**Digest: \`${proposal.digest}\`**`, 'naming the same digest');
  t.match(text, /undescribed on ethereum-mainnet/, 'and what it leaves undecided');

  const stale = await apply(versionId, { reason: 'bootstrap', digest: '0123456789abcdef' });
  t.equal(stale.status, 409, 'a digest that is not the proposal\'s is refused');
  t.same((await stale.json() as { error: { details: { digest: string } } }).error.details, { digest: proposal.digest },
    'with the digest of the proposal as it is now');
  t.same(await readUnreviewed(db, versionId), {
    networks: [ 1, 8453, 534352 ],
    markets:  [ '1/undescribed', '1/usdc', '1/usdt', '1/wbtc', '1/weth', '8453/aero', '534352/usdc' ],
  }, 'and nothing is written');

  const applied = await apply(versionId, { reason: 'bootstrap', digest: proposal.digest });
  t.equal(applied.status, 200, 'the digest that was read applies the proposal');
  const result = await applied.json() as { digest: string, changed: boolean, unreviewed: { networks: number[], markets: string[] } };
  t.equal(result.changed, true);
  t.same(result.unreviewed, { networks: [], markets: [ '1/undescribed' ] },
    'every proposed network and market is reviewed; the undescribed one stays switched off');

  const [ mainnet ] = await readSnapshot(db, versionId);
  const usdc = mainnet!.markets.find(market => market.deploymentKey === 'usdc')!;
  t.same({ label: usdc.displayName, contract: usdc.contractName, status: usdc.status, isDefault: usdc.isDefault },
    { label: 'USDC', contract: 'cUSDCv3', status: 'enabled', isDefault: true }, 'as the proposal decided');

  const again = await (await apply(versionId, { reason: 'bootstrap', digest: proposal.digest })).json() as { changed: boolean };
  t.equal(again.changed, false, 'applying it again changes nothing');
});

t.test('the apply route takes a digest and a reason, and an open candidate only', async t => {
  const { db, versionId } = await unreviewedCandidate();
  const { digest } = await (await server.fetch(`/registry/v1/admin/versions/${versionId}/proposal`, { headers: auth })).json() as Proposal;

  t.equal((await apply(versionId, { digest })).status, 400, 'a reason is required');
  t.equal((await apply(versionId, { reason: 'x', digest: 'not-a-digest' })).status, 400, 'and a digest of the right form');
  t.equal((await apply(versionId, { reason: 'x', digest, markets: {} })).status, 400, 'and nothing else');
  t.equal((await server.fetch(`/registry/v1/admin/versions/${versionId}/proposal`)).status, 401, 'the routes are authenticated');
  t.equal((await server.fetch('/registry/v1/admin/versions/00000000-0000-4000-8000-000000000999/proposal', { headers: auth })).status, 404);

  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, await snapshotChecksum(loadRegistrySnapshotFixture().networks));
  t.equal((await apply(versionId, { reason: 'too late', digest })).status, 409, 'a validated version can no longer be changed');
});
