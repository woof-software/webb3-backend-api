import t from 'tap';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type * as jsonRpc from '../../../lib/json-rpc.js';
import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { runInvocation } from '../../../src/registry/importer.js';
import {
  FeedReader,
  replaceMarketOverlay,
  replaceNetworkOverlay,
  validateStoredVersion,
} from '../../../src/registry/admin.js';
import { gitBlobSha } from '../../../src/registry/source/github.js';
import {
  markValidated,
  readSnapshot,
  readUnreviewed,
  readValidationSummary,
  recordValidationResults,
  snapshotChecksum,
} from '../../../src/registry/repository.js';

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
async function activateFixture(db: D1Database, source: RegistrySnapshotV1 = snapshot): Promise<string> {
  const { versionId } = await seedCandidate(db, source);
  await recordValidationResults(db, versionId, 1, [ { check_name: 'seeded', scope: 'global', passed: 1 } ]);
  await markValidated(db, versionId, await snapshotChecksum(source.networks));
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
    displayName:     market.displayName,
    contractName:    market.contractName,
    slug:            market.slug,
    isInstitutional: market.isInstitutional,
    isDefault:       market.isDefault,
    status:          market.status,
    capabilities:    market.capabilities,
  }, {
    displayName:     fixture.displayName,
    contractName:    fixture.contractName,
    slug:            fixture.slug,
    isInstitutional: fixture.isInstitutional,
    isDefault:       fixture.isDefault,
    status:          fixture.status,
    capabilities:    fixture.capabilities,
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

/*
 * A market no version has reviewed is imported all the same. Its rows exist,
 * so they can be reviewed in place, but it is disabled with every capability
 * off until someone decides otherwise — and it does not fail the commit it
 * arrived with, which refusing it would.
 */
t.test('a market nobody has reviewed is imported, but not served', async t => {
  const db = await freshDatabase();

  /*
   * An active version that has never seen the usdc deployment, so the source
   * adds it: the same thing a new market in the Comet repository looks like.
   */
  await activateFixture(db, {
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets
        .filter(market => market.deploymentKey !== 'usdc')
        .map(market => market.deploymentKey === 'weth' ? { ...market, isDefault: true } : market),
    }),
  });

  const result = await runInvocation(deps(db, [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ]));
  t.equal(result.status, 'failed', 'this source holds nothing but the new market, so there is no default to validate');

  const market = await db.prepare(
    `SELECT deployment_key, status, is_default, reviewed, display_name,
            rewards_enabled, account_rewards_enabled, transaction_history_enabled
     FROM markets WHERE registry_version_id = ?1`
  ).bind(result.versionId).first<Record<string, unknown>>();
  t.same(market, {
    deployment_key:              'usdc',
    status:                      'disabled',
    is_default:                  0,
    reviewed:                    0,
    display_name:                'usdc',
    rewards_enabled:             0,
    account_rewards_enabled:     0,
    transaction_history_enabled: 0,
  }, 'the new market is imported disabled, named by its deployment key, with every capability off');

  const network = await db.prepare(
    `SELECT reviewed, display_name FROM registry_networks WHERE registry_version_id = ?1`
  ).bind(result.versionId).first<{ reviewed: number, display_name: string }>();
  t.same(network, { reviewed: 1, display_name: 'Ethereum' }, 'its network keeps the decisions the active version made');

  /*
   * The unreviewed market contributes no failure of its own: what this
   * version lacks is a default, which only a reviewed market can be. With the
   * rest of the source beside it, the commit would validate.
   */
  const summary = await readValidationSummary(db, result.versionId!);
  t.same(summary.checks.filter(check => !check.passed).map(check => check.name), [ 'single-default-market' ],
    'nothing about the unreviewed market fails');
});

/*
 * The first import of a registry, which is the one case where nothing can be
 * inherited: there is no active version to clone an overlay from. Every market
 * is imported unreviewed, and the run leaves the candidate open, because a
 * version of nothing but unreviewed markets could only ever end invalid.
 */
t.test('the first import of a registry is held for review, then reviewed in place', async t => {
  const db    = await freshDatabase();
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  const imported = await runInvocation(deps(db, roots));
  t.equal(imported.status, 'completed', 'every root is imported');
  t.equal(imported.held, true, 'and the candidate is held for review');

  const versionId = imported.versionId!;
  const status    = async () => db.prepare(`SELECT status FROM registry_versions WHERE id = ?1`)
    .bind(versionId).first<string>('status');
  t.equal(await status(), 'importing', 'so it stays open, where its rows can still be reviewed');
  t.same(await readUnreviewed(db, versionId), { networks: [ 1 ], markets: [ '1/usdc' ] },
    'and it says what is left to review');

  /*
   * Once discovery is due again, the same commit is found with a candidate
   * already importing. Starting a new attempt over it would throw away the
   * review in progress, so discovery leaves it alone.
   */
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1`).bind('2020-01-01T00:00:00.000Z').run();
  const again = await runInvocation(deps(db, roots));
  t.equal(again.status, 'idle', 'a later sync leaves a held candidate alone');
  t.match(again.reason, /held for review/, 'and says why');
  t.equal(again.versionId, versionId, 'naming the candidate it is waiting on');

  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  const usdc    = mainnet.markets.find(market => market.deploymentKey === 'usdc')!;
  const noFeeds: FeedReader = async () => new Map();

  await replaceNetworkOverlay(db, {
    versionId,
    chainId: 1,
    actor:   'test-admin',
    reason:  'bootstrap: review ethereum mainnet',
    overlay: {
      displayName:               mainnet.displayName,
      assetDisplayOverrides:     mainnet.presentation.assetDisplayOverrides,
      unwrappedCollateralAssets: mainnet.presentation.unwrappedCollateralAssets,
      priceExceptions:           mainnet.priceExceptions,
    },
  }, noFeeds);
  const reviewed = await replaceMarketOverlay(db, {
    versionId,
    chainId:       1,
    deploymentKey: 'usdc',
    actor:         'test-admin',
    reason:        'bootstrap: review the mainnet usdc market',
    overlay: {
      displayName:          usdc.displayName,
      contractName:         usdc.contractName,
      slug:                 usdc.slug,
      isInstitutional:      usdc.isInstitutional,
      isDefault:            usdc.isDefault,
      status:               usdc.status,
      creationBlock:        usdc.creationBlock,
      collateralValueQuote: usdc.collateralValueQuote,
      capabilities:         usdc.capabilities,
      baseAsset: {
        displayName:         usdc.baseAsset.displayName,
        isWrappedNative:     usdc.baseAsset.isWrappedNative,
        usdPriceFeedAddress: usdc.baseAsset.usdPriceFeed?.address ?? null,
      },
      rewardPriceFeed: { address: REWARD_FEED.address, quote: usdc.rewardAsset!.priceFeedQuote! },
    },
  }, async () => new Map([ [ REWARD_FEED.address, REWARD_FEED ] ]));
  t.equal(reviewed.changed, true, 'the review is applied to the rows the import wrote');
  t.same(await readUnreviewed(db, versionId), { networks: [], markets: [] }, 'and nothing is left unreviewed');

  const validated = await validateStoredVersion(db, versionId);
  t.equal(validated.version.status, 'validated', 'so the first version of the registry validates');

  const [ stored ] = await readSnapshot(db, versionId);
  t.same({
    displayName:  stored?.markets[0]?.displayName,
    contractName: stored?.markets[0]?.contractName,
    isDefault:    stored?.markets[0]?.isDefault,
    capabilities: stored?.markets[0]?.capabilities,
  }, {
    displayName:  usdc.displayName,
    contractName: usdc.contractName,
    isDefault:    usdc.isDefault,
    capabilities: usdc.capabilities,
  }, 'carrying the decisions that were reviewed for it');
});

/*
 * A candidate that is importing means one of two things, and they need
 * opposite answers: nobody is working on it and it is waiting for review, or
 * another invocation is importing into it right now. Telling the second one
 * to "validate it or force a new attempt" would invite an operator to
 * restart a run that is in progress.
 */
t.test('a candidate another invocation is importing is not one held for review', async t => {
  const db    = await freshDatabase();
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  const imported  = await runInvocation(deps(db, roots));
  const versionId = imported.versionId!;
  t.equal(imported.held, true, 'the first import of a registry is held');
  t.ok((imported.checksFailed ?? 0) > 0, 'and says how many of its checks failed');
  t.match(imported.reason, /checks failed/, 'so an operator is not told only that it completed');

  // another invocation, importing into that same candidate, with a live lease
  await db.prepare(
    `INSERT INTO sync_runs (
       id, source_commit_sha, tracked_ref, registry_version_id, trigger_kind,
       status, lease_owner, lease_generation, lease_expires_at, expected_count, started_at
     ) VALUES (?1, ?2, 'main', ?3, 'scheduled', 'running', ?4, 1, ?5, 1, ?6)`
  ).bind(
    randomUUID(), COMMIT, versionId, randomUUID(),
    new Date(Date.now() + 900_000).toISOString(), new Date().toISOString(),
  ).run();
  await db.prepare(`UPDATE registry_state SET last_upstream_checked_at = ?1`).bind('2020-01-01T00:00:00.000Z').run();

  await t.rejects(
    runInvocation(deps(db, roots)),
    { code: 'SYNC_ALREADY_RUNNING' },
    'the caller hears that a sync is running, not that the candidate awaits review',
  );
});

/*
 * A review happens in place, so a candidate that ends invalid is frozen with
 * the reviews in it. Rebuilding the same source must not mean reviewing every
 * market again.
 */
t.test('a new attempt at the same commit inherits what was reviewed for the last one', async t => {
  const db    = await freshDatabase();
  const roots = [ { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) } ];

  const first  = await runInvocation(deps(db, roots));
  const mainnet = snapshot.networks.find(network => network.chainId === 1)!;
  await replaceNetworkOverlay(db, {
    versionId: first.versionId!,
    chainId:   1,
    actor:     'test-admin',
    reason:    'reviewed for the attempt that is about to fail',
    overlay: {
      displayName:               mainnet.displayName,
      assetDisplayOverrides:     mainnet.presentation.assetDisplayOverrides,
      unwrappedCollateralAssets: mainnet.presentation.unwrappedCollateralAssets,
      priceExceptions:           mainnet.priceExceptions,
    },
  }, async () => new Map());

  // validated before the market was reviewed: no default market, so invalid
  const failed = await validateStoredVersion(db, first.versionId!);
  t.equal(failed.version.status, 'invalid');

  const next = await runInvocation(deps(db, roots), { forceNewAttempt: true, reason: 'rebuild after review' });
  t.not(next.versionId, first.versionId, 'a new attempt is a new candidate');

  const [ network ] = await readSnapshot(db, next.versionId!);
  t.equal(network?.displayName, mainnet.displayName, 'which carries the network the previous attempt reviewed');
  t.same(await readUnreviewed(db, next.versionId!), { networks: [], markets: [ '1/usdc' ] },
    'and still lists the market nobody reviewed');
});

/*
 * The Cron imports a couple of markets an hour. An operator bringing an
 * environment up asks for the whole source at once — but a failing root is
 * still attempted once per request, never retried inside it.
 */
t.test('one invocation can import the whole source, one attempt per root', async t => {
  const db = await freshDatabase();
  await activateFixture(db);
  const roots = [
    { path: USDC_ROOT, content: usdcContent, sha: await gitBlobSha(usdcContent) },
    { path: WETH_ROOT, content: wethContent, sha: await gitBlobSha(wethContent) },
  ];

  const result = await runInvocation(deps(db, roots, 1), { markets: 50 });
  t.equal(result.processed, 2, 'both roots in one invocation, despite a batch of one configured');

  const attempts = await db.prepare(
    `SELECT root_path, attempts FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`
  ).bind(result.runId).all<{ root_path: string, attempts: number }>();
  t.same((attempts.results ?? []).map(item => item.attempts), [ 1, 1 ],
    'and the root the chain cannot answer for was tried once, not retried until it ran out');
});
