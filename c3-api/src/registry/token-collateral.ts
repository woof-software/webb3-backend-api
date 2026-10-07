import type { Env } from '../../entrypoint.js';

import { BigFixnum } from '../../lib/bigfixnum.js';
import * as Eth      from '../../lib/eth-constants.js';
import { canonicalJson } from '../../lib/canonical-json.js';
import { keccak256 } from '../../lib/hash.js';

import * as KnownNetwork from '../../lib/well-known/networks/network.js';

import type * as evm    from '../../lib/computations/evm.js';
import type * as market from '../../lib/computations/market.js';
import type { PositionFailure, PositionValue } from '../../lib/computations/market/asset-collateral-value.js';

import type { Address, BlockRefV1, CollateralValueStatusV1, PriceExceptionV1 } from '../../lib/model/comet-registry.js';

import type * as Evaluator from '../evaluator.js';

import type { Catalog, RegistryComet } from './catalog.js';

/*
 * The collateral value of every token of a chain, for the token list.
 *
 * Every collateral position of every enabled market of the chain is valued at
 * one block, the chain's latest, in one evaluation: one batch of reads, not
 * one per market. The result is kept as one record per chain and minute, in
 * the isolate and in KV with an expiry, so the requests of that minute answer
 * from it: an isolate values a minute once, and reads one another isolate has
 * already written.
 *
 * A record is identified by what it valued, never by a version id: the set of
 * enabled positions, each named by its Comet's content digest, which covers
 * its tokens, feeds, decimals, quote and what the exceptions of its network do
 * to a price. A version that values the same positions the same way shares the
 * records of the one before it, and one that changes anything a value depends
 * on starts afresh. Why an exception was added and until when it applies
 * change no value, so a list takes them from the version it answers from,
 * never from a record (tokenValue).
 *
 * Nothing here is written to D1: values are recomputed, never stored.
 */
type Dependencies = evm.Evm | market.AssetCollateralValue;

const RECORD_VERSION = 1;
/*
 * The rule a record was valued and a list decided by. A change of either must
 * not read records of the old one: assetCollateralValue is never cached, so
 * this is the only thing that retires them.
 */
const RULE_VERSION = 1;

/*
 * How far back a token whose value cannot be read now may take the last value
 * that could. TOKEN_COLLATERAL_MAX_STALE_MINUTES sets it, from 0 to 30.
 */
const DEFAULT_MAX_STALE_MINUTES = 15;
const MAX_STALE_MINUTES         = 30;

/*
 * When the batch of a chain fails as a whole, it is split in halves until the
 * failing reads are isolated: one call the node refuses must not cost a
 * single-market chain every position. Each split is an evaluation and a
 * request to the node, so they are bounded.
 */
const MAX_SPLIT_EVALUATIONS = 16;

/*
 * How long a request waits for the node, in all: for the latest block and
 * the minute's valuation together, before answering from what earlier minutes
 * recorded. A node that hangs must not hang the token list: its purpose is to
 * fail open. A valuation the request stops waiting for is not abandoned: it
 * goes on, and the next request of the minute answers from it.
 */
const DEADLINE_MS = 4_000;

// how long a request waits for KV to give the earlier minutes it looks back on
const LOOKBACK_DEADLINE_MS = 1_000;

/*
 * How long a valuation may stay in flight before a request starts another.
 * The runtime keeps work handed to waitUntil for 30 seconds past the answer
 * and cancels it then, so one older than that will never finish.
 */
const ABANDONED_AFTER_MS = 30_000;

// how many minutes an isolate keeps, per KV namespace
const RECENT_RECORDS = 64;

/*
 * A minute some of whose reads failed in transport is kept in the isolate
 * only, and only this long: the failure is this isolate's, and another
 * isolate, or this one shortly, may well read the same block. A minute none
 * of whose reads succeeded says the node fails the whole chain, and is
 * retried less often, so that an outage is not met with a split of every
 * batch every few seconds.
 */
const INCOMPLETE_BACKOFF_MS    = 10_000;
const CHAIN_FAILURE_BACKOFF_MS = 60_000;

// how long an isolate keeps what it found looking back from one minute
const LOOKBACK_CACHE_MS = 60_000;

type Position = {
  // the Comet's content key and the asset index: unique within a chain
  key:           string,
  comet:         RegistryComet,
  assetIndex:    number,
  token:         Address,
  deploymentKey: string,
};

// a value as a record stores it: the integer and its decimals, exact
type StoredValue = { value: string, decimals: number };

type PositionOutcome = (
  | { status: 'success',   valueUsd: StoredValue }
  | { status: 'exception', valueUsd: StoredValue, exceptions: PriceExceptionV1[] }
  | { status: 'error',     reason: PositionFailure | 'transport' }
);

type BlockRef = BlockRefV1;

type CollateralMinute = {
  chainId:     number,
  minute:      number,
  positionSet: string,
  block:       BlockRef,
  positions:   Array<{ key: string, token: Address, outcome: PositionOutcome }>,
};

type TokenCollateralDeps = {
  frame:           { apiHost: string, nodeHost: string, nodeKey: string },
  evaluator:       (networkEnv: 'mainnet' | 'testnet') => Evaluator.Implementation<Dependencies>,
  kv:              (networkEnv: 'mainnet' | 'testnet') => KVNamespace,
  maxStaleMinutes: number,
  now:             () => Date,
  debug:           { error: (...parameters: unknown[]) => unknown },
  /*
   * Keeps work alive past the answer. The runtime cancels whatever a request
   * still has in flight once it has answered, and a minute is shared by every
   * request of the isolate: one cancelled with the request that started it
   * would never finish, and every other request would wait for it.
   */
  waitUntil:       (work: Promise<unknown>) => void,
  deadlineMs?:     number,
};

/*
 * What a request knows about the chain's collateral: the latest block, if the
 * node answered; this minute's record, if it could be read or computed in
 * time; and complete records of earlier minutes, newest first, for the tokens
 * this minute could not value.
 */
type CollateralView = {
  block:   BlockRef | null,
  current: CollateralMinute | null,
  earlier: CollateralMinute[],
};

function maxStaleMinutesOf(env: Pick<Env, 'TOKEN_COLLATERAL_MAX_STALE_MINUTES'>): number {
  // a var written unquoted reaches the worker as a number, whatever Env says
  const configured = String(env.TOKEN_COLLATERAL_MAX_STALE_MINUTES ?? '').trim();
  // an empty value is unset: Number('') is 0, which would switch the window off without saying so
  const minutes = configured === '' ? Number.NaN : Number(configured);
  return Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_STALE_MINUTES ? minutes : DEFAULT_MAX_STALE_MINUTES;
}

/*
 * Every collateral position of the chain's enabled markets, in a stable order.
 * A deprecated market is still served, but holds collateral nobody may add
 * to, so it is not part of what a token is worth on the chain.
 */
function positionsOf(catalog: Catalog, network: KnownNetwork.Name): Position[] {
  return catalog.marketsOn(network)
    .filter(entry => entry.market.status === 'enabled')
    .flatMap(entry => entry.market.collateralAssets.map(asset => ({
      key:           `${entry.comet.key()}#${asset.assetIndex}`,
      comet:         entry.comet,
      assetIndex:    asset.assetIndex,
      token:         asset.token.address,
      deploymentKey: entry.deploymentKey,
    })))
    // a copy, sorted: the catalog's arrays are shared by every request of the isolate
    .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function positionSetOf(positions: Position[]): string {
  return keccak256(canonicalJson(positions.map(position => position.key))).slice(0, 16);
}

function recordKey(chainId: number, positionSet: string, minute: number): string {
  return `token-collateral:v${RECORD_VERSION}:r${RULE_VERSION}:${chainId}:${positionSet}:${minute}`;
}

function storedOf(value: BigFixnum): StoredValue {
  return { value: value.value.toString(), decimals: value.decimals };
}

function valueOf(stored: StoredValue): BigFixnum {
  return BigFixnum.from({ value: stored.value, decimals: stored.decimals });
}

function outcomeOf(value: PositionValue): PositionOutcome {
  switch (value.status) {
    case 'success':   return { status: 'success', valueUsd: storedOf(value.valueUsd) };
    case 'exception': return { status: 'exception', valueUsd: storedOf(value.valueUsd), exceptions: value.exceptions };
    case 'error':     return { status: 'error', reason: value.reason };
  }
}

const isComplete = (record: CollateralMinute) => record.positions.every(entry => (
  entry.outcome.status !== 'error' || entry.outcome.reason !== 'transport'
));

function isRecord(value: unknown, key: { chainId: number, positionSet: string, minute: number }): value is CollateralMinute {
  const record = value as CollateralMinute | null;
  return typeof(record) === 'object' && record !== null
    && record.chainId === key.chainId && record.positionSet === key.positionSet && record.minute === key.minute
    && typeof(record.block?.number) === 'number' && typeof(record.block?.timestamp) === 'number'
    && Array.isArray(record.positions);
}

/*
 * The records an isolate holds, by KV namespace: minutes it computed or read,
 * the minutes being computed right now, and what it found looking back.
 */
type Isolate = {
  recent:   Map<string, { record: CollateralMinute, until: number | null }>,
  pending:  Map<string, { work: Promise<CollateralMinute>, startedAt: number }>,
  earlier:  Map<string, { records: CollateralMinute[], until: number }>,
};

const isolates = new WeakMap<KVNamespace, Isolate>();

function isolateOf(kv: KVNamespace): Isolate {
  let isolate = isolates.get(kv);
  if (isolate === undefined) {
    isolate = { recent: new Map(), pending: new Map(), earlier: new Map() };
    isolates.set(kv, isolate);
  }
  return isolate;
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  // the oldest entry goes first: a Map iterates in insertion order
  while (map.size > RECENT_RECORDS) {
    map.delete(map.keys().next().value!);
  }
}

const TIMED_OUT = Symbol('timed out');

async function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), milliseconds); });
  try {
    return await Promise.race([ work, deadline ]);
  } finally {
    clearTimeout(timer);
  }
}

function isQuotaFailure(error: unknown): boolean {
  return error instanceof Error && /InsufficientQuota/.test(error.message);
}

// a line a dashboard can count: what a request stopped waiting for, and after how long
function timedOut(chainId: number, phase: 'block' | 'minute' | 'lookback', started: number): void {
  console.log(JSON.stringify({ event: 'token_collateral_deadline', chainId, phase, ms: Date.now() - started }));
}

/*
 * The value of every position at one block. The whole chain is one
 * evaluation; if the node refuses part of it, the evaluation fails as a whole,
 * and the positions are split in halves, each evaluated again, until the
 * failing reads stand alone or the splits run out. What still fails is a
 * transport failure: it says nothing about the position.
 */
async function evaluatePositions(
  deps: TokenCollateralDeps,
  evaluator: Evaluator.Implementation<Dependencies>,
  network: KnownNetwork.Name,
  blockNumber: Eth.BlockNumber,
  positions: Position[],
  budget: { left: number },
): Promise<Map<string, PositionOutcome>> {
  const { evaluate, pull1, split } = evaluator;
  try {
    const values = await evaluate(split(positions.map(position => pull1({
      assetCollateralValue: {
        ...deps.frame,
        network,
        contract:   position.comet,
        assetIndex: position.assetIndex,
        blockNumber,
      },
    })))) as PositionValue[];
    return new Map(positions.map((position, index) => [ position.key, outcomeOf(values[index]!) ]));
  } catch (error) {
    if (positions.length === 1 || budget.left < 2 || isQuotaFailure(error)) {
      return new Map(positions.map(position => [ position.key, { status: 'error', reason: 'transport' } as const ]));
    }
    budget.left -= 2;
    const middle = Math.ceil(positions.length / 2);
    const [ left, right ] = await Promise.all([
      evaluatePositions(deps, evaluator, network, blockNumber, positions.slice(0, middle), budget),
      evaluatePositions(deps, evaluator, network, blockNumber, positions.slice(middle), budget),
    ]);
    return new Map([ ...left, ...right ]);
  }
}

type MinuteRequest = {
  chainId:     number,
  network:     KnownNetwork.Name,
  positions:   Position[],
  positionSet: string,
  // the version the request was answered from, for the log: a record is shared by every version that values the same positions
  versionId:   string,
};

async function computeMinute(
  deps: TokenCollateralDeps,
  evaluator: Evaluator.Implementation<Dependencies>,
  request: MinuteRequest,
  block: BlockRef,
  minute: number,
): Promise<CollateralMinute> {
  const started = Date.now();
  const budget  = { left: MAX_SPLIT_EVALUATIONS };
  const outcomes = await evaluatePositions(deps, evaluator, request.network, block.number, request.positions, budget);
  const record: CollateralMinute = {
    chainId:     request.chainId,
    minute,
    positionSet: request.positionSet,
    block,
    positions:   request.positions.map(position => ({
      key:     position.key,
      token:   position.token,
      outcome: outcomes.get(position.key) ?? { status: 'error', reason: 'transport' },
    })),
  };

  const failed: Record<string, number> = {};
  const failures: Array<{ market: string, assetIndex: number, reason: string }> = [];
  request.positions.forEach((position, index) => {
    const { outcome } = record.positions[index]!;
    if (outcome.status === 'error') {
      failed[outcome.reason] = (failed[outcome.reason] ?? 0) + 1;
      // which position failed, so a mismatch can be told from a feed that reverts; transport says nothing about one
      if (outcome.reason !== 'transport') {
        failures.push({ market: position.deploymentKey, assetIndex: position.assetIndex, reason: outcome.reason });
      }
    }
  });
  // a line a dashboard can count; it names categories and positions only, never an RPC message or a URL
  console.log(JSON.stringify({
    event:       'token_collateral_minute',
    chainId:     request.chainId,
    versionId:   request.versionId,
    positionSet: request.positionSet,
    minute,
    blockNumber: block.number,
    positions:   record.positions.length,
    failed,
    failures,
    evaluations: 1 + (MAX_SPLIT_EVALUATIONS - budget.left),
    ms:          Date.now() - started,
  }));
  return record;
}

const failedWhole = (record: CollateralMinute) => record.positions.every(entry => (
  entry.outcome.status === 'error' && entry.outcome.reason === 'transport'
));

/*
 * This minute's record: from the isolate, from a computation of it already
 * under way, from KV, or computed now. Only a complete record is written to
 * KV, with an expiry just past the stale window; one with transport failures
 * stays in the isolate for a few seconds, so a blip is neither repeated on
 * every request nor spread to every other isolate.
 *
 * A computation belongs to the isolate, not to the request that started it:
 * it is handed to waitUntil, so it finishes, and is kept, after that request
 * has stopped waiting for it and answered. One that has been in flight longer
 * than the runtime keeps such work was cancelled, and is started again.
 */
async function currentMinute(
  deps: TokenCollateralDeps,
  evaluator: Evaluator.Implementation<Dependencies>,
  kv: KVNamespace,
  request: MinuteRequest,
  block: BlockRef,
): Promise<CollateralMinute> {
  const isolate = isolateOf(kv);
  const minute  = Math.floor(block.timestamp / 60);
  const key     = recordKey(request.chainId, request.positionSet, minute);
  const now     = deps.now().getTime();

  const kept = isolate.recent.get(key);
  if (kept !== undefined && (kept.until === null || now < kept.until)) {
    return kept.record;
  }
  const pending = isolate.pending.get(key);
  if (pending !== undefined && now - pending.startedAt < ABANDONED_AFTER_MS) {
    return await pending.work;
  }

  const work = (async () => {
    try {
      const stored = await kv.get(key, 'json');
      if (isRecord(stored, { chainId: request.chainId, positionSet: request.positionSet, minute })) {
        remember(isolate.recent, key, { record: stored, until: null });
        return stored;
      }
    } catch (error) {
      // a KV that cannot be read is a cache miss, not a failure of the list
      deps.debug.error(`token collateral record could not be read`, { key, error });
    }

    const record = await computeMinute(deps, evaluator, request, block, minute);
    if (isComplete(record)) {
      remember(isolate.recent, key, { record, until: null });
      // the record already answers this isolate; KV is for the others, and is not waited for
      deps.waitUntil((async () => {
        try {
          await kv.put(key, JSON.stringify(record), { expirationTtl: Math.max(60, (deps.maxStaleMinutes + 2) * 60) });
        } catch (error) {
          deps.debug.error(`token collateral record could not be written`, { key, error });
        }
      })());
    } else {
      const backoff = failedWhole(record) ? CHAIN_FAILURE_BACKOFF_MS : INCOMPLETE_BACKOFF_MS;
      remember(isolate.recent, key, { record, until: deps.now().getTime() + backoff });
    }
    return record;
  })();

  const entry = { work, startedAt: now };
  remember(isolate.pending, key, entry);
  // a request that stops waiting answers without it; the work goes on for the next one
  deps.waitUntil(work.catch(() => {}));
  try {
    return await work;
  } finally {
    // a computation given up on may have been replaced by a newer one, which stays
    if (isolate.pending.get(key) === entry) {
      isolate.pending.delete(key);
    }
  }
}

/*
 * Complete records of the minutes before `minute`, newest first, as far back
 * as the stale window reaches. What was found — or not found — is kept for a
 * minute, so a token that cannot be valued does not cost every request a scan
 * of KV; a new minute looks back afresh. A minute this isolate holds only
 * incompletely is looked up in KV, where another isolate may have completed it.
 */
async function earlierMinutes(
  deps: TokenCollateralDeps,
  kv: KVNamespace,
  request: { chainId: number, positionSet: string },
  minute: number,
): Promise<CollateralMinute[]> {
  const isolate = isolateOf(kv);
  const lookup  = `${request.chainId}:${request.positionSet}:${minute}`;
  const now     = deps.now().getTime();
  const kept    = isolate.earlier.get(lookup);
  if (kept !== undefined && now < kept.until) {
    return kept.records;
  }

  const minutes = Array.from({ length: deps.maxStaleMinutes }, (_, index) => minute - 1 - index);
  const found = await Promise.all(minutes.map(async earlier => {
    const key    = recordKey(request.chainId, request.positionSet, earlier);
    const recent = isolate.recent.get(key);
    if (recent !== undefined && isComplete(recent.record)) {
      return recent.record;
    }
    try {
      const stored = await kv.get(key, 'json');
      return isRecord(stored, { chainId: request.chainId, positionSet: request.positionSet, minute: earlier }) ? stored : null;
    } catch (error) {
      deps.debug.error(`token collateral record could not be read`, { key, error });
      return null;
    }
  }));
  const records = found.filter((record): record is CollateralMinute => record !== null && isComplete(record));
  // measured on the clock: the block's own minute may already have ended when the node lags
  remember(isolate.earlier, lookup, { records, until: deps.now().getTime() + LOOKBACK_CACHE_MS });
  return records;
}

/*
 * What a request knows about the collateral of one chain. A latest block the
 * node does not give in time leaves only earlier minutes, looked back on from
 * the clock's minute; so does a minute that cannot be valued in time. The
 * node gets one deadline for both, and KV a short one of its own.
 */
async function collateralView(
  deps: TokenCollateralDeps,
  request: { chainId: number, network: KnownNetwork.Name, positions: Position[], versionId: string },
): Promise<CollateralView> {
  const networkEnv  = KnownNetwork.isNameOfTestnet(request.network) ? 'testnet' : 'mainnet';
  const evaluator   = deps.evaluator(networkEnv);
  const kv          = deps.kv(networkEnv);
  const started     = Date.now();
  // elapsed time is the runtime's, not the injected clock's: the clock names minutes, it does not time requests
  const left        = () => Math.max(0, started + (deps.deadlineMs ?? DEADLINE_MS) - Date.now());
  const positionSet = positionSetOf(request.positions);
  const keyed       = { ...request, positionSet };

  let block: BlockRef | null = null;
  try {
    const latest = await withDeadline(
      evaluator.evaluate(evaluator.pull1({
        ethGetBlock: { ...deps.frame, network: request.network, blockReference: 'latest' },
      })) as Promise<{ number: number, timestamp: number }>,
      left(),
    );
    if (latest === TIMED_OUT) {
      timedOut(request.chainId, 'block', started);
    } else {
      // only what identifies the block: the read carries its transactions too
      block = { number: latest.number, timestamp: latest.timestamp };
    }
  } catch (error) {
    deps.debug.error(`the latest block could not be read`, { chainId: request.chainId, error });
  }

  if (request.positions.length === 0) {
    return { block, current: null, earlier: [] };
  }

  let current: CollateralMinute | null = null;
  if (block !== null) {
    try {
      // started even with no time left, so that the next request of the minute finds it under way
      const minute = await withDeadline(currentMinute(deps, evaluator, kv, keyed, block), left());
      if (minute === TIMED_OUT) {
        timedOut(request.chainId, 'minute', started);
      } else {
        current = minute;
      }
    } catch (error) {
      deps.debug.error(`the token collateral of a minute could not be computed`, { chainId: request.chainId, error });
    }
  }

  const needsEarlier = current === null || current.positions.some(entry => entry.outcome.status === 'error');
  if (!needsEarlier || deps.maxStaleMinutes === 0) {
    return { block, current, earlier: [] };
  }
  const minute   = block === null ? Math.floor(deps.now().getTime() / 60_000) + 1 : Math.floor(block.timestamp / 60);
  const lookback = Date.now();
  const earlier  = await withDeadline(earlierMinutes(deps, kv, keyed, minute), LOOKBACK_DEADLINE_MS);
  if (earlier === TIMED_OUT) {
    timedOut(request.chainId, 'lookback', lookback);
  }
  return { block, current, earlier: earlier === TIMED_OUT ? [] : earlier };
}

/*
 * One token's value from a view: this minute's complete value; or, with
 * decision D7 of the TOK-0 audit, the part of this minute that could be read,
 * when that part alone already reaches the threshold; or the newest complete
 * earlier minute; or nothing.
 *
 * A token without an enabled collateral position is worth exactly nothing,
 * whatever the node says, so its value never depends on the node answering.
 */
type CollateralValueStatus = CollateralValueStatusV1;

type TokenValue = {
  status:          CollateralValueStatus,
  valueUsd:        BigFixnum | null,
  block:           BlockRef | null,
  staleAgeSeconds: number | null,
  exceptions:      PriceExceptionV1[],
};

const ok = (outcome: PositionOutcome): outcome is Exclude<PositionOutcome, { status: 'error' }> => outcome.status !== 'error';

function sumOf(outcomes: Array<Exclude<PositionOutcome, { status: 'error' }>>): BigFixnum {
  return outcomes.reduce((sum, outcome) => sum.add(valueOf(outcome.valueUsd)), BigFixnum.from({ value: 0 }));
}

// an exception as a record and a version both name it: what it does, and to which feed
const exceptionKey = (exception: PriceExceptionV1) => `${exception.kind}:${exception.priceFeedAddress}`;

/*
 * Each exception once, however many positions of the token it priced, as the
 * answering version describes it rather than as the record does: a record is
 * shared by every version that values its positions the same way, and may
 * have been valued under one that described an exception otherwise. Each of
 * those versions holds every exception the record names.
 */
function exceptionsOf(outcomes: PositionOutcome[], described: ReadonlyMap<string, PriceExceptionV1>): PriceExceptionV1[] {
  const seen = new Map<string, PriceExceptionV1>();
  for (const outcome of outcomes) {
    if (outcome.status === 'exception') {
      for (const exception of outcome.exceptions) {
        const key = exceptionKey(exception);
        seen.set(key, described.get(key) ?? exception);
      }
    }
  }
  return [ ...seen.values() ];
}

function tokenValue(
  token: Address,
  view: CollateralView,
  positions: Position[],
  threshold: BigFixnum,
  now: Date,
): TokenValue {
  const held = positions.filter(position => position.token === token);
  const keys = new Set(held.map(position => position.key));
  if (keys.size === 0) {
    return { status: 'fresh', valueUsd: BigFixnum.from({ value: 0 }), block: view.block, staleAgeSeconds: 0, exceptions: [] };
  }
  const of = (record: CollateralMinute) => record.positions.filter(entry => keys.has(entry.key)).map(entry => entry.outcome);
  // the exceptions of the network as the answering version describes them, which its positions carry
  const described = new Map(held.flatMap(position => position.comet.registry.priceExceptions)
    .map(exception => [ exceptionKey(exception), exception ] as const));
  const exceptionsIn = (outcomes: PositionOutcome[]) => exceptionsOf(outcomes, described);

  if (view.current !== null) {
    const outcomes = of(view.current);
    const readable = outcomes.filter(ok);
    if (readable.length === outcomes.length) {
      const exceptions = exceptionsIn(outcomes);
      return {
        status:          exceptions.length === 0 ? 'fresh' : 'exception',
        valueUsd:        sumOf(readable),
        block:           view.current.block,
        staleAgeSeconds: 0,
        exceptions,
      };
    }
    // values are never negative, so what could be read is a lower bound of the whole
    const partial = sumOf(readable);
    if (partial.gte(threshold)) {
      return { status: 'partial', valueUsd: partial, block: view.current.block, staleAgeSeconds: 0, exceptions: exceptionsIn(readable) };
    }
  }

  for (const record of view.earlier) {
    const outcomes = of(record);
    const readable = outcomes.filter(ok);
    if (readable.length === outcomes.length) {
      const reference = view.block?.timestamp ?? Math.floor(now.getTime() / 1000);
      return {
        status:          'stale',
        valueUsd:        sumOf(readable),
        block:           record.block,
        staleAgeSeconds: Math.max(1, reference - record.block.timestamp),
        exceptions:      exceptionsIn(outcomes),
      };
    }
  }

  return { status: 'unavailable', valueUsd: null, block: null, staleAgeSeconds: null, exceptions: [] };
}

export type {
  BlockRef,
  CollateralMinute,
  CollateralValueStatus,
  CollateralView,
  Dependencies,
  Position,
  PositionOutcome,
  TokenCollateralDeps,
  TokenValue,
};
export {
  ABANDONED_AFTER_MS,
  CHAIN_FAILURE_BACKOFF_MS,
  DEADLINE_MS,
  DEFAULT_MAX_STALE_MINUTES,
  INCOMPLETE_BACKOFF_MS,
  LOOKBACK_DEADLINE_MS,
  MAX_SPLIT_EVALUATIONS,
  RULE_VERSION,
  collateralView,
  maxStaleMinutesOf,
  positionSetOf,
  positionsOf,
  recordKey,
  tokenValue,
};
