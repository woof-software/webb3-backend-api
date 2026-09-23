import type { Env } from '../../entrypoint.js';

import type { RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';

import { Catalog, catalogOf } from './catalog.js';
import type { CacheDeps } from './cache.js';
import {
  activePointer,
  cacheDepsOf,
  cachedSnapshot,
  isUnreachable,
  noteFallback,
  snapshotFor,
  stalePointer,
} from './cache.js';
import { registryHeaders } from './version-headers.js';

/*
 * One registry version per request.
 *
 * A request that resolves markets, tokens, or feeds resolves all of them from
 * the same snapshot: two computations of one response must never describe the
 * same address differently because a new version was activated between them.
 * The catalog is therefore loaded at most once per request and held for its
 * duration, and the version that answered is reported back in the response
 * headers.
 *
 * Loading is lazy, because the routes that need no registry — governance, V2,
 * gas price — must not pay a D1 read, nor fail when the registry is empty.
 */
type RequestCatalog = {
  // loads the active version, or throws RegistryUnavailable
  load(): Promise<Catalog>,
  // the version that answered this request, if one was loaded
  loaded(): Catalog | null,
  /*
   * How old that version is, in seconds, when it was served from the cache
   * because D1 could not be reached. Null means the pointer was verified, so
   * the answer is the version that is on.
   */
  staleFor(): number | null,
};

/*
 * There is no active registry version, or D1 did not answer. After the
 * cutover this is a failure, never a fallback: silently answering from the
 * static constants would serve markets that nothing reviewed or activated.
 */
class RegistryUnavailable extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name  = 'RegistryUnavailable';
    this.cause = cause;
  }
}

function isRegistryUnavailable(error: unknown): error is RegistryUnavailable {
  return error instanceof Error && error.name === 'RegistryUnavailable';
}

/*
 * The catalog of the version that is on, kept for as long as it is on.
 *
 * A version never changes once it is activated — its rows are frozen, and its
 * checksum says so — and only the pointer can move, which is one statement to
 * read. So an isolate keeps the catalog it built and a request pays the
 * pointer read alone, rather than reading the whole snapshot and building
 * every market's contracts again for an answer that cannot differ.
 *
 * A price exception may expire, and a catalog resolves expiry when it is
 * built, so one is kept only until the next expiry falls due. The database
 * binding is part of the key, because a version id identifies a version of
 * one registry, not of every database an isolate might hold.
 */
const active = new WeakMap<D1Database, { versionId: string, catalog: Catalog, until: number | null }>();

// when the next price exception expires, after which a catalog built now would apply a different set
function nextExpiry(snapshot: RegistrySnapshotV1, now: number): number | null {
  const due = snapshot.networks
    .flatMap(network => network.priceExceptions)
    .map(exception => exception.expiresAt === null ? Number.NaN : Date.parse(exception.expiresAt))
    .filter(time => Number.isFinite(time) && time > now);
  return due.length === 0 ? null : Math.min(...due);
}

// the clock the cache was given, so an injected one decides expiry as well as staleness
function clockOf(deps: CacheDeps): number {
  return (deps.now?.() ?? new Date()).getTime();
}

function catalogFrom(deps: CacheDeps, snapshot: RegistrySnapshotV1, now: number): Catalog {
  const catalog = catalogOf(snapshot, new Date(now));
  active.set(deps.db, { versionId: snapshot.registryVersion.id, catalog, until: nextExpiry(snapshot, now) });
  return catalog;
}

/*
 * The catalog of the version that is on.
 *
 * The order is what keeps a hot isolate cheap: read the pointer, which is one
 * D1 statement; if it still names the version this isolate built its catalog
 * from, nothing else is read at all. Only a pointer that moved, or an isolate
 * that has just started, pays the snapshot — from KV where another isolate
 * has already cached it, and from D1 otherwise.
 *
 * When D1 does not answer, the cache may still hold the version it last
 * named. That answer is served rather than failing the request, and the age
 * of it is carried back so the response can say so.
 */
async function activeCatalog(deps: CacheDeps): Promise<{ catalog: Catalog, staleFor: number | null } | null> {
  /*
   * What to answer with when D1 did not answer. The pointer record is read
   * first and on its own, because an isolate that already holds the catalog
   * of that version has nothing left to read: an outage is when rebuilding
   * every market from the cached bytes, on every request, is least
   * affordable.
   */
  const fallback = async (error: unknown) => {
    if (!isUnreachable(error)) {
      // the database answered, and what it said is a fault to raise, not to paper over
      throw error;
    }
    const stale = await stalePointer(deps);
    if (stale === null) {
      throw error;
    }
    const at   = clockOf(deps);
    const kept = active.get(deps.db);
    if (kept !== undefined && kept.versionId === stale.pointer.id && (kept.until === null || at < kept.until)) {
      return { catalog: kept.catalog, staleFor: stale.staleFor };
    }
    const snapshot = await cachedSnapshot(deps, stale.pointer);
    if (snapshot === null) {
      throw error;
    }
    return { catalog: catalogFrom(deps, snapshot, at), staleFor: stale.staleFor };
  };

  let pointer;
  try {
    pointer = await activePointer(deps);
  } catch (error) {
    noteFallback(deps, 'pointer', error);
    return fallback(error);
  }

  if (pointer === null) {
    active.delete(deps.db);
    return null;
  }

  const now  = clockOf(deps);
  const kept = active.get(deps.db);
  if (kept !== undefined && kept.versionId === pointer.id && (kept.until === null || now < kept.until)) {
    return { catalog: kept.catalog, staleFor: null };
  }

  let resolved;
  try {
    resolved = await snapshotFor(deps, pointer);
  } catch (error) {
    noteFallback(deps, 'snapshot', error);
    return fallback(error);
  }
  if (resolved === null) {
    active.delete(deps.db);
    return null;
  }

  return { catalog: catalogFrom(deps, resolved.snapshot, now), staleFor: null };
}

function requestCatalog(env: Env, debug?: CacheDeps['debug']): RequestCatalog {
  const deps = cacheDepsOf(env, debug);
  let pending: Promise<Catalog> | null = null;
  let catalog: Catalog | null          = null;
  let staleFor: number | null          = null;

  return {
    loaded:   () => catalog,
    staleFor: () => staleFor,
    load() {
      /*
       * A failed load is not memoized: the promise is cleared so a later
       * handler of the same request can try again, which matters when the
       * first attempt lost a race with a D1 hiccup rather than finding an
       * empty registry.
       */
      pending ??= (async () => {
        let loaded;
        try {
          loaded = await activeCatalog(deps);
        } catch (error) {
          pending = null;
          throw new RegistryUnavailable(`the comet registry could not be read`, error);
        }
        if (loaded === null) {
          pending = null;
          throw new RegistryUnavailable(`no comet registry version is active`);
        }
        catalog  = loaded.catalog;
        staleFor = loaded.staleFor;
        return catalog;
      })();
      return pending;
    },
  };
}

/*
 * The headers a registry-dependent response carries: they name the version a
 * client was served without changing any response body.
 */
function catalogHeaders(catalog: Catalog, staleFor: number | null = null): Record<string, string> {
  return {
    ...registryHeaders({ id: catalog.versionId, checksum: catalog.checksum }),
    /*
     * An answer computed from a version the database could not confirm says
     * so and may not be stored — by a browser, a proxy or anything else. The
     * two travel together, so a caller cannot set one and forget the other.
     */
    ...(staleFor === null ? {} : { 'X-Registry-Stale': String(staleFor), 'Cache-Control': 'no-store' }),
  };
}

export type { RequestCatalog };
export { RegistryUnavailable, catalogHeaders, isRegistryUnavailable, requestCatalog };
