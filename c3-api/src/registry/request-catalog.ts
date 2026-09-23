import type { Env } from '../../entrypoint.js';

import type { RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';

import { Catalog, catalogOf } from './catalog.js';
import { readActiveVersionId, readRegistrySnapshot } from './repository.js';
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

async function activeCatalog(db: D1Database): Promise<Catalog | null> {
  const versionId = await readActiveVersionId(db);
  if (versionId === null) {
    active.delete(db);
    return null;
  }

  const now  = Date.now();
  const kept = active.get(db);
  if (kept !== undefined && kept.versionId === versionId && (kept.until === null || now < kept.until)) {
    return kept.catalog;
  }

  const snapshot = await readRegistrySnapshot(db, versionId);
  if (snapshot === null) {
    active.delete(db);
    return null;
  }
  const catalog = catalogOf(snapshot, new Date(now));
  active.set(db, { versionId, catalog, until: nextExpiry(snapshot, now) });
  return catalog;
}

function requestCatalog(env: Env): RequestCatalog {
  let pending: Promise<Catalog> | null = null;
  let catalog: Catalog | null          = null;

  return {
    loaded: () => catalog,
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
          loaded = await activeCatalog(env.APP_DB);
        } catch (error) {
          pending = null;
          throw new RegistryUnavailable(`the comet registry could not be read`, error);
        }
        if (loaded === null) {
          pending = null;
          throw new RegistryUnavailable(`no comet registry version is active`);
        }
        catalog = loaded;
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
function catalogHeaders(catalog: Catalog): Record<string, string> {
  return registryHeaders({ id: catalog.versionId, checksum: catalog.checksum });
}

export type { RequestCatalog };
export { RegistryUnavailable, catalogHeaders, isRegistryUnavailable, requestCatalog };
