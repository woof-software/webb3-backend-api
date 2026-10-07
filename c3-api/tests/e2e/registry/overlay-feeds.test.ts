import t from 'tap';

import { createTestHarness } from 'wrangler';

import type { Env } from '../../../entrypoint.js';
import type * as jsonRpc from '../../../lib/json-rpc.js';
import type { Address } from '../../../lib/model/comet-registry.js';

import { FeedReader, replaceMarketOverlay } from '../../../src/registry/admin.js';
import { readFeeds } from '../../../src/registry/enrichment.js';
import { asApiError } from '../../../src/registry/router.js';

import { applyMigrations } from '../../util/d1.js';
import { loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

/*
 * A feed an overlay introduces, read from the chain for its scale.
 *
 * What the chain answers decides whose problem it is. A feed that reverts,
 * or an address with no code on that chain — a feed of another chain is the
 * usual one — is the document naming something that is not a feed there:
 * the document has to change, which is a 422 naming the feed. A node that did
 * not serve the read says nothing about the document, and is a 503 worth
 * trying again.
 */
const server = createTestHarness({ workers: [ { configPath: './wrangler.toml' } ] });

t.before(async () => {
  await server.listen();
});
t.teardown(() => server.close());

const snapshot = loadRegistrySnapshotFixture();
const usdc     = snapshot.networks.find(network => network.chainId === 1)!.markets
  .find(market => market.deploymentKey === 'usdc')!;

// a reward feed the version has never stored, so its decimals are read from the chain
const FEED = '0x00000000000000000000000000000000000000f1' as Address;

async function freshCandidate(): Promise<{ db: D1Database, versionId: string }> {
  await server.reset();
  const { APP_DB: db } = await server.getWorker<Env>().getEnv();
  await applyMigrations(db);
  const { versionId } = await seedCandidate(db, snapshot);
  return { db, versionId };
}

// a chain that answers every read the way `answer` says, through the reader the importer uses
function chainAnswering(answer: { result: string } | { error: jsonRpc.Error }): FeedReader {
  const transport = async (calls: jsonRpc.Call[]) => calls.map(() => answer);
  return (network, addresses) => readFeeds(transport, addresses, network);
}

function rewardFeed(db: D1Database, versionId: string, readFeeds: FeedReader) {
  return replaceMarketOverlay(db, {
    versionId,
    chainId:       1,
    deploymentKey: 'usdc',
    actor:         'test-admin',
    reason:        'price the rewards with another feed',
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
      rewardPriceFeed: { address: FEED, quote: 'usd' },
    },
  }, readFeeds);
}

t.test('a feed the chain answers for, but not with decimals, is the document\'s to fix', async t => {
  const { db, versionId } = await freshCandidate();

  for (const [ what, answer ] of [
    [ 'a feed that reverts',                    { error: { code: 3, message: 'execution reverted' } } ],
    [ 'an address with no code on that chain',  { result: '0x' } ],
    [ 'an answer that does not decode',         { result: '0x1234' } ],
  ] as const) {
    const failure = await rewardFeed(db, versionId, chainAnswering(answer)).then(() => null, (error: unknown) => error as Error & { code?: string });
    t.equal(failure?.code, 'OVERLAY_FEED_UNREADABLE', `${what} is a feed the overlay cannot use`);
    t.match(failure?.message, FEED, 'naming the feed');
    t.equal(asApiError(failure)?.status, 422, 'which is answered 422, not as a provider that is down');
  }

  const limited = await rewardFeed(db, versionId, chainAnswering({ error: { code: -32005, message: 'limit exceeded' } }))
    .then(() => null, (error: unknown) => error as Error & { code?: string });
  t.equal(limited?.code, 'CHAIN_REQUEST_FAILED', 'a node that did not serve the read is not the document\'s mistake');
  t.equal(asApiError(limited)?.status, 503, 'and is answered 503, worth trying again');

  const written = await rewardFeed(db, versionId, chainAnswering({ result: `0x${(8).toString(16).padStart(64, '0')}` }));
  t.equal(written.changed, true, 'a feed that answers its decimals is written');
});
