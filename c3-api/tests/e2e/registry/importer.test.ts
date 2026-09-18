import t from 'tap';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type * as jsonRpc from '../../../lib/json-rpc.js';

import { runInvocation } from '../../../src/registry/importer.js';
import { gitBlobSha } from '../../../src/registry/source/github.js';
import { readSnapshot, recordValidationResults, markValidated, snapshotChecksum } from '../../../src/registry/repository.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * The whole import, end to end against real local D1: discovery, the fenced
 * run, per-root checkpoints, chain reads, the inherited overlay, and
 * validation. GitHub and the chain are stubbed from recorded fixtures, so the
 * test exercises the orchestration rather than the network.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

async function freshDatabase(): Promise<D1Database> {
  await server.reset();
  const { APP_DB } = await server.getWorker<Env>().getEnv();
  await applyMigrations(APP_DB);
  return APP_DB;
}

const COMMIT     = 'a34d9b571c833b5d77f052ab8e2dbdbe10df726d';
const REPOSITORY = 'Compound-Foundation/comet';
const USDC_ROOT  = 'deployments/mainnet/usdc/roots.json';
const WETH_ROOT  = 'deployments/mainnet/weth/roots.json';

const snapshot    = loadRegistrySnapshotFixture();
const usdcContent = readFileSync('./tests/fixtures/registry/source/roots/mainnet-usdc.json', 'utf8');
const wethContent = JSON.stringify({
  comet:        '0xA17581A9E3356d9A858b789D68B4d866e593aE94',
  configurator: '0x316f9708bB98af7dA9c68C1C3b5e79039cD336E3',
  rewards:      '0x1B0e765F6224C21223AeA2af16c1C46E38885a40',
});
const recording: { responses: Record<string, string> } =
  JSON.parse(readFileSync('./tests/fixtures/registry/chain/ethereum-mainnet-usdc.json', 'utf8'));

// the reward feed the reviewed overlay names is not one enrichment reads by
// itself, so its decimals are answered here
const REWARD_FEED = snapshot.networks
  .find(network => network.chainId === 1)!.markets
  .find(market => market.deploymentKey === 'usdc')!.rewardAsset!.priceFeed!;

function word(value: number): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function githubStub(roots: Array<{ path: string, content: string, sha: string }>) {
  const requests: string[] = [];
  const fetch = async (url: string) => {
    requests.push(url);
    if (url.endsWith(`/commits/main`)) {
      return new Response(COMMIT);
    }
    if (url.includes('/git/trees/')) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: roots.map(root => ({ path: root.path, type: 'blob', sha: root.sha, size: root.content.length })),
      }));
    }
    const root = roots.find(candidate => url.endsWith(candidate.path));
    return root === undefined ? new Response('not found', { status: 404 }) : new Response(root.content);
  };
  return { fetch, requests };
}

/*
 * Answers from the recorded mainnet responses. Anything the recording does
 * not cover throws, which is how a market the chain cannot answer for is
 * exercised.
 */
function chainStub() {
  const transport = async (calls: jsonRpc.Call[]) => calls.map(call => {
    const key = call.method === 'eth_chainId' ? 'eth_chainId'
      : call.method === 'eth_getCode' ? `eth_getCode:${call.params[0]}`
      : `eth_call:${call.params[0].to}:${call.params[0].data}`;

    // decimals() of the reward feed named by the overlay
    if (key === `eth_call:${REWARD_FEED.address}:0x313ce567`) {
      return { result: word(REWARD_FEED.decimals) };
    }
    const result = recording.responses[key];
    if (result === undefined) {
      throw new Error(`the chain has no recorded answer for ${key}`);
    }
    return { result };
  });
  return transport;
}

function deps(db: D1Database, roots: Array<{ path: string, content: string, sha: string }>, marketsPerInvocation = 2) {
  const github = githubStub(roots);
  return {
    db,
    source: { repository: REPOSITORY, ref: 'main', fetch: github.fetch },
    transportFor: () => chainStub(),
    config: {
      leaseSeconds:            900,
      marketsPerInvocation,
      upstreamIntervalSeconds: 86400,
    },
    actor: 'registry-cron',
  };
}

/*
 * The overlay an import inherits comes from the active version, so the
 * fixture is seeded and activated first: this is the second import of a
 * registry, which is the normal case.
 */
async function activateFixture(db: D1Database): Promise<string> {
  const { versionId } = await seedCandidate(db, snapshot);
  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, await snapshotChecksum(snapshot.networks));
  await db.batch([
    db.prepare(
      `INSERT INTO registry_activations (id, registry_version_id, previous_version_id, action, actor, reason, created_at)
       SELECT ?1, ?2, active_version_id, 'activate', 'test-admin', 'test', ?3 FROM registry_state WHERE singleton_id = 1`
    ).bind(randomUUID(), versionId, new Date().toISOString()),
    db.prepare(`UPDATE registry_state SET active_version_id = ?1, updated_at = ?2 WHERE singleton_id = 1`)
      .bind(versionId, new Date().toISOString()),
  ]);
  return versionId;
}

t.test('an import reads the source, the chain, and the reviewed overlay', async t => {
  const db = await freshDatabase();
  await activateFixture(db);

  const usdcSha = await gitBlobSha(usdcContent);
  const result  = await runInvocation(deps(db, [ { path: USDC_ROOT, content: usdcContent, sha: usdcSha } ]));

  t.equal(result.status, 'completed', 'the run finishes');
  t.equal(result.outcome, 'imported', 'with a new version');
  t.equal(result.processed, 1, 'having imported one market');

  const candidate = await db.prepare(
    `SELECT * FROM registry_versions WHERE id = ?1`
  ).bind(result.versionId).first<{ status: string, source_commit_sha: string, source_checksum: string, snapshot_checksum: string }>();
  t.equal(candidate?.status, 'validated', 'the candidate validated');
  t.equal(candidate?.source_commit_sha, COMMIT, 'and records the commit it was built from');
  t.match(candidate?.source_checksum, /^[0-9a-f]{64}$/, 'with the checksum of the pinned roots');

  const [ network ] = await readSnapshot(db, result.versionId!);
  t.equal(network?.chainId, 1);
  t.equal(network?.markets.length, 1, 'the candidate holds the imported market');

  const market = network!.markets[0]!;
  const fixture = snapshot.networks.find(entry => entry.chainId === 1)!.markets.find(entry => entry.deploymentKey === 'usdc')!;
  t.equal(market.deploymentKey, 'usdc');
  t.equal(market.baseAsset.token.symbol, 'USDC', 'the base asset comes from the chain');
  t.equal(market.collateralAssets.length, 13, 'with every collateral asset the Comet reports');
  t.same({
    displayName:  market.displayName,
    contractName: market.contractName,
    isDefault:    market.isDefault,
    status:       market.status,
    capabilities: market.capabilities,
  }, {
    displayName:  fixture.displayName,
    contractName: fixture.contractName,
    isDefault:    fixture.isDefault,
    status:       fixture.status,
    capabilities: fixture.capabilities,
  }, 'and the reviewed decisions inherited from the active version');
  t.same(market.rewardAsset?.priceFeed, REWARD_FEED, 'the overlay feed is read for its decimals');

  const run = await db.prepare(`SELECT * FROM sync_runs WHERE id = ?1`).bind(result.runId).first<{
    status: string, outcome: string, completed_count: number, registry_version_id: string,
  }>();
  t.equal(run?.status, 'completed');
  t.equal(run?.completed_count, 1, 'every root is checkpointed as done');
  t.equal(run?.registry_version_id, result.versionId, 'and the run names the version it produced');
});

t.test('an already imported commit is a no-change outcome', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const usdcSha = await gitBlobSha(usdcContent);
  const roots   = [ { path: USDC_ROOT, content: usdcContent, sha: usdcSha } ];

  const first = await runInvocation(deps(db, roots));
  t.equal(first.outcome, 'imported');

  // discovery is bounded, so the next invocation does not even ask upstream
  const idle = await runInvocation(deps(db, roots));
  t.equal(idle.status, 'idle', 'nothing is due');
  t.equal(idle.reason, 'upstream was checked recently');

  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1`).bind('2020-01-01T00:00:00.000Z').run();
  const unchanged = await runInvocation(deps(db, roots));
  t.equal(unchanged.status, 'completed');
  t.equal(unchanged.outcome, 'no_change', 'the same commit is not imported twice');
  t.equal(unchanged.versionId, first.versionId, 'the existing version is reported instead');
});

t.test('an import continues across invocations', async t => {
  const db = await freshDatabase();
  await activateFixture(db);

  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];
  // one market per invocation, as the Cron configuration bounds it
  const first = await runInvocation(deps(db, roots, 1));
  t.equal(first.status, 'running', 'the run stays open while roots remain');
  t.equal(first.processed, 1, 'and only the configured number of markets is imported');

  const held = await db.prepare(`SELECT lease_owner FROM sync_runs WHERE id = ?1`).bind(first.runId)
    .first<string | null>('lease_owner');
  t.equal(held, null, 'the lease is released, so the next invocation continues at once');

  const second = await runInvocation(deps(db, roots, 1));
  t.equal(second.runId, first.runId, 'the next invocation resumes the same run');
  t.equal(second.versionId, first.versionId, 'and the same candidate');

  const items = await db.prepare(
    `SELECT root_path, status, attempts, last_error FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`
  ).bind(first.runId).all<{ root_path: string, status: string, attempts: number, last_error: string | null }>();
  t.same(
    (items.results ?? []).map(item => [ item.root_path, item.status ]),
    [ [ USDC_ROOT, 'completed' ], [ WETH_ROOT, 'failed' ] ],
    'the market the chain could not answer for is checkpointed as failed',
  );
  const failure = (items.results ?? []).find(item => item.root_path === WETH_ROOT)?.last_error;
  t.match(failure, /^CHAIN_REQUEST_FAILED: /, 'its diagnostic is classified by what went wrong');
  t.notMatch(failure, /recorded answer/, 'and carries no upstream message');
});

t.test('a root that never imports cannot produce a validated version', async t => {
  const db = await freshDatabase();
  await activateFixture(db);

  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];

  /*
   * The chain cannot answer for weth, so that root fails every attempt. Once
   * it exhausts them it stops being outstanding work, and the run finishes —
   * but the candidate is missing a market and must not validate.
   */
  let result = await runInvocation(deps(db, roots, 2));
  for (let invocation = 0; invocation < 10 && result.status === 'running'; invocation++) {
    result = await runInvocation(deps(db, roots, 2));
  }

  t.equal(result.status, 'failed', 'the run ends as failed');
  const version = await db.prepare(`SELECT status FROM registry_versions WHERE id = ?1`)
    .bind(result.versionId).first<string>('status');
  t.equal(version, 'invalid', 'and the candidate is invalid, not validated');

  const failed = await db.prepare(
    `SELECT check_name, details FROM validation_results
     WHERE registry_version_id = ?1 AND passed = 0 AND check_name = 'all-roots-imported'`
  ).bind(result.versionId).first<{ check_name: string, details: string }>();
  t.ok(failed, 'the diagnostic names the incomplete import');
  t.same(JSON.parse(failed?.details ?? '{}'), { expected: 2, imported: 1 }, 'and says how many roots made it');

  t.equal(
    await db.prepare(`SELECT COUNT(*) AS n FROM markets WHERE registry_version_id = ?1`)
      .bind(result.versionId).first<number>('n'),
    1,
    'the market that did import is kept for review',
  );
});

t.test('a market without a reviewed overlay is refused', async t => {
  const db = await freshDatabase();
  // no active version, so nothing is inherited: the first import of a
  // registry has to be reviewed before it can validate
  const usdcSha = await gitBlobSha(usdcContent);
  const result  = await runInvocation(deps(db, [ { path: USDC_ROOT, content: usdcContent, sha: usdcSha } ]));

  t.equal(result.status, 'running', 'the run remains open for a retry');
  const item = await db.prepare(
    `SELECT status, last_error FROM sync_run_items WHERE sync_run_id = ?1`
  ).bind(result.runId).first<{ status: string, last_error: string }>();
  t.equal(item?.status, 'failed');
  t.match(item?.last_error, /OVERLAY_MISSING/, 'the checkpoint says what is missing');
  t.match(item?.last_error, /must be reviewed/, 'and why it cannot be imported');
});
