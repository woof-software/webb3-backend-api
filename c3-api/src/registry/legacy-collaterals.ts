import { keccak256 } from '../../lib/hash.js';

import {
  ActiveMarketV1,
  ActiveNetworkV1,
  Address,
  MarketV1,
  NetworkV1,
  isAddress,
  normalizeAddress,
} from '../../lib/model/comet-registry.js';

import type { CacheDeps } from './cache.js';
import { RegistryUnavailable, isUnreachable } from './cache.js';
import type { LegacyCollateral } from './legacy-collateral-repository.js';
import { readLegacyCollaterals } from './legacy-collateral-repository.js';

/*
 * The legacy flags the active reads carry: which collaterals of which Comets
 * an administrator has marked legacy, merged into the active version's
 * markets when an answer is made.
 *
 * A decision is no part of the version — it outlives every activation — so
 * the version stays cached as it was imported (cache.ts), and the decisions
 * are read beside it on every request, in one statement. An answer names the
 * flags it carries in its ETag, so a client holding a copy made before a
 * decision is sent the new one rather than told its copy is current.
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
 * The decisions in force by collateral: a collateral nobody has decided
 * about, or one decided not legacy, is not among them.
 */
type LegacyDecisions = {
  collaterals: LegacyCollateral[],
  // whether the collateral `token` of the Comet at `comet` on `chainId` is legacy; addresses lowercase
  has:         (chainId: number, comet: Address, token: Address) => boolean,
  // what tells two sets of decisions apart
  digest:      string,
};

// the decisions a read marks collaterals with, and whether they came from the record rather than from D1
type LegacyRead = { decisions: LegacyDecisions, recorded: boolean };

function keyOf(chainId: number, comet: Address, token: Address): string {
  return `${chainId}:${comet}:${token}`;
}

// what names a set of collaterals, in whatever order they were listed
function digestOf(keys: string[]): string {
  return keccak256([ ...keys ].sort().join(',')).slice(0, 16);
}

function legacyDecisionsOf(collaterals: LegacyCollateral[]): LegacyDecisions {
  const keys = collaterals.map(({ chainId, cometAddress, tokenAddress }) => keyOf(chainId, cometAddress, tokenAddress));
  const held = new Set(keys);
  return {
    collaterals,
    has:    (chainId, comet, token) => held.has(keyOf(chainId, comet, token)),
    digest: digestOf(keys),
  };
}

/*
 * The record an outage answers with, in the registry's namespace beside the
 * pointer record (cache.ts): every chain's decisions, and when they were
 * recorded. It does not expire. Decisions do not grow old, they change, and
 * every change records them again.
 */
const LEGACY_KEY = 'legacy-collaterals:v1';

type LegacyRecord = { at: string, collaterals: LegacyCollateral[] };

// the collaterals of a record, or null for a value that is not one
function recordOf(value: unknown): LegacyCollateral[] | null {
  const record = value as LegacyRecord | null;
  if (record === null || typeof(record) !== 'object' || typeof(record.at) !== 'string' || !Array.isArray(record.collaterals)) {
    return null;
  }
  const collaterals = record.collaterals as unknown[];
  const valid = collaterals.every(entry => {
    const collateral = entry as Partial<LegacyCollateral> | null;
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
 * What each isolate knows of the record, per namespace: the decisions it last
 * found there or wrote there, by their digest; when it did, or when KV refused
 * them; and the check under way, if one is, which every read of the same
 * decisions leaves the record to meanwhile.
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
 */
type Known = {
  digest:  string,
  // when the record was last found or made to hold them, or refused them
  at:      number,
  refused: boolean,
  // the check under way, which sets the two above once it is done
  pending: Promise<void> | null,
};

const known = new WeakMap<KVNamespace, Known>();

const CHECK_RECORD_EVERY_MS = 300_000;
const RETRY_RECORD_AFTER_MS = 60_000;

function timeOf(deps: CacheDeps): number {
  return (deps.now?.() ?? new Date()).getTime();
}

// whether the record holds these decisions; one that cannot be read, or is not a record, does not
async function recordHolds(deps: CacheDeps, decisions: LegacyDecisions): Promise<boolean> {
  let collaterals: LegacyCollateral[] | null;
  try {
    collaterals = recordOf(await deps.kv.get(LEGACY_KEY, 'json'));
  } catch {
    return false;
  }
  return collaterals !== null && legacyDecisionsOf(collaterals).digest === decisions.digest;
}

/*
 * Writes the decisions, unless `check` finds the record holding them already,
 * and says whether KV refused them. It never fails: the answer, or the
 * command, is already made, and failing to record it must not fail it.
 */
async function writeRecord(deps: CacheDeps, decisions: LegacyDecisions, check: boolean): Promise<boolean> {
  try {
    if (check && await recordHolds(deps, decisions)) {
      return false;
    }
    const record: LegacyRecord = { at: new Date(timeOf(deps)).toISOString(), collaterals: decisions.collaterals };
    await deps.kv.put(LEGACY_KEY, JSON.stringify(record));
    return false;
  } catch (error) {
    deps.debug?.warn(`legacy collateral record unwritable`, { error });
    return true;
  }
}

/*
 * Makes the record hold these decisions, then has what this isolate knows of
 * the record say so. A check that a later one replaced meanwhile settles only
 * itself, so what it found never overwrites what the later one finds.
 */
async function record(deps: CacheDeps, decisions: LegacyDecisions, check: boolean): Promise<void> {
  const entry: Known = { digest: decisions.digest, at: timeOf(deps), refused: false, pending: null };
  known.set(deps.kv, entry);
  entry.pending = writeRecord(deps, decisions, check).then(refused => {
    entry.at      = timeOf(deps);
    entry.refused = refused;
    entry.pending = null;
  });
  await entry.pending;
}

/*
 * Records the decisions a read found, where the record may not hold them:
 * they are not the ones this isolate last found there or wrote, which an
 * isolate that has checked nothing yet never has; or it last found or wrote
 * them five minutes ago; or KV refused them a minute ago. An environment
 * without a fallback window never answers from the record, so nothing writes
 * it there.
 */
async function rememberLegacy(deps: CacheDeps, decisions: LegacyDecisions): Promise<void> {
  if (deps.staleSeconds <= 0) {
    return;
  }
  const last = known.get(deps.kv);
  if (last?.digest === decisions.digest) {
    const due = last.refused ? RETRY_RECORD_AFTER_MS : CHECK_RECORD_EVERY_MS;
    if (last.pending !== null || timeOf(deps) - last.at < due) {
      return;
    }
  }
  await record(deps, decisions, true);
}

/*
 * What a command that may have changed the decisions does once it has
 * committed: records them, as D1 now holds them, whatever this isolate found
 * in the record before, unless one of its reads is recording these very
 * decisions already. It never fails the command, which has committed already;
 * a record it could not write is written by a later read (rememberLegacy): of
 * any isolate that last found other decisions there, or of this one a minute
 * later.
 */
async function recordLegacyCollaterals(deps: CacheDeps): Promise<void> {
  if (deps.staleSeconds <= 0) {
    return;
  }
  let decisions: LegacyDecisions;
  try {
    decisions = legacyDecisionsOf(await readLegacyCollaterals(deps.db));
  } catch (error) {
    deps.debug?.warn(`legacy collateral record not written: the decisions could not be read`, { error });
    return;
  }
  const last = known.get(deps.kv);
  if (last?.digest === decisions.digest && last.pending !== null) {
    await last.pending;
    return;
  }
  await record(deps, decisions, false);
}

/*
 * The decisions the Worker last recorded, for a read D1 could not answer. A
 * namespace that does not answer, a record that is not one, or none at all,
 * leaves the read nothing to answer with: the registry is unavailable, as it
 * is past the fallback window.
 */
async function recordedLegacy(deps: CacheDeps, cause: unknown): Promise<LegacyDecisions> {
  const unavailable = () => new RegistryUnavailable(`the legacy collateral decisions could not be read`, 'unreadable', cause);
  let value: unknown;
  try {
    value = await deps.kv.get(LEGACY_KEY, 'json');
  } catch (error) {
    deps.debug?.warn(`legacy collateral record unreadable`, { error });
    throw unavailable();
  }
  const collaterals = recordOf(value);
  if (collaterals === null) {
    throw unavailable();
  }
  return legacyDecisionsOf(collaterals);
}

/*
 * When this isolate last said it answers with the recorded decisions, per
 * database binding: once a minute, as the cache says it answers from an older
 * version, rather than once a request.
 */
const reportedFallback = new WeakMap<D1Database, number>();

const REPORT_FALLBACK_EVERY_MS = 60_000;

function reportFallback(deps: CacheDeps, error: unknown): void {
  const at   = timeOf(deps);
  const last = reportedFallback.get(deps.db);
  if (last !== undefined && at - last < REPORT_FALLBACK_EVERY_MS) {
    return;
  }
  reportedFallback.set(deps.db, at);
  deps.debug?.warn(`legacy collateral decisions unreadable; answering with the ones last recorded`, { error });
}

/*
 * The decisions the active reads mark collaterals with: every chain's, from
 * D1, or — when D1 could not be reached, in an environment that answers from
 * the cache at all — the ones last recorded. A database that answered with a
 * fault, such as a release ahead of migration 0006, is raised as it is.
 */
async function legacyDecisions(deps: CacheDeps): Promise<LegacyRead> {
  let decisions: LegacyDecisions;
  try {
    decisions = legacyDecisionsOf(await readLegacyCollaterals(deps.db));
  } catch (error) {
    if (!isUnreachable(error)) {
      throw error;
    }
    if (deps.staleSeconds <= 0) {
      throw new RegistryUnavailable(`the comet registry could not be read`, 'unreadable', error);
    }
    const last = await recordedLegacy(deps, error);
    reportFallback(deps, error);
    return { decisions: last, recorded: true };
  }
  await rememberLegacy(deps, decisions);
  return { decisions, recorded: false };
}

/*
 * A market as the active reads serve it: every collateral says whether it is
 * legacy in this Comet. The version's own objects are left as they are, since
 * the cache hands one snapshot to every request of an isolate.
 */
function markedMarket(chainId: number, market: MarketV1, legacy: LegacyDecisions): ActiveMarketV1 {
  const comet = market.contracts.comet;
  return {
    ...market,
    collateralAssets: market.collateralAssets.map(asset => ({
      ...asset,
      isLegacy: comet !== null && legacy.has(chainId, comet, asset.token.address),
    })),
  };
}

function markedNetwork(network: NetworkV1, legacy: LegacyDecisions): ActiveNetworkV1 {
  return { ...network, markets: network.markets.map(market => markedMarket(network.chainId, market, legacy)) };
}

/*
 * The representation an answer that carries the flags is tagged by: its name,
 * and a digest of the collaterals it flags. The version's id and checksum name
 * the rest of it (handlers.ts, etagOf), but the flags change without a new
 * version, so a decision that changes what an answer flags changes its tag. A
 * decision about a collateral the answer does not list leaves both as they
 * are.
 */
function legacyRepresentation(name: string, networks: Array<{ chainId: number, markets: ActiveMarketV1[] }>): string {
  const flagged = networks.flatMap(network => network.markets.flatMap(market => market.collateralAssets
    .filter(asset => asset.isLegacy)
    .map(asset => keyOf(network.chainId, market.contracts.comet!, asset.token.address))));
  return `${name}+legacy-${digestOf(flagged)}`;
}

export type { LegacyDecisions, LegacyRead };
export {
  LEGACY_KEY,
  legacyDecisions,
  legacyDecisionsOf,
  legacyRepresentation,
  markedMarket,
  markedNetwork,
  recordLegacyCollaterals,
};
