import t from 'tap';

import * as Debug    from '../../../lib/debug-log.js';
import * as Flags    from '../../../lib/flags.js';
import { BigNumber } from '../../../lib/bignumber.js';
import { BigFixnum } from '../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../lib/symbolic/cache.js';

import * as evm    from '../../../lib/computations/evm.js';
import * as comet  from '../../../lib/computations/comet.js';
import * as market from '../../../lib/computations/market.js';

import type { PriceExceptionV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import {
  ABANDONED_AFTER_MS,
  CHAIN_FAILURE_BACKOFF_MS,
  CollateralMinute,
  CollateralView,
  INCOMPLETE_BACKOFF_MS,
  TokenCollateralDeps,
  collateralView,
  maxStaleMinutesOf,
  positionSetOf,
  positionsOf,
  recordKey,
  tokenValue,
} from '../../../src/registry/token-collateral.js';

import { FakeNode, NodeScript, batches, blockReads, fakeNode } from '../../util/fake-node.js';
import { MemoryKv } from '../../util/kv.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

import '../../../shim/node-self.js';

/*
 * The collateral value of a chain, on the real evaluator against a fake node:
 * what reaches the node, what is kept in KV, and what a request answers when
 * the node fails it in part, in whole, or not at all.
 */
const flags = { ...Flags.parseWithDefaults(process.env), evaluatorAlgorithm: 'workingset', batchingEnabled: true } as Flags.SomeFlags;
const debug = Debug.MakeLogger([]).configure(process.env);

const snapshot = loadRegistrySnapshotFixture();
const NOW      = new Date('2026-10-05T12:00:30.000Z');
const LATEST   = { number: 23_500_000, timestamp: Math.floor(NOW.getTime() / 1000) };
const MINUTE   = Math.floor(LATEST.timestamp / 60);

const THRESHOLD = BigFixnum.from({ value: 250000 });

const XAUT        = '0x68749665ff8d2d112fa859aa293f07a622782f38';
const XAUT_FEED   = '0x214ed9da11d2fbe465a6fc601a91e62ebec1a0d6';
const USDC        = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const BASE_USDC   = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const BASE_USDC_FEED = '0x3e6d1cca8eee6d02f1f578b613374eb53e6823b4';

const nodeOf = (script: NodeScript = {}) => fakeNode(snapshot, LATEST, script);

function useNode(t: { teardown: (fn: () => void) => void }, node: FakeNode): void {
  const before = globalThis.fetch;
  globalThis.fetch = node.fetch as typeof globalThis.fetch;
  t.teardown(() => { globalThis.fetch = before; });
}

// the lines a dashboard reads, taken off the console for the length of a test
function captureEvents(t: { teardown: (fn: () => void) => void }): Array<Record<string, any>> {
  const events: Array<Record<string, any>> = [];
  const log = console.log;
  console.log = (...parameters: unknown[]) => {
    const [ line ] = parameters;
    if (typeof(line) === 'string' && line.startsWith('{"event":')) {
      events.push(JSON.parse(line));
    } else {
      log(...parameters);
    }
  };
  t.teardown(() => { console.log = log; });
  return events;
}

const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

// a KV that counts what is asked of it, around a store another one may share
function countedKv(store: KVNamespace = MemoryKv({}) as unknown as KVNamespace) {
  const counts = { gets: 0, puts: [] as Array<{ key: string, ttl: number | undefined }> };
  const kv = {
    get: async (key: string, type: 'json') => { counts.gets += 1; return store.get(key, type); },
    put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
      counts.puts.push({ key, ttl: options?.expirationTtl });
      return store.put(key, value, options);
    },
  } as unknown as KVNamespace;
  return { kv, counts, store };
}

/*
 * The dependencies of one isolate, which is what one KV binding object is.
 * What it hands to waitUntil is kept, so a test can wait for the work a
 * request left running.
 */
function depsOf(
  kv: KVNamespace,
  overrides: Partial<TokenCollateralDeps> = {},
): TokenCollateralDeps & { background: Array<Promise<unknown>> } {
  const cache = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  const background: Array<Promise<unknown>> = [];
  return {
    frame:           { apiHost: '', nodeHost: 'node.test', nodeKey: 'key' },
    evaluator:       () => Evaluator.instantiate({ ...evm, ...comet, ...market } as any, { cache, debug, flags }) as any,
    kv:              () => kv,
    maxStaleMinutes: 15,
    now:             () => NOW,
    debug:           { error: () => {} },
    waitUntil:       work => { background.push(work); },
    background,
    ...overrides,
  };
}

// a clock a test moves by hand, starting at NOW
function clock() {
  let time = NOW.getTime();
  return { now: () => new Date(time), advance: (milliseconds: number) => { time += milliseconds; } };
}

const catalog  = catalogOf(snapshot, NOW);
const mainnet  = positionsOf(catalog, 'ethereum-mainnet');
const base     = positionsOf(catalog, 'base-mainnet');
const versionId = snapshot.registryVersion.id;
const chain1    = { chainId: 1, network: 'ethereum-mainnet' as const, positions: mainnet, versionId };
const chain8453 = { chainId: 8453, network: 'base-mainnet' as const, positions: base, versionId };

// a complete record of an earlier minute, every position worth one dollar
function recordAt(minute: number, positions = mainnet, chainId = 1): CollateralMinute {
  return {
    chainId,
    minute,
    positionSet: positionSetOf(positions),
    block:       { number: LATEST.number - (MINUTE - minute) * 5, timestamp: minute * 60 },
    positions:   positions.map(position => ({ key: position.key, token: position.token, outcome: { status: 'success', valueUsd: { value: '1', decimals: 0 } } })),
  };
}

const outcomeOf = (view: CollateralView, token: string) => view.current!.positions
  .filter(entry => entry.token === token)
  .map(entry => entry.outcome.status === 'error' ? entry.outcome.reason : entry.outcome.status);

t.test('a cold minute costs the latest block and one batch, and is kept for the rest of the minute', async t => {
  const node = nodeOf();
  useNode(t, node);
  const events = captureEvents(t);
  const { kv, counts } = countedKv();
  const deps = depsOf(kv);

  const view = await collateralView(deps, chain1);
  t.same(view.block, LATEST);
  t.equal(node.requests.length, 2, 'the latest block, then every position of the chain in one batch');

  // two reads per position, one price per Comet and feed, one conversion per base-quoted market
  const enabled = snapshot.networks.find(network => network.chainId === 1)!.markets.filter(entry => entry.status === 'enabled');
  const prices  = new Set(enabled.flatMap(entry => entry.collateralAssets.map(asset => `${entry.contracts.comet}:${asset.priceFeed.address}`)));
  const quoted  = enabled.filter(entry => entry.collateralValueQuote === 'base').length;
  const [ batch ] = batches(node);
  t.equal(batch!.calls.length, 2 * mainnet.length + prices.size + quoted, 'and no read in it is sent twice');
  t.equal(new Set(batch!.calls.map(call => JSON.stringify(call.params))).size, batch!.calls.length);

  t.ok(view.current!.positions.every(entry => entry.outcome.status === 'success'), 'every position valued');
  t.same(counts.puts, [ { key: recordKey(1, positionSetOf(mainnet), MINUTE), ttl: (15 + 2) * 60 } ],
    'the minute is written once, expiring just past the stale window');
  t.same(
    events.filter(event => event.event === 'token_collateral_minute')
      .map(({ chainId, versionId, positionSet, minute, positions, failed, failures, evaluations }) => ({ chainId, versionId, positionSet, minute, positions, failed, failures, evaluations })),
    [ { chainId: 1, versionId, positionSet: positionSetOf(mainnet), minute: MINUTE, positions: mainnet.length, failed: {}, failures: [], evaluations: 1 } ],
    'and logged once, naming the version and the positions it valued',
  );

  const gets = counts.gets;
  await collateralView(deps, chain1);
  t.equal(node.requests.length, 3, 'the next request of the minute reads the latest block only');
  t.equal(counts.gets, gets, 'and takes the minute from the isolate, without reading KV');
});

t.test('another isolate reads the minute from KV', async t => {
  const node = nodeOf();
  useNode(t, node);
  const shared = countedKv();
  await collateralView(depsOf(shared.kv), chain1);

  // another binding object over the same store: what a second isolate sees
  const other = countedKv(shared.store);
  const before = batches(node).length;
  const view = await collateralView(depsOf(other.kv), chain1);
  t.equal(batches(node).length, before, 'no position is read again');
  t.equal(other.counts.gets, 1, 'the minute is one KV read');
  t.same(view.current!.block, LATEST);
});

/*
 * A token held in several markets is the sum of its positions, each priced in
 * its own market's quote: wstETH in USD in cUSDCv3 and cUSDTv3 and in ETH in
 * cWETHv3; USDC in ETH in cWETHv3 and in BTC in cWBTCv3.
 */
t.test('a token held in several markets is the sum of its positions, each in its own quote', async t => {
  const WSTETH = '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0';
  const [ cUSDC, cWETH, cUSDT, cWBTC ] = [
    '0xc3d688b66703497daa19211eedff47f25384cdc3',
    '0xa17581a9e3356d9a858b789d68b4d866e593ae94',
    '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840',
    '0xe85dc543813b8c2cfeaac371517b925a166a9293',
  ];
  const units  = (amount: bigint, decimals: number) => (amount * 10n ** BigInt(decimals)).toString();
  // prices at the 8 decimals of every feed involved, as fractions of a whole: [ numerator, denominator ]
  const priced = (numerator: bigint, denominator = 1n) => (numerator * 10n ** 8n / denominator).toString();
  const totals: Record<string, string> = {
    [`${cUSDC}:${WSTETH}`]: units(100n, 18),
    [`${cWETH}:${WSTETH}`]: units(50n, 18),
    [`${cUSDT}:${WSTETH}`]: units(10n, 18),
    [`${cWETH}:${USDC}`]:   units(1_000n, 6),
    [`${cWBTC}:${USDC}`]:   units(1_000n, 6),
  };
  const prices: Record<string, string> = {
    [`${cUSDC}:0xa2699232b341881b1ed85d91592b7c259e029acf`]: priced(4_000n),       // wstETH / USD
    [`${cUSDT}:0xa2699232b341881b1ed85d91592b7c259e029acf`]: priced(4_000n),
    [`${cWETH}:0x91359ce8989cb610a4127777828e667f23b94ee9`]: priced(12n, 10n),     // wstETH / ETH, 1.2
    [`${cWETH}:0xfd5282968119c348c1e47fbcadd13069d9857bf2`]: priced(4n, 10_000n),  // USDC / ETH, 0.0004
    [`${cWETH}:0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419`]: priced(2_500n),       // ETH / USD, the conversion
    [`${cWBTC}:0x40fcee8cdda01522846d197df9d9c1199b1cb1d3`]: priced(1n, 100_000n), // USDC / BTC, 0.00001
    [`${cWBTC}:0xf4030086522a5beea4988f8ca5b36dbc97bee88c`]: priced(100_000n),     // BTC / USD, the conversion
  };
  useNode(t, nodeOf({
    answer: read => read.name === 'totalsCollateral' ? (totals[`${read.comet}:${read.argument}`] === undefined ? undefined : [ totals[`${read.comet}:${read.argument}`] ])
      : read.name === 'getPrice' ? (prices[`${read.comet}:${read.argument}`] === undefined ? undefined : [ prices[`${read.comet}:${read.argument}`] ])
      : undefined,
  }));

  const view = await collateralView(depsOf(countedKv().kv), chain1);
  const wstEth = tokenValue(WSTETH, view, mainnet, THRESHOLD, NOW);
  t.equal(wstEth.status, 'fresh');
  t.ok(wstEth.valueUsd!.eq(BigFixnum.from({ value: 590_000 })), 'wstETH is 100 × 4000 + 50 × 1.2 × 2500 + 10 × 4000, exactly');
  const usdc = tokenValue(USDC, view, mainnet, THRESHOLD, NOW);
  t.ok(usdc.valueUsd!.eq(BigFixnum.from({ value: 2_000 })), 'USDC is 1000 × 0.0004 × 2500 + 1000 × 0.00001 × 100000');
});

t.test('one call the node refuses costs only its own position', async t => {
  const cases: Array<[ string, typeof chain1 | typeof chain8453, string, string ]> = [
    [ 'on a chain of one market', chain8453, BASE_USDC_FEED, BASE_USDC ],
    [ 'on a chain of many',       chain1,    XAUT_FEED,      XAUT ],
  ];
  for (const [ name, chain, feed, token ] of cases) {
    const node = nodeOf({ answer: read => read.name === 'getPrice' && read.argument === feed ? 'fail' : undefined });
    useNode(t, node);
    const { kv, counts } = countedKv();

    const view = await collateralView(depsOf(kv), chain);
    const failed = view.current!.positions.filter(entry => entry.outcome.status === 'error');
    t.same(failed.map(entry => [ entry.token, entry.outcome ]), [ [ token, { status: 'error', reason: 'transport' } ] ],
      `${name}, the batch is split until the failing read stands alone`);
    t.ok(node.requests.length <= 2 + 16, `within the bound on splits (${node.requests.length} requests)`);
    t.same(counts.puts, [], 'a minute with a transport failure is not written to KV');
  }
});

t.test('a revert is an answer about its position, kept with the minute', async t => {
  const usdcMarket = snapshot.networks.find(network => network.chainId === 1)!.markets.find(entry => entry.deploymentKey === 'usdc')!;
  const cUSDC = usdcMarket.contracts.comet!;
  const uni   = usdcMarket.collateralAssets.find(asset => asset.token.symbol === 'UNI')!;
  const link  = usdcMarket.collateralAssets.find(asset => asset.token.symbol === 'LINK')!;
  const node = nodeOf({
    answer: read => (
        read.name === 'getPrice' && read.argument === XAUT_FEED ? 'revert'
      : read.comet === cUSDC && read.name === 'getAssetInfo' && read.argument === String(uni.assetIndex) ? 'revert'
      : read.comet === cUSDC && read.name === 'totalsCollateral' && read.argument === link.token.address ? 'revert'
      : undefined
    ),
  });
  useNode(t, node);
  const events = captureEvents(t);
  const { kv, counts } = countedKv();

  const view = await collateralView(depsOf(kv), chain1);
  t.equal(batches(node).length, 1, 'a revert does not split the batch');
  t.same(outcomeOf(view, XAUT), [ 'price_reverted' ]);
  t.same(outcomeOf(view, uni.token.address).sort(), [ 'asset_info_reverted', 'success' ], 'the info of one market\'s asset');
  t.same(outcomeOf(view, link.token.address).sort(), [ 'success', 'total_reverted' ], 'the total of another');
  t.equal(counts.puts.length, 1, 'and the minute is written: a revert is a fact about that block');

  const [ line ] = events.filter(event => event.event === 'token_collateral_minute');
  t.same(line!.failed, { price_reverted: 1, asset_info_reverted: 1, total_reverted: 1 });
  t.same(
    new Set(line!.failures.map((failure: any) => `${failure.market}#${failure.assetIndex}:${failure.reason}`)),
    new Set([ `usdt#14:price_reverted`, `usdc#${uni.assetIndex}:asset_info_reverted`, `usdc#${link.assetIndex}:total_reverted` ]),
    'the log names each failed position, so a mismatch can be told from a feed that reverts',
  );
});

t.test('a node that fails the latest block leaves the earlier minutes', async t => {
  const node = nodeOf({ block: () => 'fail' });
  useNode(t, node);
  const { kv, store, counts } = countedKv();
  await store.put(recordKey(1, positionSetOf(mainnet), MINUTE - 3), JSON.stringify(recordAt(MINUTE - 3)));

  const view = await collateralView(depsOf(kv), chain1);
  t.equal(view.block, null);
  t.equal(view.current, null, 'no minute is computed without a block');
  t.equal(node.requests.length, 1, 'the node is asked for the latest block only');
  t.same(counts.puts, [], 'nothing is written');
  t.same(view.earlier.map(record => record.minute), [ MINUTE - 3 ], 'and the earlier minute is there to answer from');
});

t.test('a node that hangs is waited for only so long, and says so', async t => {
  const node = nodeOf({ hold: () => 'forever' });
  useNode(t, node);
  const events = captureEvents(t);
  const started = Date.now();
  const view = await collateralView(depsOf(countedKv().kv, { deadlineMs: 50 }), chain1);
  t.ok(Date.now() - started < 1_000, 'the view answers past the deadline');
  t.same([ view.block, view.current ], [ null, null ]);
  t.same(events.map(({ event, chainId, phase }) => ({ event, chainId, phase })), [ { event: 'token_collateral_deadline', chainId: 1, phase: 'block' } ],
    'a deadline that passes is logged, with what was waited for');
});

t.test('the node gets one deadline, for the latest block and the minute together', async t => {
  let arrived!: () => void;
  const batchArrived = new Promise<void>(resolve => { arrived = resolve; });
  const node = nodeOf({ hold: request => request.calls[0]!.method === 'eth_getBlockByNumber' ? sleep(500) : (arrived(), 'forever') });
  useNode(t, node);
  const events = captureEvents(t);
  const started = Date.now();
  const view = await collateralView(depsOf(countedKv().kv, { deadlineMs: 1_000 }), chain8453);
  const elapsed = Date.now() - started;
  t.same(view.block, LATEST, 'the block came in time');
  t.equal(view.current, null, 'the minute did not');
  // one deadline answers at about 1000 ms; a deadline of the minute's own would add the 500 the block took
  t.ok(elapsed < 1_300, `the minute had what the block left of the deadline, not a deadline of its own (${elapsed} ms)`);
  t.same(events.map(event => event.phase), [ 'minute' ]);
  // the minute's batch is held for good by this test's node, so none of it reaches a later test's
  await Promise.race([ batchArrived, sleep(5_000) ]);
});

/*
 * A minute is shared by every request of the isolate. A request that stops
 * waiting for it answers without it, and leaves it running: the runtime would
 * cancel it with that request's answer, unless it is handed to waitUntil.
 */
t.test('a minute slower than the deadline is finished for the next request', async t => {
  const node = nodeOf({ hold: request => request.calls[0]!.method === 'eth_getBlockByNumber' ? undefined : sleep(1_500) });
  useNode(t, node);
  const events = captureEvents(t);
  const deps = depsOf(countedKv().kv, { deadlineMs: 500 });

  const first = await collateralView(deps, chain8453);
  t.equal(first.current, null, 'the first request answers without the minute');
  t.same(events.map(event => event.phase), [ 'minute' ]);
  t.ok(deps.background.length > 0, 'and hands the computation to waitUntil');

  await Promise.all(deps.background);
  const started = Date.now();
  const second = await collateralView(deps, chain8453);
  t.ok(second.current !== null && second.current.positions.every(entry => entry.outcome.status === 'success'),
    'the next request of the minute answers from it');
  t.equal(batches(node).length, 1, 'without reading the positions again');
  t.ok(Date.now() - started < 450, 'and without waiting out the deadline');
});

t.test('a computation that never finishes is started again once the runtime would have cancelled it', async t => {
  // the first batch is never answered, as one the runtime cancelled would not be; every later one is
  let sent = 0;
  const node = nodeOf({ hold: request => request.calls[0]!.method !== 'eth_getBlockByNumber' && sent++ === 0 ? 'forever' : undefined });
  useNode(t, node);
  const time = clock();
  const deps = depsOf(countedKv().kv, { deadlineMs: 1_000, now: time.now });

  t.equal((await collateralView(deps, chain8453)).current, null);

  time.advance(10_000);
  t.equal((await collateralView(deps, chain8453)).current, null, 'a request soon after waits for the computation under way');
  t.equal(batches(node).length, 1, 'and starts no other');

  time.advance(ABANDONED_AFTER_MS);
  const view = await collateralView(deps, chain8453);
  t.ok(view.current !== null, 'one that has been under way for longer is given up, and the minute computed again');
  t.equal(batches(node).length, 2);
});

t.test('a minute that failed in part is read again after seconds, one that failed whole after a minute', async t => {
  const cases: Array<[ string, NodeScript['answer'], number ]> = [
    [ 'one read failing',   read => read.name === 'getPrice' && read.argument === BASE_USDC_FEED ? 'fail' : undefined, INCOMPLETE_BACKOFF_MS ],
    [ 'every read failing', () => 'fail',                                                                              CHAIN_FAILURE_BACKOFF_MS ],
  ];
  for (const [ name, answer, backoff ] of cases) {
    const node = nodeOf({ answer: answer! });
    useNode(t, node);
    const time = clock();
    const deps = depsOf(countedKv().kv, { now: time.now });

    await collateralView(deps, chain8453);
    const computed = batches(node).length;
    time.advance(backoff - 1_000);
    await collateralView(deps, chain8453);
    t.equal(batches(node).length, computed, `with ${name}, the minute is kept for ${backoff / 1000} s`);
    time.advance(2_000);
    await collateralView(deps, chain8453);
    t.ok(batches(node).length > computed, 'and computed again after that');
  }
});

t.test('an isolate\'s incomplete minute does not hide the complete one another isolate wrote', async t => {
  const store = MemoryKv({}) as unknown as KVNamespace;
  const usdcFails = (read: { name: string, argument: string }) => read.name === 'getPrice' && read.argument === BASE_USDC_FEED ? 'fail' as const : undefined;
  const earlierBlock = { number: LATEST.number - 30, timestamp: LATEST.timestamp - 60 };

  // this isolate cannot value USDC in the minute before
  let block = earlierBlock;
  const node = nodeOf({ block: () => block, answer: usdcFails });
  useNode(t, node);
  const isolate = depsOf(countedKv(store).kv);
  t.same(outcomeOf(await collateralView(isolate, chain8453), BASE_USDC), [ 'transport' ]);

  // another isolate can, and writes that minute to KV
  const healthy = nodeOf({ block: () => block });
  useNode(t, healthy);
  await collateralView(depsOf(countedKv(store).kv), chain8453);

  // in this minute this isolate fails again, and looks back
  block = LATEST;
  useNode(t, node);
  const view = await collateralView(isolate, chain8453);
  t.same(view.earlier.map(record => record.minute), [ MINUTE - 1 ], 'the complete minute in KV is found');
  t.equal(tokenValue(BASE_USDC, view, base, THRESHOLD, NOW).status, 'stale', 'and answers for USDC');
});

t.test('what an isolate found looking back is kept, even when the block lags the clock', async t => {
  const node = nodeOf({
    block:  () => ({ number: LATEST.number - 8, timestamp: LATEST.timestamp - 90 }),
    answer: read => read.name === 'getPrice' && read.argument === XAUT_FEED ? 'revert' : undefined,
  });
  useNode(t, node);
  const { kv, counts } = countedKv();
  const deps = depsOf(kv);

  await collateralView(deps, chain1);
  t.equal(counts.gets, 1 + 15, 'the minute, then the stale window');
  await collateralView(deps, chain1);
  t.equal(counts.gets, 1 + 15, 'the next request reads KV for neither');
});

t.test('the stale window reaches back exactly as far as it is set', async t => {
  const revertingXaut: NodeScript['answer'] = read => read.name === 'getPrice' && read.argument === XAUT_FEED ? 'revert' : undefined;
  const put = (store: KVNamespace, minute: number) => store.put(recordKey(1, positionSetOf(mainnet), minute), JSON.stringify(recordAt(minute)));

  // with a block, from the block's minute back
  const withBlock = countedKv();
  await put(withBlock.store, MINUTE - 15);
  await put(withBlock.store, MINUTE - 16);
  useNode(t, nodeOf({ answer: revertingXaut }));
  const looked = await collateralView(depsOf(withBlock.kv), chain1);
  t.same(looked.earlier.map(record => record.minute), [ MINUTE - 15 ], 'the fifteenth minute before is the last one used');
  t.same(tokenValue(XAUT, looked, mainnet, THRESHOLD, NOW).staleAgeSeconds, LATEST.timestamp - (MINUTE - 15) * 60);

  // without one, from the clock's minute, which is the latest that can have been recorded
  const withoutBlock = countedKv();
  await put(withoutBlock.store, MINUTE - 14);
  await put(withoutBlock.store, MINUTE - 15);
  useNode(t, nodeOf({ block: () => 'fail' }));
  const blind = await collateralView(depsOf(withoutBlock.kv), chain1);
  t.same(blind.earlier.map(record => record.minute), [ MINUTE - 14 ], 'the clock\'s own minute counts as one of the fifteen');
});

t.test('concurrent requests of one minute compute it once', async t => {
  const node = nodeOf();
  useNode(t, node);
  const deps = depsOf(countedKv().kv);
  const [ first, second ] = await Promise.all([ collateralView(deps, chain1), collateralView(deps, chain1) ]);
  t.equal(batches(node).length, 1, 'one batch between them');
  t.equal(blockReads(node).length, 2, 'each read the latest block');
  t.equal(first.current, second.current, 'and both answer with the same record');
});

t.test('an entry KV cannot give is a miss', async t => {
  const node = nodeOf();
  useNode(t, node);
  const { kv, store } = countedKv();
  await store.put(recordKey(1, positionSetOf(mainnet), MINUTE), '{"not":"a record"}');
  const view = await collateralView(depsOf(kv), chain1);
  t.equal(batches(node).length, 1, 'a malformed entry is computed again');
  t.ok(view.current !== null);

  const failing = { get: async () => { throw new Error('KV is down'); }, put: async () => {} } as unknown as KVNamespace;
  const again = await collateralView(depsOf(failing), chain1);
  t.ok(again.current !== null, 'and so is one KV fails to read');
});

t.test('the positions a minute is kept by are those of the enabled markets, priced as the version says', async t => {
  const withNetwork = (change: (network: RegistrySnapshotV1['networks'][number]) => RegistrySnapshotV1['networks'][number]): RegistrySnapshotV1 => ({
    ...snapshot,
    networks: snapshot.networks.map(network => network.chainId === 1 ? change(network) : network),
  });
  const setOf = (changed: RegistrySnapshotV1) => positionSetOf(positionsOf(catalogOf(changed, NOW), 'ethereum-mainnet'));

  const deprecated = withNetwork(network => ({
    ...network,
    markets: network.markets.map(entry => entry.deploymentKey === 'usdt' ? { ...entry, status: 'deprecated' as const } : entry),
  }));
  t.ok(positionsOf(catalogOf(deprecated, NOW), 'ethereum-mainnet').length < mainnet.length, 'a deprecated market holds no position of the chain');
  t.not(setOf(deprecated), positionSetOf(mainnet), 'so its minutes are kept apart from those before');
  t.same(setOf(snapshot), positionSetOf(mainnet), 'while the same positions, materialized again, are the same set');

  const excepted = (expiresAt: string | null) => withNetwork(network => ({
    ...network,
    priceExceptions: [
      ...network.priceExceptions,
      { kind: 'zero_price', priceFeedAddress: XAUT_FEED, provenance: 'test', expiresAt } as PriceExceptionV1,
    ],
  }));
  t.not(setOf(excepted(null)), positionSetOf(mainnet), 'an exception changes how a position is priced, and starts minutes of its own');
  t.same(setOf(excepted('2026-10-05T11:00:00.000Z')), positionSetOf(mainnet), 'one that has expired does not');
});

t.test('the stale window comes from the environment, and an empty value is unset', async t => {
  t.equal(maxStaleMinutesOf({}), 15);
  t.equal(maxStaleMinutesOf({ TOKEN_COLLATERAL_MAX_STALE_MINUTES: '' }), 15, 'not 0, which Number would make of it');
  t.equal(maxStaleMinutesOf({ TOKEN_COLLATERAL_MAX_STALE_MINUTES: '0' }), 0);
  t.equal(maxStaleMinutesOf({ TOKEN_COLLATERAL_MAX_STALE_MINUTES: '30' }), 30);
  // a var written unquoted in wrangler.toml arrives as a number
  t.equal(maxStaleMinutesOf({ TOKEN_COLLATERAL_MAX_STALE_MINUTES: 20 as unknown as string }), 20, 'and a number is read as one');
  for (const value of [ '31', '-1', '1.5', 'ten' ]) {
    t.equal(maxStaleMinutesOf({ TOKEN_COLLATERAL_MAX_STALE_MINUTES: value }), 15, `${value} is out of range`);
  }
});

/*
 * A token's value from a view, by the rule: fresh or exception, then the D7
 * lower bound, then the newest complete earlier minute, then nothing.
 */
t.test('a token takes the newest value it can stand behind', async t => {
  const positions = [
    { key: 'a@1#0', token: '0x00000000000000000000000000000000000000aa', assetIndex: 0 },
    { key: 'b@1#0', token: '0x00000000000000000000000000000000000000aa', assetIndex: 0 },
  ] as any[];
  const TOKEN = '0x00000000000000000000000000000000000000aa';
  const block = (minute: number) => ({ number: minute, timestamp: minute * 60 });
  const usd = (value: string) => ({ status: 'success' as const, valueUsd: { value, decimals: 0 } });
  const record = (minute: number, outcomes: unknown[]): CollateralMinute => ({
    chainId: 1, minute, positionSet: 'x', block: block(minute),
    positions: positions.map((position, index) => ({ key: position.key, token: TOKEN, outcome: outcomes[index] as any })),
  });
  const valueOf = (view: CollateralView) => tokenValue(TOKEN, view, positions, THRESHOLD, NOW);
  const reverted = { status: 'error', reason: 'price_reverted' };
  const remap = { kind: 'deprecated_price_remap', priceFeedAddress: '0x0000000000000000000000000000000000000001', replacementPriceFeed: { address: '0x0000000000000000000000000000000000000002', decimals: 8 }, provenance: 'x', expiresAt: null };

  const fresh = valueOf({ block: block(100), current: record(100, [ usd('100000'), usd('150000') ]), earlier: [] });
  t.same([ fresh.status, fresh.valueUsd?.toString(), fresh.staleAgeSeconds ], [ 'fresh', '250000', 0 ], 'complete now is fresh');

  const excepted = valueOf({ block: block(100), current: record(100, [
    { status: 'exception', valueUsd: { value: '1', decimals: 0 }, exceptions: [ remap ] },
    { status: 'exception', valueUsd: { value: '1', decimals: 0 }, exceptions: [ remap ] },
  ]), earlier: [] });
  t.same([ excepted.status, excepted.exceptions.length ], [ 'exception', 1 ], 'an exception is named once, whatever it priced');

  const partial = valueOf({ block: block(100), current: record(100, [ usd('300000'), reverted ]), earlier: [ record(99, [ usd('1'), usd('1') ]) ] });
  t.same([ partial.status, partial.valueUsd?.toString() ], [ 'partial', '300000' ], 'what was read already reaching the threshold proves it (D7)');
  const partialExcepted = valueOf({ block: block(100), current: record(100, [
    { status: 'exception', valueUsd: { value: '300000', decimals: 0 }, exceptions: [ remap ] },
    reverted,
  ]), earlier: [] });
  t.same([ partialExcepted.status, partialExcepted.exceptions ], [ 'partial', [ remap ] ], 'and names the exceptions of what it read');

  const stale = valueOf({ block: block(100), current: record(100, [ usd('1'), reverted ]), earlier: [ record(97, [ usd('2'), usd('3') ]) ] });
  t.same([ stale.status, stale.valueUsd?.toString(), stale.staleAgeSeconds, stale.block ], [ 'stale', '5', 180, block(97) ],
    'below the threshold, the newest complete minute answers, and says how old it is');
  const staleExcepted = valueOf({ block: block(100), current: null, earlier: [ record(97, [
    { status: 'exception', valueUsd: { value: '2', decimals: 0 }, exceptions: [ remap ] },
    usd('3'),
  ]) ] });
  t.same([ staleExcepted.status, staleExcepted.exceptions ], [ 'stale', [ remap ] ], 'with the exceptions that minute applied');

  const unavailable = valueOf({ block: null, current: null, earlier: [ record(97, [ usd('1'), reverted ]) ] });
  t.same([ unavailable.status, unavailable.valueUsd, unavailable.block ], [ 'unavailable', null, null ],
    'an earlier minute that could not value it either is not an answer');

  const absent = tokenValue('0x00000000000000000000000000000000000000bb', { block: null, current: null, earlier: [] }, positions, THRESHOLD, NOW);
  t.same([ absent.status, absent.valueUsd?.toString() ], [ 'fresh', '0' ],
    'a token without a collateral position is worth nothing, whether or not the node answers');
});
