import type { Env } from '../../entrypoint.js';

import type { RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';

import { readActivePointer, readRegistrySnapshot, readVersion } from './repository.js';
import type { VersionRef } from './version-headers.js';

/*
 * The snapshot cache: what a request reads instead of hydrating the active
 * version out of D1 again, and what it falls back to when D1 does not answer.
 *
 * Two facts make this safe. A version is immutable once it exists — its rows
 * are frozen and its checksum says so — and only the pointer to the active
 * one moves. So the bytes of a version are cached under a key that names the
 * version and its checksum, and are never invalidated; what a request
 * verifies against D1 is the pointer alone, which is one statement.
 *
 * D1 stays authoritative. The cache never decides which version is active,
 * and it never answers in place of a D1 that said there is no active version:
 * that is an answer, not an outage. It answers only when D1 could not be
 * reached at all, and then it says so, with the age of what it served, so a
 * caller is never told an old version is the current one.
 */
type CacheSource = 'origin' | 'cache' | 'stale';

type CachedSnapshot = {
  snapshot: RegistrySnapshotV1,
  // where the bytes came from, which the response reports and metrics count
  source:   CacheSource,
  // how old the pointer is, in seconds, when the answer is stale
  staleFor: number | null,
};

type CacheDeps = {
  db:      D1Database,
  kv:      KVNamespace,
  // what the environment configures; see maxAgeOf/staleWindowOf in router.ts
  ttlSeconds:   number,
  staleSeconds: number,
  now?:    () => Date,
  debug?:  { error: (...parameters: unknown[]) => unknown },
};

/*
 * The schema the cached bytes are written in. A change to RegistrySnapshotV1
 * changes this, so entries written by an older release are never read by a
 * newer one: they are a different representation of the same version.
 */
const SCHEMA = 'v1';

// KV refuses an expiration under a minute, and a cache that short would not be one
const MIN_TTL_SECONDS = 60;

// how often an isolate rewrites the pointer record while D1 keeps answering
const POINTER_REFRESH_SECONDS = 300;

/*
 * What the environment configures. The TTL doubles as the max-age public
 * reads advertise, and the fallback window is how old an answer may be when
 * D1 cannot be reached; zero switches the fallback off, which is what an
 * environment that would rather fail than serve an older version sets.
 */
function cacheDepsOf(env: Env, debug?: CacheDeps['debug']): CacheDeps {
  const ttl   = Number(env.REGISTRY_SNAPSHOT_CACHE_TTL_S);
  const stale = Number(env.REGISTRY_STALE_FALLBACK_MAX_S);
  return {
    db:           env.APP_DB,
    kv:           env.kv_registry,
    ttlSeconds:   Number.isInteger(ttl)   && ttl   >  0 ? ttl   : 300,
    staleSeconds: Number.isInteger(stale) && stale >= 0 ? stale : 3600,
    ...(debug === undefined ? {} : { debug }),
  };
}

function snapshotKey({ id, checksum }: VersionRef): string {
  return `snapshot:${SCHEMA}:${id}:${checksum}`;
}

/*
 * The pointer as it was last read successfully. It exists only for the
 * outage path: it is what tells a request which version to look for when D1
 * cannot be asked, and when that pointer was true.
 */
const POINTER_KEY = `active:${SCHEMA}`;

type PointerRecord = VersionRef & { at: string };

// what a cached entry remembers about itself: when it was written
type Stored = { at: number };

function ttlOf({ ttlSeconds, staleSeconds }: CacheDeps): number {
  /*
   * A version's bytes outlive the pointer record that names them: they have
   * to still be there for the whole fallback window, or the fallback has
   * nothing to serve.
   */
  return Math.max(ttlSeconds, staleSeconds, MIN_TTL_SECONDS);
}

function now(deps: CacheDeps): Date {
  return deps.now?.() ?? new Date();
}

/*
 * A cached snapshot is trusted only when it is the one that was asked for.
 * The key already names the version and checksum; this rejects an entry whose
 * body disagrees with its own key, which is what a partial write or a
 * hand-edited namespace looks like.
 */
function snapshotOf(value: unknown, pointer: VersionRef): RegistrySnapshotV1 | null {
  const snapshot = value as RegistrySnapshotV1 | null;
  if (snapshot === null || typeof(snapshot) !== 'object') {
    return null;
  }
  const version = snapshot.registryVersion;
  if (version?.id !== pointer.id || version?.checksum !== pointer.checksum) {
    return null;
  }
  /*
   * The shape as well as the identity. An entry that names the right version
   * but is not a snapshot would be trusted all the way into the catalog and
   * fail there, on every request, until it expired; here it is merely a miss,
   * and D1 answers instead.
   */
  if (!Array.isArray(snapshot.networks)) {
    return null;
  }
  return snapshot;
}

async function cachedSnapshot(deps: CacheDeps, pointer: VersionRef): Promise<RegistrySnapshotV1 | null> {
  let value: unknown;
  let metadata: Stored | null = null;
  try {
    const entry = await deps.kv.getWithMetadata(snapshotKey(pointer), 'json');
    value    = entry.value;
    metadata = (entry.metadata ?? null) as Stored | null;
  } catch (error) {
    // a cache that cannot be read is a slow request, never a failed one
    deps.debug?.error(`registry snapshot cache unreadable`, { versionId: pointer.id, error });
    return null;
  }
  if (value === null || value === undefined) {
    // an ordinary miss: there is nothing to discard, and D1 answers
    return null;
  }

  const cached = snapshotOf(value, pointer);
  if (cached === null) {
    /*
     * Something is under the key that is not the version it names. It would
     * be read by every isolate until it expired, so it is discarded and the
     * caller writes the version again from D1.
     */
    await dropCached(deps, pointer);
    return null;
  }

  await refreshEntry(deps, pointer, cached, metadata);
  return cached;
}

/*
 * The bytes of a version expire, and they are written once — so a version
 * that stays active longer than one expiry would vanish from under the
 * fallback that still names it. An entry that has lived half its life is
 * written again by the request that read it, which keeps a version cached
 * for as long as it is being served and lets one nobody serves expire.
 */
async function refreshEntry(
  deps: CacheDeps,
  pointer: VersionRef,
  snapshot: RegistrySnapshotV1,
  metadata: Stored | null,
): Promise<void> {
  const ttl = ttlOf(deps);
  const at  = metadata?.at ?? 0;
  if (now(deps).getTime() - at < ttl * 1000 / 2) {
    return;
  }
  await writeSnapshot(deps, pointer, snapshot);
}

// whether the bytes of a version are cached, without pulling them over the network
async function isCached(deps: CacheDeps, pointer: VersionRef): Promise<boolean> {
  const listed = await deps.kv.list({ prefix: snapshotKey(pointer) });
  return listed.keys.length > 0;
}

async function dropCached(deps: CacheDeps, pointer: VersionRef): Promise<void> {
  try {
    if (await isCached(deps, pointer)) {
      await deps.kv.delete(snapshotKey(pointer));
      deps.debug?.error(`registry snapshot cache entry discarded`, { versionId: pointer.id });
    }
  } catch (error) {
    deps.debug?.error(`registry snapshot cache entry not discarded`, { versionId: pointer.id, error });
  }
}

/*
 * Writes the bytes of one version. The key contains the checksum of the
 * content, so a write is always the same bytes: what changes is when they
 * were written, which is what decides the next refresh.
 */
async function writeSnapshot(deps: CacheDeps, pointer: VersionRef, snapshot: RegistrySnapshotV1): Promise<void> {
  try {
    await deps.kv.put(snapshotKey(pointer), JSON.stringify(snapshot), {
      expirationTtl: ttlOf(deps),
      // when these bytes were written, which is what refreshEntry reads
      metadata: { at: now(deps).getTime() } satisfies Stored,
    });
  } catch (error) {
    // the answer is already computed; failing to remember it must not fail it
    deps.debug?.error(`registry snapshot cache unwritable`, { versionId: pointer.id, error });
  }
}

/*
 * When this isolate last wrote the pointer record, per namespace.
 *
 * The record is what an outage falls back to, so it has to stay recent while
 * D1 is healthy — but writing it on every request would spend a KV write per
 * request on a value that almost never changes, and KV throttles repeated
 * writes to one key. An isolate therefore refreshes it at most twice per
 * fallback window, and whenever the pointer it sees is a different version.
 */
const written = new WeakMap<KVNamespace, { ref: string, at: number }>();

function refOf({ id, checksum }: VersionRef): string {
  return `${id}:${checksum}`;
}

async function rememberPointer(deps: CacheDeps, pointer: VersionRef): Promise<void> {
  if (deps.staleSeconds <= 0) {
    // with no fallback window nothing ever reads this record, so nothing writes it
    return;
  }
  const at     = now(deps).getTime();
  const last   = written.get(deps.kv);
  /*
   * The age of this record is what a fallback reports and what the window is
   * measured from, so a record refreshed rarely would both overstate how old
   * an answer is and cut the window short. Refreshing it every few minutes
   * keeps both within that few minutes, at one write per isolate per period.
   */
  const period = Math.min(Math.max(deps.staleSeconds, MIN_TTL_SECONDS) / 2, POINTER_REFRESH_SECONDS) * 1000;
  if (last !== undefined && last.ref === refOf(pointer) && at - last.at < period) {
    return;
  }

  const record: PointerRecord = { ...pointer, at: new Date(at).toISOString() };
  try {
    await deps.kv.put(POINTER_KEY, JSON.stringify(record), {
      expirationTtl: Math.max(deps.staleSeconds, MIN_TTL_SECONDS),
    });
    written.set(deps.kv, { ref: refOf(pointer), at });
  } catch (error) {
    deps.debug?.error(`registry pointer cache unwritable`, { versionId: pointer.id, error });
  }
}

function pointerRecordOf(value: unknown): PointerRecord | null {
  const record = value as PointerRecord | null;
  if (record === null || typeof(record) !== 'object') {
    return null;
  }
  return typeof(record.id) === 'string' && typeof(record.checksum) === 'string' && typeof(record.at) === 'string'
    ? record
    : null;
}

/*
 * What to serve when D1 did not answer: the version that was active the last
 * time it did, if that was recent enough and its bytes are still cached.
 *
 * The age is carried back to the caller rather than swallowed. A response
 * built from this is explicitly an older version of the registry, and says so
 * in its headers; nothing about it may look current.
 */
async function stalePointer(deps: CacheDeps): Promise<{ pointer: VersionRef, staleFor: number } | null> {
  if (deps.staleSeconds <= 0) {
    return null;
  }
  let record: PointerRecord | null;
  try {
    record = pointerRecordOf(await deps.kv.get(POINTER_KEY, 'json'));
  } catch (error) {
    deps.debug?.error(`registry pointer cache unreadable`, { error });
    return null;
  }
  if (record === null) {
    return null;
  }

  const age = (now(deps).getTime() - Date.parse(record.at)) / 1000;
  if (!Number.isFinite(age) || age < 0 || age > deps.staleSeconds) {
    return null;
  }
  return { pointer: { id: record.id, checksum: record.checksum }, staleFor: Math.round(age) };
}

async function staleFallback(deps: CacheDeps): Promise<CachedSnapshot | null> {
  const stale = await stalePointer(deps);
  if (stale === null) {
    return null;
  }
  const snapshot = await cachedSnapshot(deps, stale.pointer);
  return snapshot === null ? null : { snapshot, source: 'stale', staleFor: stale.staleFor };
}

/*
 * That D1 did not answer, and what is being tried instead. Both the
 * registry's own reads and the consumer catalog degrade through these, so
 * they cannot degrade differently or describe it differently.
 */
function noteFallback(deps: CacheDeps, what: string, error: unknown): void {
  deps.debug?.error(`registry ${what} unreadable; trying the stale fallback`, { error });
}

/*
 * Whether the database could not be reached, as opposed to having answered
 * that something is wrong.
 *
 * Only the first is what the fallback is for. A statement that names a table
 * or a column the schema does not have is a release that went out ahead of
 * its migration, and serving an hour of older data over it would hide the
 * one thing an operator has to see. Such a failure is raised, and the route
 * says so.
 */
const ANSWERED = /no such (table|column|index)|syntax error|constraint failed|not authorized|datatype mismatch/i;
const UNREACHABLE = /network connection lost|fetch failed|timed? ?out|connection (reset|refused|closed)|storage (error|operation)|internal error|overloaded|unavailable/i;

function isUnreachable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return !ANSWERED.test(message) && UNREACHABLE.test(message);
}

/*
 * Which version is active, straight from D1. This is the one read a request
 * cannot skip, and the only one a hot isolate usually pays: what a pointer
 * names never changes, so everything else can be held.
 */
async function activePointer(deps: CacheDeps): Promise<VersionRef | null> {
  const pointer = await readActivePointer(deps.db);
  if (pointer !== null) {
    await rememberPointer(deps, pointer);
  }
  return pointer;
}

/*
 * The bytes of one version: from the cache, or hydrated out of D1 and written
 * to the cache for the isolates that come after.
 */
async function snapshotFor(deps: CacheDeps, pointer: VersionRef): Promise<{
  snapshot: RegistrySnapshotV1,
  source:   CacheSource,
} | null> {
  const cached = await cachedSnapshot(deps, pointer);
  if (cached !== null) {
    return { snapshot: cached, source: 'cache' };
  }

  const snapshot = await readRegistrySnapshot(deps.db, pointer.id);
  if (snapshot === null) {
    return null;
  }
  await writeSnapshot(deps, pointer, snapshot);
  return { snapshot, source: 'origin' };
}

/*
 * The active snapshot: null when the registry has no active version, which is
 * a fact and not a failure. Throws only when D1 could not be reached and no
 * fallback within policy exists — the caller turns that into 503.
 */
async function activeSnapshot(deps: CacheDeps): Promise<CachedSnapshot | null> {
  let pointer: VersionRef | null;
  try {
    pointer = await activePointer(deps);
  } catch (error) {
    noteFallback(deps, 'pointer', error);
    const fallback = isUnreachable(error) ? await staleFallback(deps) : null;
    if (fallback === null) {
      throw error;
    }
    return fallback;
  }

  if (pointer === null) {
    return null;
  }

  try {
    const resolved = await snapshotFor(deps, pointer);
    return resolved === null ? null : { ...resolved, staleFor: null };
  } catch (error) {
    noteFallback(deps, 'snapshot', error);
    const fallback = isUnreachable(error) ? await staleFallback(deps) : null;
    if (fallback === null) {
      throw error;
    }
    return fallback;
  }
}

/*
 * What the cache holds right now, for the status an operator or a monitor
 * reads. It never pulls a snapshot body: a listing says whether the bytes are
 * there, and the pointer record is small.
 */
async function cacheStatus(deps: CacheDeps, pointer: VersionRef | null): Promise<{
  // false only when the namespace answered and the bytes were not there
  snapshotCached:    boolean,
  pointerAgeSeconds: number | null,
  // whether the namespace could be read at all; false is a fault of its own
  readable:          boolean,
}> {
  try {
    const listed = pointer === null
      ? { keys: [] as Array<{ name: string }> }
      : await deps.kv.list({ prefix: snapshotKey(pointer) });
    const record = pointerRecordOf(await deps.kv.get(POINTER_KEY, 'json'));
    const age    = record === null ? null : Math.round((now(deps).getTime() - Date.parse(record.at)) / 1000);
    return {
      snapshotCached:    listed.keys.length > 0,
      pointerAgeSeconds: age !== null && Number.isFinite(age) ? age : null,
      readable:          true,
    };
  } catch (error) {
    /*
     * The namespace itself did not answer. Reporting that as "not cached"
     * would point an operator at a harmless condition while the real one —
     * no cache at all, and so no fallback when the database next fails — went
     * unsaid.
     */
    deps.debug?.error(`registry cache status unreadable`, { error });
    return { snapshotCached: false, pointerAgeSeconds: null, readable: false };
  }
}

/*
 * Caches the bytes of a version before it is the active one.
 *
 * Serializing a snapshot is the expensive half of answering, and after an
 * activation every isolate in every region pays it at once. A validated
 * candidate is already immutable, so its bytes can be written while nobody is
 * waiting for them, and the activation is then only a pointer move.
 *
 * It never writes the pointer: what is warmed is not active, and must not
 * become what an outage falls back to.
 */
async function warmSnapshot(deps: CacheDeps, versionId: string): Promise<VersionRef | null> {
  /*
   * One row says which bytes these would be. Hydrating the snapshot to find
   * that out would pay the cost this function exists to avoid — and a
   * version is warmed up to three times, by the import that validated it, by
   * an explicit validate, and by the activation.
   */
  const version = await readVersion(deps.db, versionId);
  if (version === null || version.snapshot_checksum === null) {
    return null;
  }
  const pointer: VersionRef = { id: version.id, checksum: version.snapshot_checksum };
  if (await isCached(deps, pointer)) {
    return pointer;
  }

  // the row is already in hand, so hydrating does not read it again
  const snapshot = await readRegistrySnapshot(deps.db, versionId, version);
  if (snapshot === null) {
    return null;
  }
  await writeSnapshot(deps, snapshot.registryVersion, snapshot);
  return snapshot.registryVersion;
}

export type { CacheDeps, CacheSource, CachedSnapshot };

export {
  MIN_TTL_SECONDS,
  cacheDepsOf,
  POINTER_KEY,
  activePointer,
  activeSnapshot,
  cacheStatus,
  snapshotFor,
  cachedSnapshot,
  isUnreachable,
  noteFallback,
  snapshotKey,
  stalePointer,
  warmSnapshot,
};
