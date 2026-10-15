import t, { Test } from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';

import type { NetworkV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { failures, validateCandidate } from '../../../src/registry/validation.js';

import { consoleLines } from '../../util/console.js';
import { asked, fakeNode, serve } from '../../util/fake-node.js';
import { makeTestEnv } from '../../util/test-env.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { fixtureCatalog, loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

import '../../../shim/node-self.js';

/*
 * A market whose creation block is past the latest block of its chain has no
 * point in the index of any computation that reads it. A write of its
 * overlay holds the block against the chain (admin.ts), but a version can
 * hold one nobody checked — an overlay written before that check and
 * inherited by an import, or a row changed in the database without the API —
 * and validation does not read the chain, so such a version validates and is
 * switched on like any other.
 *
 * The market routes answer that market as `error`, naming the block, and
 * every other market as they read it, through the worker's own entry point
 * against a node that answers every read. Nothing else that fails one market
 * is answered so: a node that did not serve a read still fails the whole
 * answer with 503, and a read that reverts with 500.
 */
const LATEST = { number: 30_000_000, timestamp: 1_790_000_000 };

const MAINNET = 'ethereum-mainnet';
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const USDT    = '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840';
const WBTC    = '0xe85dc543813b8c2cfeaac371517b925a166a9293';

// ten million blocks past the latest, as the reviewer's version held for Arbitrum's USDT market
const UNREACHED = LATEST.number + 10_000_000;
const MESSAGE   = `creationBlock ${UNREACHED} is past the latest block, ${LATEST.number}`;

// the fixture with mainnet's USDT market created past the latest block
function unreachedSnapshot(): RegistrySnapshotV1 {
  const fixture = loadRegistrySnapshotFixture();
  return {
    ...fixture,
    networks: fixture.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets.map(market => market.contracts.comet !== USDT ? market : { ...market, creationBlock: UNREACHED }),
    }),
  };
}

/*
 * The worker over a database whose active version is `snapshot`. Each test
 * keeps its computations in a memory cache of its own: one filled by another
 * test would answer reads its node is meant to fail.
 */
async function workerOf(t: Test, snapshot: RegistrySnapshotV1) {
  const registry = await activeRegistryDatabase({ snapshot });
  t.teardown(() => registry.dispose());
  const env: Env = makeTestEnv({ APP_DB: registry.db, MEMORY_CACHE_SEED: `creation-block: ${t.fullname}` });
  return (path: string) => C3Api.fetch(new Request(`https://api.test.local${path}`), env);
}

type Entry = { chain_id: number, comet: { address: string }, status: string, message?: string };
type Day   = Entry & { date: string, timestamp: number };

type Envelope = { error: { code: string, message: string, requestId: string } };

const isUsdt = (entry: Entry) => entry.comet.address.toLowerCase() === USDT;

// how a market the chain has not reached is answered, as every route that lists it answers it
function unreached(snapshot: RegistrySnapshotV1) {
  return {
    chain_id: 1,
    comet:    { address: fixtureCatalog(snapshot).marketAt(MAINNET, USDT)!.comet.address },
    status:   'error',
    message:  MESSAGE,
  };
}

t.test('a version that holds a creation block past the latest block validates', async t => {
  t.same(failures(validateCandidate({ networks: unreachedSnapshot().networks as NetworkV1[] })), [],
    'validation does not read the chain: the overlay write is where the block is held against it');
});

t.test('the summaries answer a market created past the latest block as an error, and the rest as read', async t => {
  const snapshot = unreachedSnapshot();
  const get      = await workerOf(t, snapshot);
  const node     = fakeNode(snapshot, LATEST);
  const warnings = consoleLines(t, [ 'warn' ]);
  const markets  = fixtureCatalog(snapshot).markets().length;
  serve(t, node);

  const everyNetwork = await get('/market/all-networks/all-contracts/summary');
  t.equal(everyNetwork.status, 200, 'the summary of every network is answered');
  const every = await everyNetwork.json() as Entry[];
  t.equal(every.length, markets, 'with every market');
  t.strictSame(every.find(isUsdt), unreached(snapshot), 'that market as an error naming its block');
  t.ok(every.filter(entry => !isUsdt(entry)).every(entry => entry.status === 'success'), 'and every other as read');

  const mainnet = await get(`/market/${MAINNET}/all-contracts/summary`);
  t.equal(mainnet.status, 200, 'and so is the summary of its network');
  const ofMainnet = await mainnet.json() as Entry[];
  t.equal(ofMainnet.length, 4, 'every market of its network is answered');
  t.strictSame(ofMainnet.filter(entry => entry.status !== 'success'), [ unreached(snapshot) ], 'and only that one as an error');

  const alone = await get(`/market/${MAINNET}/${USDT}/summary`);
  t.equal(alone.status, 200, 'the summary of that market alone is its status, as a price that reverts is');
  t.strictSame(await alone.json(), unreached(snapshot), 'answered as an object, as one market always was');

  t.notOk(asked(node).has(USDT), 'and nothing of it was read');
  t.same(warnings.filter(line => line.includes(MESSAGE)), [
    `creation block not reached: ${unreached(snapshot).comet.address} on ${MAINNET}: ${MESSAGE}`,
  ], 'while the log names it once, however many routes answered it');
});

/*
 * A history reports a status per day. The market has none the index can
 * sample, so every day it reports is `error`, on the days every other market
 * of its network reports, as many as they do.
 */
t.test('the history answers every day of a market created past the latest block as an error', async t => {
  const snapshot = unreachedSnapshot();
  const get      = await workerOf(t, snapshot);
  serve(t, fakeNode(snapshot, LATEST));
  consoleLines(t, [ 'warn' ]);

  const response = await get('/market/all-networks/all-contracts/historical/summary');
  t.equal(response.status, 200, 'the history of every network is answered');
  const days = await response.json() as Day[];

  const ofUsdt = days.filter(isUsdt);
  const ofUsdc = days.filter(day => day.comet.address.toLowerCase() === USDC);
  t.equal(ofUsdt.length, 30, 'that market reports every day the history covers');
  t.same(ofUsdt.map(({ date, timestamp }) => ({ date, timestamp })), ofUsdc.map(({ date, timestamp }) => ({ date, timestamp })),
    'the days the other markets of its network report');
  t.strictSame(ofUsdt.at(-1), { ...unreached(snapshot), timestamp: LATEST.timestamp, date: '2026-09-21' },
    'each an error naming its block, up to the day of the latest block');
  t.ok(ofUsdt.every(day => day.status === 'error' && day.message === MESSAGE), 'and every day before it alike');
  t.ok(days.filter(day => !isUsdt(day)).every(day => day.status === 'success'), 'and every day of every other market as read');

  const alone = await get(`/market/${MAINNET}/${USDT}/historical/summary`);
  t.equal(alone.status, 200, 'the history of that market alone is answered too');
  t.strictSame(await alone.json(), ofUsdt, 'with the same days');
});

t.test('the rewards answer a market created past the latest block as an error', async t => {
  const snapshot = unreachedSnapshot();
  const get      = await workerOf(t, snapshot);
  serve(t, fakeNode(snapshot, LATEST));
  consoleLines(t, [ 'warn' ]);

  const response = await get('/market/all-networks/all-contracts/rewards/dapp-data');
  t.equal(response.status, 200, 'the rewards of every network are answered');
  const rewards = await response.json() as Entry[];
  t.strictSame(rewards.find(isUsdt), unreached(snapshot), 'that market as an error naming its block');
  t.ok(rewards.filter(entry => !isUsdt(entry)).every(entry => entry.status === 'success'), 'and every other as read');

  const summary = await get(`/market/${MAINNET}/${USDT}/rewards/summary`);
  t.equal(summary.status, 200, 'its rewards summary is its status');
  t.strictSame(await summary.json(), { status: 'error', message: MESSAGE }, 'which names no market, as a price that reverts does not');
});

/*
 * Only the index is answered for: a market the node did not serve, beside
 * the one the chain has not reached, fails the answer as it always has.
 */
t.test('a node that did not serve another market still fails the summary with 503', async t => {
  consoleLines(t, [ 'error', 'warn' ]);
  const snapshot = unreachedSnapshot();
  const get      = await workerOf(t, snapshot);
  serve(t, fakeNode(snapshot, LATEST, { answer: ({ comet, name }) => (
    comet === WBTC && name === 'totalSupply' ? { code: -32000, message: 'header not found' } : undefined
  ) }));

  const response = await get('/market/all-networks/all-contracts/summary');
  t.equal(response.status, 503);
  t.equal((await response.json() as Envelope).error.code, 'UPSTREAM_UNAVAILABLE', 'as a node provider that did not answer');
});

t.test('a read of another market that reverts still fails the summary with 500', async t => {
  consoleLines(t, [ 'error', 'warn' ]);
  const snapshot = unreachedSnapshot();
  const get      = await workerOf(t, snapshot);
  serve(t, fakeNode(snapshot, LATEST, { answer: ({ comet, name }) => (
    comet === WBTC && name === 'totalSupply' ? 'revert' : undefined
  ) }));

  const response = await get('/market/all-networks/all-contracts/summary');
  t.equal(response.status, 500);
  t.equal((await response.json() as Envelope).error.code, 'INTERNAL', 'as the fault a revert of a read that is not a price is');
});
