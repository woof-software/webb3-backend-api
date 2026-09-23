import {
  ActivationAction,
  MarketV1,
  NetworkV1,
  RegistrySnapshotV1,
  isAddress,
  normalizeAddress,
} from '../../lib/model/comet-registry.js';

import { ApiError } from '../http/errors.js';
import { jsonResponse } from '../http/json.js';

import { registryHeaders } from './version-headers.js';
import {
  activateVersion,
  readActivationHistory,
  readActiveSnapshot,
  readActiveVersionId,
  readRegistrySnapshot,
  readSnapshot,
  readUnreviewed,
  readValidationSummary,
  readVersion,
} from './repository.js';
import { compareVersions } from './changes.js';
import { bundleOf, digestOf, proposalFor, reviewDocument } from './bootstrap.js';
import type { Generated } from './bootstrap.js';
import { orderNetworks, overlayOfMarket } from './overlay.js';
import { compareWithStatic } from './shadow.js';
import { replaceOverlays, validateStoredVersion } from './admin.js';
import type { FeedReader } from './admin.js';

/*
 * The registry HTTP handlers. They resolve a version, shape the response, and
 * say which version answered; routing and authentication happen around them.
 *
 * Every successful read that resolved a version carries its id and checksum,
 * in headers and in the body, so a client can tell two snapshots apart
 * without parsing the whole payload. The one response that cannot is the
 * no-active 503: there is no version to name.
 */
type RegistryContext = {
  db:    D1Database,
  actor: string,
};

const SCHEMA_VERSION = 1;

/*
 * The strong ETag of one representation: schema version, what was asked for,
 * the version id, and its checksum.
 *
 * The representation is part of it because these routes serve different
 * bodies from the same version. An ETag that named the version alone would
 * let a conditional request for one route be answered 304 while the client
 * holds another route's body.
 */
function etagOf(snapshot: RegistrySnapshotV1, representation: string): string {
  const { id, checksum } = snapshot.registryVersion;
  return `"v${SCHEMA_VERSION}-${representation}-${id}-${checksum}"`;
}

function versionHeaders(snapshot: RegistrySnapshotV1): Record<string, string> {
  return registryHeaders(snapshot.registryVersion);
}

/*
 * A cacheable snapshot response, honoring If-None-Match. The body is
 * immutable for a version, so a matching ETag needs no body at all.
 */
function snapshotResponse(
  request: Request,
  snapshot: RegistrySnapshotV1,
  representation: string,
  body: unknown,
  { maxAge }: { maxAge: number },
): Response {
  const etag    = etagOf(snapshot, representation);
  const headers = {
    ...versionHeaders(snapshot),
    'ETag':          etag,
    'Cache-Control': `public, max-age=${maxAge}`,
  };
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return jsonResponse(body, { headers });
}

/*
 * The version as the API serves it: without the markets it refuses to
 * resolve.
 *
 * A `disabled` market is part of the stored version, and an operator sees it
 * through the administrative routes, but no public read may offer one: the
 * market routes answer 404 for it and the request catalog does not
 * materialize it, so listing it would advertise something unusable.
 */
function selectable(snapshot: RegistrySnapshotV1): RegistrySnapshotV1 {
  return {
    ...snapshot,
    networks: snapshot.networks.map(network => ({
      ...network,
      markets: network.markets.filter(market => market.status !== 'disabled'),
    })),
  };
}

async function activeSnapshot(context: RegistryContext): Promise<RegistrySnapshotV1> {
  const snapshot = await readActiveSnapshot(context.db);
  if (snapshot === null) {
    throw new ApiError('REGISTRY_NOT_ACTIVE', `No active registry snapshot is available`);
  }
  return snapshot;
}

function networkOf(snapshot: RegistrySnapshotV1, chainId: number): NetworkV1 {
  const network = snapshot.networks.find(candidate => candidate.chainId === chainId);
  if (network === undefined) {
    throw new ApiError('NOT_FOUND', `chain ${chainId} is not part of the active registry`);
  }
  return network;
}

function chainIdOf(value: string): number {
  const chainId = Number(value);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new ApiError('BAD_REQUEST', `${value} is not a chain id`);
  }
  return chainId;
}

/*
 * A market is addressed by its Comet address. A disabled market is not
 * selectable, so it answers 404 even though it stays in the snapshot for
 * diagnostics; a deprecated one is still readable, because positions and
 * history in it must remain reachable.
 */
function marketOf(network: NetworkV1, address: string): MarketV1 {
  if (!isAddress(address)) {
    throw new ApiError('BAD_REQUEST', `${address} is not an address`);
  }
  const comet  = normalizeAddress(address);
  const market = network.markets.find(candidate => candidate.contracts.comet === comet);
  if (market === undefined || market.status === 'disabled') {
    throw new ApiError('NOT_FOUND', `no selectable market at ${comet} on chain ${network.chainId}`);
  }
  return market;
}

function versionRef(snapshot: RegistrySnapshotV1) {
  return { id: snapshot.registryVersion.id, checksum: snapshot.registryVersion.checksum };
}

/*
 * Public reads. The convenience routes serve the same objects and the same
 * order as the bootstrap snapshot; none of them resolves "latest" on its own.
 */
async function getActive(request: Request, context: RegistryContext, maxAge: number): Promise<Response> {
  const snapshot = await activeSnapshot(context);
  return snapshotResponse(request, snapshot, 'snapshot', selectable(snapshot), { maxAge });
}

async function getNetworks(request: Request, context: RegistryContext, maxAge: number): Promise<Response> {
  const snapshot = await activeSnapshot(context);
  return snapshotResponse(request, snapshot, 'networks', {
    registryVersion: versionRef(snapshot),
    // the summary omits markets, which the market routes serve
    networks: snapshot.networks.map(({ markets: _markets, ...network }) => network),
  }, { maxAge });
}

async function getMarkets(request: Request, context: RegistryContext, chainId: string, maxAge: number): Promise<Response> {
  const snapshot = await activeSnapshot(context);
  const network  = networkOf(snapshot, chainIdOf(chainId));
  return snapshotResponse(request, snapshot, `markets:${network.chainId}`, {
    registryVersion: versionRef(snapshot),
    chainId:         network.chainId,
    // the same selectability rule the market route and the catalog apply
    markets:         network.markets.filter(market => market.status !== 'disabled'),
  }, { maxAge });
}

async function getMarket(
  request: Request,
  context: RegistryContext,
  chainId: string,
  cometAddress: string,
  maxAge: number,
): Promise<Response> {
  const snapshot = await activeSnapshot(context);
  const network  = networkOf(snapshot, chainIdOf(chainId));
  const market   = marketOf(network, cometAddress);
  return snapshotResponse(request, snapshot, `market:${network.chainId}:${market.contracts.comet}`, {
    registryVersion: versionRef(snapshot),
    chainId:         network.chainId,
    market,
  }, { maxAge });
}

/*
 * A retained validated version by id, so a session can refetch the exact
 * snapshot it pinned even after another version was activated.
 */
async function getVersion(request: Request, context: RegistryContext, versionId: string, maxAge: number): Promise<Response> {
  const snapshot = await readRegistrySnapshot(context.db, versionId);
  if (snapshot === null) {
    throw new ApiError('NOT_FOUND', `no validated registry version with that id`);
  }
  return snapshotResponse(request, snapshot, 'snapshot', selectable(snapshot), { maxAge });
}

/*
 * Administrative reads and commands. They never serve a cached body: an
 * operator asking about a candidate needs its current state.
 */
async function getVersionDetail(context: RegistryContext, versionId: string): Promise<Response> {
  const version = await readVersion(context.db, versionId);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }
  return jsonResponse({
    version: {
      id:               version.id,
      status:           version.status,
      attempt:          version.attempt,
      sourceRepository: version.source_repository,
      sourceCommitSha:  version.source_commit_sha,
      sourceChecksum:   version.source_checksum,
      snapshotChecksum: version.snapshot_checksum,
      createdAt:        version.created_at,
      validatedAt:      version.validated_at,
      createdBy:        version.created_by,
    },
    validation:  await readValidationSummary(context.db, versionId),
    activations: await readActivationHistory(context.db, versionId),
    /*
     * The networks and markets this version imported that nobody has
     * reviewed: disabled, with every capability off, until someone decides
     * how they are served. For the first version of an environment that is
     * everything; later it is whatever the source has added.
     */
    unreviewed:  await readUnreviewed(context.db, versionId),
  });
}

/*
 * One import run and its per-root checkpoints. The lease owner is a secret
 * that fences concurrent invocations, so it is never part of the answer; the
 * expiry is, because that is what tells an operator when the run becomes
 * resumable.
 */
async function getSyncRun(context: RegistryContext, syncRunId: string): Promise<Response> {
  const run = await context.db.prepare(`SELECT * FROM sync_runs WHERE id = ?1`).bind(syncRunId).first<{
    id: string, source_commit_sha: string, tracked_ref: string | null, registry_version_id: string | null,
    trigger_kind: string, requested_by: string | null, reason: string | null, status: string,
    outcome: string | null, lease_expires_at: string | null, expected_count: number,
    completed_count: number, failed_count: number, last_error: string | null,
    started_at: string, completed_at: string | null,
  }>();
  if (run === null || run === undefined) {
    throw new ApiError('NOT_FOUND', `no sync run with that id`);
  }

  const items = await context.db.prepare(
    `SELECT root_path, upstream_network_key, deployment_key, status, attempts,
            completed_at, last_error, updated_at
     FROM sync_run_items WHERE sync_run_id = ?1 ORDER BY root_path`
  ).bind(syncRunId).all<{
    root_path: string, upstream_network_key: string, deployment_key: string,
    status: string, attempts: number, completed_at: string | null,
    last_error: string | null, updated_at: string,
  }>();

  return jsonResponse({
    syncRun: {
      id:                run.id,
      registryVersionId: run.registry_version_id,
      sourceCommitSha:   run.source_commit_sha,
      trackedRef:        run.tracked_ref,
      triggerKind:       run.trigger_kind,
      requestedBy:       run.requested_by,
      reason:            run.reason,
      status:            run.status,
      outcome:           run.outcome,
      leaseExpiresAt:    run.lease_expires_at,
      expectedCount:     run.expected_count,
      completedCount:    run.completed_count,
      failedCount:       run.failed_count,
      lastError:         run.last_error,
      startedAt:         run.started_at,
      completedAt:       run.completed_at,
    },
    items: (items.results ?? []).map(item => ({
      rootPath:           item.root_path,
      upstreamNetworkKey: item.upstream_network_key,
      deploymentKey:      item.deployment_key,
      status:             item.status,
      attempts:           item.attempts,
      completedAt:        item.completed_at,
      lastError:          item.last_error,
      updatedAt:          item.updated_at,
    })),
  });
}

/*
 * The shadow comparison: a version against the static constants this API
 * still serves from.
 *
 * Without a version id it answers for the active one, which is what a
 * scheduled check watches; with an id it answers for a validated candidate,
 * which is what an operator reads before activating it. A candidate that has
 * not been validated has no snapshot to compare, so it is not addressable
 * here.
 */
async function getShadow(context: RegistryContext, versionId: string | undefined): Promise<Response> {
  const snapshot = versionId === undefined
    ? await activeSnapshot(context)
    : await readRegistrySnapshot(context.db, versionId);
  if (snapshot === null) {
    throw new ApiError('NOT_FOUND', `no validated registry version with that id`);
  }

  const shadow = compareWithStatic(snapshot);
  return jsonResponse({
    /*
     * One flag an operator or a check can read without interpreting the
     * report: the two sources describe the same markets with the same values.
     */
    agrees: shadow.differences.length === 0
         && shadow.onlyInStatic.length === 0
         && shadow.onlyInRegistry.length === 0,
    shadow,
  }, { headers: versionHeaders(snapshot) });
}

/*
 * What a version changes against the version that is on: the markets it adds
 * or drops, and every fact and decision of the others that differs.
 *
 * Unlike the shadow comparison it answers for a candidate that is still
 * importing, because that is when an operator describes a market the source
 * has added, and the facts the import read for it are where that starts.
 * Without a version that is on, everything the version holds is added.
 */
async function getChanges(context: RegistryContext, versionId: string): Promise<Response> {
  const version = await readVersion(context.db, versionId);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }

  const activeId   = await readActiveVersionId(context.db);
  const after      = orderNetworks(await readSnapshot(context.db, versionId));
  const before     = activeId === null ? null : orderNetworks(await readSnapshot(context.db, activeId));
  const unreviewed = await readUnreviewed(context.db, versionId);

  return jsonResponse({
    versionId,
    status:       version.status,
    comparedWith: activeId,
    ...compareVersions(before, after, new Set(unreviewed.markets)),
  });
}

/*
 * The overlay of one market of a version, in the form its PUT takes. A market
 * nobody has reviewed answers with the provisional decisions its import
 * wrote, and says so.
 */
async function getMarketOverlay(
  context: RegistryContext,
  versionId: string,
  chainId: number,
  deploymentKey: string,
): Promise<Response> {
  const version = await readVersion(context.db, versionId);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }
  const scope  = `${chainId}/${deploymentKey}`;
  const market = (await readSnapshot(context.db, versionId))
    .find(network => network.chainId === chainId)?.markets
    .find(entry => entry.deploymentKey === deploymentKey);
  if (market === undefined) {
    throw new ApiError('NOT_FOUND', `${scope} is not in this registry version`);
  }

  return jsonResponse({
    versionId,
    scope,
    reviewed: !(await readUnreviewed(context.db, versionId)).markets.includes(scope),
    overlay:  overlayOfMarket(market),
  });
}

/*
 * The proposal for a version's first review, built by the release that serves
 * this request from the markets the version imported. Building it twice from
 * the same version and release gives the same proposal, which is what lets
 * `apply` accept a digest instead of the documents.
 */
async function proposalOf(
  context: RegistryContext,
  versionId: string,
): Promise<{ repository: string, generated: Generated, digest: string }> {
  const version = await readVersion(context.db, versionId);
  if (version === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }
  const generated = proposalFor(orderNetworks(await readSnapshot(context.db, versionId)), {
    repository: version.source_repository,
    commit:     version.source_commit_sha,
  });
  return { repository: version.source_repository, generated, digest: await digestOf(generated) };
}

// the proposal as the overlays route would take it, with what it leaves undecided
async function getProposal(context: RegistryContext, versionId: string): Promise<Response> {
  const { generated, digest } = await proposalOf(context, versionId);
  return jsonResponse({
    versionId,
    digest,
    needsDecision: generated.notes
      .filter(note => note.open)
      .map(({ scope, field, source }) => ({ scope, field, reason: source })),
    bundle: bundleOf(generated),
  });
}

// the same proposal as a person reads it, naming the digest to apply it by
async function getProposalReview(context: RegistryContext, versionId: string): Promise<Response> {
  const { repository, generated, digest } = await proposalOf(context, versionId);
  return new Response(reviewDocument(generated, repository, digest), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
}

/*
 * Applies the proposal an operator read, by its digest: it is built again and
 * written only if it is still the proposal with that digest, all of it or
 * none, exactly as the overlays route writes a directory.
 */
async function applyProposal(
  context: RegistryContext,
  versionId: string,
  request: { digest: string, reason: string },
  readFeeds: FeedReader,
): Promise<Response> {
  const { generated, digest } = await proposalOf(context, versionId);
  if (digest !== request.digest) {
    throw new ApiError(
      'CONFLICT',
      `this version's proposal is no longer the one with digest ${request.digest}; read its review again`,
      { digest },
    );
  }
  const result = await replaceOverlays(context.db, {
    versionId,
    actor:    context.actor,
    reason:   request.reason,
    networks: generated.networks.map(({ chainId, overlay }) => ({ chainId, overlay })),
    markets:  generated.markets.map(({ chainId, deploymentKey, overlay }) => ({ chainId, deploymentKey, overlay })),
  }, readFeeds);
  return jsonResponse({ digest, ...result });
}

async function postValidate(context: RegistryContext, versionId: string): Promise<Response> {
  const result = await validateStoredVersion(context.db, versionId);
  return jsonResponse(
    { version: result.version, changed: result.changed, summary: result.summary },
    { status: result.version.status === 'validated' ? 200 : 422 },
  );
}

async function postActivation(
  context: RegistryContext,
  versionId: string,
  action: ActivationAction,
  reason: string,
): Promise<Response> {
  // a version that does not exist is not a state conflict, and answers as every other route does
  if (await readVersion(context.db, versionId) === null) {
    throw new ApiError('NOT_FOUND', `no registry version with that id`);
  }
  const result = await activateVersion(context.db, { versionId, action, actor: context.actor, reason });
  return jsonResponse(result, { headers: registryHeaders(result.registryVersion) });
}

export type { RegistryContext };

export {
  SCHEMA_VERSION,
  chainIdOf,
  etagOf,
  getActive,
  getChanges,
  getMarket,
  applyProposal,
  getMarketOverlay,
  getMarkets,
  getProposal,
  getProposalReview,
  getNetworks,
  getShadow,
  getSyncRun,
  getVersion,
  getVersionDetail,
  postActivation,
  postValidate,
  versionHeaders,
};
