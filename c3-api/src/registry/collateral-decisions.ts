import { keccak256 } from '../../lib/hash.js';
import { throttleBy } from '../../lib/throttle.js';

import {
  ActiveMarketV1,
  ActiveNetworkV1,
  ServedMarket,
  ServedNetwork,
  isAddress,
  normalizeAddress,
} from '../../lib/model/comet-registry.js';

import type { CacheDeps } from './cache.js';
import { RegistryUnavailable, isUnreachable } from './cache.js';
import { nowOf } from './clock.js';
import type { CollateralDecisionKind, CollateralOfComet } from './collateral-decision-repository.js';
import {
  DEPRECATED_COLLATERAL_KIND,
  HIDDEN_COLLATERAL_KIND,
  collateralKey,
  readMarkedCollaterals,
} from './collateral-decision-repository.js';
import { withDeadline } from './deadline.js';

/*
 * The decisions about collaterals of Comets that the active reads carry:
 * which collaterals of which Comets an administrator has marked deprecated,
 * and which ones hidden (collateral-decision-repository.ts), merged into the
 * active version's markets when an answer is made. The two kinds are read,
 * recorded, marked and answered with during an outage the same way, each
 * under a record and a flag of its own (RecordedKind, markedMarket), so what
 * is said here of the decisions is said of either kind's.
 *
 * A decision is no part of the version — it outlives every activation — so
 * the version stays cached as it was imported (cache.ts), and the decisions
 * are read beside it on every request, each kind's in one statement. An
 * answer names the flags it carries in its ETag, so a client holding a copy
 * made before a decision is sent the new one rather than told its copy is
 * current.
 *
 * During an outage the version is the one D1 last named (cache.ts), and the
 * flags are the decisions the Worker last recorded in KV: every command that
 * makes a decision records them once it has committed, and every isolate
 * checks the record against the decisions it reads, and writes them where it
 * differs, whenever they are not the ones it last found there, and every few
 * minutes besides. Such an answer says it could not be confirmed, as every
 * answer from the cache does. With nothing recorded there is nothing to
 * answer with, and the read fails as one does past the fallback window.
 */

/*
 * The decisions of one kind in force by collateral: a collateral nobody has
 * decided about, or one decided otherwise, is not among them.
 */
type CollateralDecisions = {
  collaterals: CollateralOfComet[],
  // whether the decisions name the collateral, its addresses lowercase
  has:         (collateral: CollateralOfComet) => boolean,
  // what tells two sets of decisions apart
  digest:      string,
};

// the decisions a read marks collaterals with, and whether they came from the record rather than from D1
type CollateralRead = { decisions: CollateralDecisions, recorded: boolean };

// what names a set of collaterals, in whatever order they were listed
function digestOf(keys: string[]): string {
  return keccak256([ ...keys ].sort().join(',')).slice(0, 16);
}

function collateralDecisionsOf(collaterals: CollateralOfComet[]): CollateralDecisions {
  const keys = collaterals.map(collateralKey);
  const held = new Set(keys);
  return {
    collaterals,
    has:    collateral => held.has(collateralKey(collateral)),
    digest: digestOf(keys),
  };
}

/*
 * The records an outage answers with, one a kind, in the registry's namespace
 * beside the pointer record (cache.ts), each under the key its kind names:
 * every chain's decisions, and when they were recorded. A record does not
 * expire. Decisions do not grow old, they change, and every change records
 * them again.
 */
const DEPRECATED_KEY = DEPRECATED_COLLATERAL_KIND.recordKey;
const HIDDEN_KEY     = HIDDEN_COLLATERAL_KIND.recordKey;

type CollateralRecord = { at: string, collaterals: CollateralOfComet[] };

function recordOf(value: unknown): CollateralOfComet[] | null {
  const record = value as CollateralRecord | null;
  if (record === null || typeof(record) !== 'object' || typeof(record.at) !== 'string' || !Array.isArray(record.collaterals)) {
    return null;
  }
  const collaterals = record.collaterals as unknown[];
  const valid = collaterals.every(entry => {
    const collateral = entry as Partial<CollateralOfComet> | null;
    return collateral !== null && typeof(collateral) === 'object'
      && typeof(collateral.chainId) === 'number' && Number.isSafeInteger(collateral.chainId) && collateral.chainId > 0
      && isAddress(collateral.cometAddress) && isAddress(collateral.tokenAddress);
  });
  return valid
    ? record.collaterals.map(({ chainId, cometAddress, tokenAddress }) => ({
        chainId,
        cometAddress: normalizeAddress(cometAddress),
        tokenAddress: normalizeAddress(tokenAddress),
      }))
    : null;
}

/*
 * What each isolate knows of a kind's record, per namespace: the decisions it
 * last found there or wrote there, or set out to, by their digest; until when
 * the reads of those decisions leave the record alone; and the check under
 * way, if one is.
 *
 * KV takes one write a second to a key, and keeps whichever write reaches it
 * last. So a read writes the record only where it does not hold the decisions
 * the read found, and the isolates of a deploy, starting together, mostly find
 * them there and write nothing; one whose write was refused tries again a
 * minute later, not on every request it answers. And a read that began before
 * a decision can write after the decision's own record, putting back the
 * decisions before it, so an isolate checks the record again every five
 * minutes while the decisions it reads stay the same: such a record is put
 * right by the first check after it.
 *
 * A check holds the record for a minute when it starts, and the five minutes
 * run only once it is done. A check the runtime cut off never finishes, and
 * so is made again a minute later, as one KV refused is.
 */
type Known = {
  digest:  string,
  // until when the reads of these decisions leave the record alone
  due:     number,
  // the check under way, which sets `due` once it is done
  pending: Promise<void> | null,
};

/*
 * A kind of decision as its record is kept: the record's key, what a log line
 * calls the kind, its read of every chain's decisions from D1, and what each
 * isolate knows of its record, which is the kind's own, as the record is.
 */
type RecordedKind = {
  key:   string,
  noun:  string,
  read:  (db: D1Database) => Promise<CollateralOfComet[]>,
  known: WeakMap<KVNamespace, Known>,
};

/*
 * The record of a kind of decision about a collateral, as the kind describes
 * it (collateral-decision-repository.ts). Its read of every chain's decisions
 * is the token list's too (token-handlers.ts).
 */
function recordedKind<Flag extends string, Column extends string, Rows extends string>(
  kind: CollateralDecisionKind<Flag, Column, Rows>,
): RecordedKind {
  return {
    key:   kind.recordKey,
    noun:  kind.label,
    read:  async db => await readMarkedCollaterals(db, kind),
    known: new WeakMap(),
  };
}

// made once, here: what an isolate knows of a record is kept in its kind, so a kind made anew would know nothing
const DEPRECATED_RECORD = recordedKind(DEPRECATED_COLLATERAL_KIND);
const HIDDEN_RECORD     = recordedKind(HIDDEN_COLLATERAL_KIND);

const CHECK_RECORD_EVERY_MS = 300_000;
const RETRY_RECORD_AFTER_MS = 60_000;

function timeOf(deps: CacheDeps): number {
  return nowOf(deps.now).getTime();
}

// whether the record holds these decisions; one that cannot be read, or is not a record, does not
async function recordHolds(kind: RecordedKind, deps: CacheDeps, decisions: CollateralDecisions): Promise<boolean> {
  let collaterals: CollateralOfComet[] | null;
  try {
    collaterals = recordOf(await deps.kv.get(kind.key, 'json'));
  } catch {
    return false;
  }
  return collaterals !== null && collateralDecisionsOf(collaterals).digest === decisions.digest;
}

/*
 * Writes the decisions, unless `check` finds the record holding them already,
 * and says whether KV refused them. It never fails: the answer, or the
 * command, is already made, and failing to record it must not fail it.
 */
async function writeRecord(kind: RecordedKind, deps: CacheDeps, decisions: CollateralDecisions, check: boolean): Promise<boolean> {
  try {
    if (check && await recordHolds(kind, deps, decisions)) {
      return false;
    }
    const record: CollateralRecord = { at: new Date(timeOf(deps)).toISOString(), collaterals: decisions.collaterals };
    await deps.kv.put(kind.key, JSON.stringify(record));
    return false;
  } catch (error) {
    deps.debug.warn(`${kind.noun} record unwritable`, { error });
    return true;
  }
}

/*
 * Makes the record hold these decisions, then has what this isolate knows of
 * the record say so. A check that a later one replaced meanwhile settles only
 * itself, so what it found never overwrites what the later one finds.
 */
function record(kind: RecordedKind, deps: CacheDeps, decisions: CollateralDecisions, check: boolean): Promise<void> {
  const entry: Known = { digest: decisions.digest, due: timeOf(deps) + RETRY_RECORD_AFTER_MS, pending: null };
  kind.known.set(deps.kv, entry);
  entry.pending = writeRecord(kind, deps, decisions, check).then(refused => {
    entry.due     = timeOf(deps) + (refused ? RETRY_RECORD_AFTER_MS : CHECK_RECORD_EVERY_MS);
    entry.pending = null;
  });
  return entry.pending;
}

/*
 * Records the decisions a read found, where the record may not hold them:
 * they are not the ones this isolate last found there or wrote, which an
 * isolate that has checked nothing yet never has; or it last found or wrote
 * them five minutes ago; or KV refused them, or the runtime cut their check
 * off, a minute ago. An environment without a fallback window never answers
 * from the record, so nothing writes it there.
 *
 * The answer does not wait for the check: it is handed to the request's
 * waitUntil (`defer`), as the pointer record's write is (cache.ts).
 */
async function remember(kind: RecordedKind, deps: CacheDeps, decisions: CollateralDecisions): Promise<void> {
  if (deps.staleSeconds <= 0) {
    return;
  }
  const last = kind.known.get(deps.kv);
  if (last?.digest === decisions.digest && timeOf(deps) < last.due) {
    return;
  }
  const checking = record(kind, deps, decisions, true);
  if (deps.defer === undefined) {
    await checking;
  } else {
    deps.defer(checking);
  }
}

// whether `work` settles within `milliseconds`: the runtime's own time, which is what cuts work off
async function settlesWithin(work: Promise<void>, milliseconds: number): Promise<boolean> {
  return milliseconds > 0 && await withDeadline(work.then(() => true, () => true), milliseconds) === true;
}

/*
 * What a command that may have changed the decisions does once it has
 * committed: records them, as D1 now holds them, whatever this isolate found
 * in the record before, unless one of its reads is recording these very
 * decisions already. The command waits for that check while it holds the
 * record and no longer: one the runtime cut off never finishes, and the
 * command then records the decisions itself. It waits for its own write
 * rather than hand it to waitUntil, as a read hands its check: an outage
 * right after the command answers with its decision.
 *
 * It never fails the command, which has committed already; a record it could
 * not write is written by a later read (remember): of any isolate that last
 * found other decisions there, or of this one a minute later.
 */
async function recordCollaterals(kind: RecordedKind, deps: CacheDeps): Promise<void> {
  if (deps.staleSeconds <= 0) {
    return;
  }
  let decisions: CollateralDecisions;
  try {
    decisions = collateralDecisionsOf(await kind.read(deps.db));
  } catch (error) {
    deps.debug.warn(`${kind.noun} record not written: the decisions could not be read`, { error });
    return;
  }
  const last = kind.known.get(deps.kv);
  if (last !== undefined && last.digest === decisions.digest && last.pending !== null
    && await settlesWithin(last.pending, last.due - timeOf(deps))) {
    return;
  }
  await record(kind, deps, decisions, false);
}

/*
 * The decisions the Worker last recorded, for a read D1 could not answer. A
 * namespace that does not answer, a record that is not one, or none at all,
 * leaves the read nothing to answer with: the registry is unavailable, as it
 * is past the fallback window.
 */
async function recordedDecisions(kind: RecordedKind, deps: CacheDeps, cause: unknown): Promise<CollateralDecisions> {
  const unavailable = () => new RegistryUnavailable(`the ${kind.noun} decisions could not be read`, cause);
  let value: unknown;
  try {
    value = await deps.kv.get(kind.key, 'json');
  } catch (error) {
    deps.debug.warn(`${kind.noun} record unreadable`, { error });
    throw unavailable();
  }
  const collaterals = recordOf(value);
  if (collaterals === null) {
    throw unavailable();
  }
  return collateralDecisionsOf(collaterals);
}

/*
 * When this isolate says it answers with a kind's recorded decisions, per
 * database binding: once a minute, as the cache says it answers from an older
 * version, rather than once a request.
 */
const fallbackDue = throttleBy<D1Database>(60_000);

function reportFallback(kind: RecordedKind, deps: CacheDeps, error: unknown): void {
  if (!fallbackDue(deps.db, kind.key, timeOf(deps))) {
    return;
  }
  deps.debug.warn(`${kind.noun} decisions unreadable; answering with the ones last recorded`, { error });
}

/*
 * The decisions of a kind the active reads mark collaterals with: every
 * chain's, from D1, or — when D1 could not be reached, in an environment that
 * answers from the cache at all — the ones last recorded. A database that
 * answered with a fault, such as a release ahead of the kind's migration, is
 * raised as it is.
 */
async function markedDecisions(kind: RecordedKind, deps: CacheDeps): Promise<CollateralRead> {
  let decisions: CollateralDecisions;
  try {
    decisions = collateralDecisionsOf(await kind.read(deps.db));
  } catch (error) {
    if (!isUnreachable(error)) {
      throw error;
    }
    if (deps.staleSeconds <= 0) {
      throw new RegistryUnavailable(`the comet registry could not be read`, error);
    }
    const last = await recordedDecisions(kind, deps, error);
    reportFallback(kind, deps, error);
    return { decisions: last, recorded: true };
  }
  await remember(kind, deps, decisions);
  return { decisions, recorded: false };
}

// the decisions of each kind the active reads mark collaterals with
type CollateralMarks = { deprecated: CollateralDecisions, hidden: CollateralDecisions };

/*
 * Both kinds' decisions, for the active reads, which mark every collateral
 * with each: read side by side, each kind by a statement of its own, and said
 * to come from a record where either kind's did. A kind that could not be
 * read fails the read, the deprecated kind first. /summary, which answers
 * without a kind it could not read, reads each kind apart.
 */
async function readMarks(deps: CacheDeps): Promise<{ marks: CollateralMarks, recorded: boolean }> {
  const [ deprecated, hidden ] = await Promise.allSettled([ markedDecisions(DEPRECATED_RECORD, deps), markedDecisions(HIDDEN_RECORD, deps) ]);
  if (deprecated.status === 'rejected') {
    throw deprecated.reason;
  }
  if (hidden.status === 'rejected') {
    throw hidden.reason;
  }
  return {
    marks:    { deprecated: deprecated.value.decisions, hidden: hidden.value.decisions },
    recorded: deprecated.value.recorded || hidden.value.recorded,
  };
}

/*
 * A market as the active reads serve it: every collateral says whether it is
 * deprecated in this Comet, and whether it is hidden there. The version's own
 * objects are left as they are, since the cache hands one snapshot to every
 * request of an isolate.
 */
function markedMarket(chainId: number, market: ServedMarket, { deprecated, hidden }: CollateralMarks): ActiveMarketV1 {
  const comet = market.contracts.comet;
  return {
    ...market,
    collateralAssets: market.collateralAssets.map(asset => {
      const collateral = { chainId, cometAddress: comet, tokenAddress: asset.token.address };
      return { ...asset, isDeprecated: deprecated.has(collateral), isHidden: hidden.has(collateral) };
    }),
  };
}

function markedNetwork(network: ServedNetwork, marks: CollateralMarks): ActiveNetworkV1 {
  return { ...network, markets: network.markets.map(market => markedMarket(network.chainId, market, marks)) };
}

/*
 * The representation an answer that carries the flags is tagged by: its name,
 * and for each flag a digest of the collaterals it flags, the deprecated ones
 * first. The version's id and checksum name the rest of it (handlers.ts,
 * etagOf), but the flags change without a new version, so a decision that
 * changes what an answer flags changes its tag. A decision about a collateral
 * the answer does not list leaves both as they are.
 */
function markedRepresentation(name: string, networks: Array<{ chainId: number, markets: ActiveMarketV1[] }>): string {
  const flagged = (flag: 'isDeprecated' | 'isHidden') => networks.flatMap(network => network.markets.flatMap(market => market.collateralAssets
    .filter(asset => asset[flag])
    .map(asset => collateralKey({ chainId: network.chainId, cometAddress: market.contracts.comet, tokenAddress: asset.token.address }))));
  return `${name}+deprecated-${digestOf(flagged('isDeprecated'))}+hidden-${digestOf(flagged('isHidden'))}`;
}

export type { CollateralMarks, CollateralRead, RecordedKind };
export {
  DEPRECATED_KEY,
  DEPRECATED_RECORD,
  HIDDEN_KEY,
  HIDDEN_RECORD,
  collateralDecisionsOf,
  markedDecisions,
  markedMarket,
  markedNetwork,
  markedRepresentation,
  readMarks,
  recordCollaterals,
};
