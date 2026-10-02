import type { Env } from '../../entrypoint.js';

import { isAddress, normalizeAddress } from '../../lib/model/comet-registry.js';

import { authenticateAdmin } from '../http/bearer-auth.js';
import { ApiError, methodNotAllowed } from '../http/errors.js';
import { MAX_BODY_BYTES, jsonResponse, readJsonObject } from '../http/json.js';

import { cacheDepsOf } from './cache.js';
import { proxyTransport, readFeeds } from './enrichment.js';
import { registryStatus } from './status.js';
import {
  FeedReader,
  OverlayDocuments,
  replaceMarketOverlay,
  replaceNetworkOverlay,
  replaceOverlays,
} from './admin.js';
import {
  RegistryContext,
  applyProposal,
  chainIdOf,
  getChanges,
  getMarketOverlay,
  getProposal,
  getProposalReview,
  getShadow,
  getSyncRun,
  getVersionDetail,
  getVersions,
  postActivation,
  postValidate,
} from './handlers.js';
import type { InvocationResult } from './importer.js';
import { registryFetch, runRegistrySync } from './scheduled.js';
import {
  getTokenPolicies,
  getTokenPolicy,
  getTokenPolicyExport,
  patchTokenPolicy,
  postTokenPolicyApply,
  postTokenPolicyReview,
} from './token-handlers.js';
import type { DecisionList, ListedDecision } from './token-policy-repository.js';

import type * as KnownNetwork from '../../lib/well-known/networks/network.js';

/*
 * Reads the decimals of the feeds an overlay introduces, through the same
 * node provider path the importer uses. An overlay states which feed to use;
 * the chain states its scale.
 */
function feedReader(env: Env): FeedReader {
  const fetch = registryFetch(env);
  return async (network, addresses) => addresses.length === 0
    ? new Map()
    : readFeeds(
        proxyTransport({
          apiHost:  env.V3_API_HOST,
          nodeHost: env.NODE_PROXY_HOST,
          nodeKey:  env.NODE_PROXY_KEY,
          network:  network as KnownNetwork.Name,
          fetch,
        }),
        addresses,
        network,
      );
}

/*
 * The authenticated administrative routes.
 *
 * Every request is authenticated first and rate limited second, so an
 * unauthenticated caller cannot spend any budget at all. The limiter is keyed
 * by the presented credential and the route family rather than by IP: it
 * protects the registry from a stuck script or a runaway retry loop, while
 * the D1 sync fence remains the real concurrency authority.
 *
 * Callers sharing one token share one budget. That is a property of the
 * credential, not of the limiter: the environment configures a single token
 * hash, so two operators using it are indistinguishable here and in the audit
 * rows alike. Issuing separate tokens is what would separate them.
 */
const ROUTES = [
  { pattern: /^\/registry\/v1\/admin\/sync$/,                                                  method: 'POST', handler: 'sync',           family: 'sync' },
  { pattern: /^\/registry\/v1\/admin\/sync-runs\/([^/]+)$/,                                    method: 'GET',  handler: 'syncRun',        family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/shadow$/,                                                method: 'GET',  handler: 'shadow',         family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/status$/,                                                method: 'GET',  handler: 'status',         family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions$/,                                              method: 'GET',  handler: 'versions',       family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)$/,                                     method: 'GET',  handler: 'version',        family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/shadow$/,                             method: 'GET',  handler: 'shadow',         family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/changes$/,                            method: 'GET',  handler: 'changes',        family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/validate$/,                           method: 'POST', handler: 'validate',       family: 'validate' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/activate$/,                           method: 'POST', handler: 'activate',       family: 'activate' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/rollback$/,                           method: 'POST', handler: 'rollback',       family: 'activate' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/networks\/([^/]+)\/overlay$/,         method: 'PUT',  handler: 'networkOverlay', family: 'overlay' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/markets\/([^/]+)\/([^/]+)\/overlay$/, method: 'PUT',  handler: 'marketOverlay',  family: 'overlay' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/markets\/([^/]+)\/([^/]+)\/overlay$/, method: 'GET',  handler: 'readMarketOverlay', family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/overlays$/,                            method: 'PUT',  handler: 'overlays',       family: 'overlay' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/proposal$/,                           method: 'GET',  handler: 'proposal',       family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/proposal\/review$/,                   method: 'GET',  handler: 'proposalReview', family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/versions\/([^/]+)\/proposal\/apply$/,                    method: 'POST', handler: 'applyProposal',  family: 'overlay' },
  { pattern: /^\/registry\/v1\/admin\/networks\/([^/]+)\/tokens$/,                             method: 'GET',  handler: 'tokenPolicies',  family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/networks\/([^/]+)\/tokens\/([^/]+)\/policy$/,            method: 'GET',  handler: 'tokenPolicy',    family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/networks\/([^/]+)\/tokens\/([^/]+)\/policy$/,            method: 'PATCH', handler: 'setTokenPolicy', family: 'policy' },
  { pattern: /^\/registry\/v1\/admin\/token-policies$/,                                       method: 'GET',  handler: 'exportTokenPolicies', family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/token-policies\/review$/,                               method: 'POST', handler: 'reviewTokenPolicies', family: 'read' },
  { pattern: /^\/registry\/v1\/admin\/token-policies\/apply$/,                                method: 'POST', handler: 'applyTokenPolicies',  family: 'policy' },
] as const;

const MAX_REASON = 1000;

/*
 * How many markets one administrative sync imports. The Cron keeps to a
 * small batch because it runs unattended every hour; an operator bringing an
 * environment up wants the whole source in one request, so that is the
 * default here. The ceiling keeps one request inside the subrequest and D1
 * query budget of a single Worker invocation.
 */
const MAX_MARKETS_PER_REQUEST = 50;

/*
 * A reviewed directory in one request. Every network and market of a registry
 * fits several times over; the bound keeps the write one D1 batch of a size
 * the other administrative writes already produce, and the body limit is
 * raised for this route alone because a directory is what it carries.
 */
const MAX_OVERLAYS_PER_REQUEST = 100;
const MAX_OVERLAYS_BODY_BYTES  = 512 * 1024;

/*
 * A list of token policies in one request: every token of every network of a
 * registry fits, with a reason on each row. The list is written as a handful
 * of statements whatever its length, so the bound is the body, not D1.
 */
const MAX_POLICIES_PER_REQUEST = 500;
const MAX_POLICIES_BODY_BYTES  = 1024 * 1024;

// the bodies larger than an ordinary command, by the route that takes them
const BODY_BYTES: Partial<Record<string, number>> = {
  overlays:            MAX_OVERLAYS_BODY_BYTES,
  reviewTokenPolicies: MAX_POLICIES_BODY_BYTES,
  applyTokenPolicies:  MAX_POLICIES_BODY_BYTES,
};

/*
 * A reason is required wherever an operator changes what the registry serves,
 * because the audit row that records the change is only as useful as the
 * reason stored with it.
 */
function requireReason(body: Record<string, unknown>): string {
  const reason = body.reason;
  if (typeof(reason) !== 'string' || reason.trim().length === 0 || reason.length > MAX_REASON) {
    throw new ApiError('BAD_REQUEST', `a non-empty reason of at most ${MAX_REASON} characters is required`);
  }
  /*
   * SQLite's text functions stop at a NUL, so the audit tables' checks would
   * read a reason that starts with one as empty and refuse it with a database
   * error, and one that only contains one would be stored cut short.
   */
  if (reason.includes('\u0000')) {
    throw new ApiError('BAD_REQUEST', `a reason cannot contain a NUL character`);
  }
  return reason.trim();
}

/*
 * An optional reason: absent or null, or a reason as requireReason accepts
 * one. A problem is collected rather than thrown, so a list reports every
 * problem of every row at once.
 */
function optionalReason(value: unknown, where: string, problems: string[]): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof(value) !== 'string' || value.trim().length === 0 || value.length > MAX_REASON) {
    problems.push(`${where} must be null or a non-empty string of at most ${MAX_REASON} characters`);
    return null;
  }
  if (value.includes('\u0000')) {
    problems.push(`${where} cannot contain a NUL character`);
    return null;
  }
  return value.trim();
}

function requireExactKeys(body: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(body).filter(key => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ApiError('BAD_REQUEST', `unexpected properties: ${unexpected.sort().join(', ')}`);
  }
}

/*
 * The limiter key names the credential, never the token: `fingerprint` is a
 * prefix of the token's SHA-256, which distinguishes two configured tokens
 * without carrying either one into a key that is logged and counted.
 */
async function limit(env: Env, fingerprint: string, family: string): Promise<void> {
  const allowed = await env.REGISTRY_ADMIN_RATE_LIMITER.limit({ key: `registry-admin:${fingerprint}:${family}` });
  if (!allowed.success) {
    throw new ApiError('RATE_LIMITED', `too many administrative requests`);
  }
}

/*
 * The error an administrative sync answers with when the invocation failed.
 *
 * A registry error is answered as the routes answer it everywhere: a request
 * the registry has to refuse, such as a commit the tracked ref cannot reach,
 * is the client's to fix. A candidate that failed its checks would fail the
 * same way again, so it is refused with the ids to inspect it by rather than
 * offered as something to retry. Only a source that did not answer is a 503.
 */
function syncFailure(result: InvocationResult): Error {
  if (result.error !== undefined) {
    return result.error;
  }
  if (result.versionId !== undefined) {
    return new ApiError('UNPROCESSABLE', result.reason ?? 'the candidate failed validation', {
      syncRunId:         result.runId ?? null,
      registryVersionId: result.versionId,
    });
  }
  return new ApiError('UPSTREAM_UNAVAILABLE', result.reason ?? 'the import failed');
}

/*
 * Starts or continues an import. A manual request may pin an explicit commit
 * or force a new attempt, and both require a reason: they are decisions, not
 * routine scheduling.
 *
 * `holdForReview` leaves the candidate open once every root is imported, so
 * a market the source has added can be reviewed in place before anything
 * validates the version. `markets` bounds how much of the source this one
 * request imports.
 */
async function postSync(env: Env, body: Record<string, unknown>, actor: string): Promise<Response> {
  requireExactKeys(body, [ 'sourceCommitSha', 'forceNewAttempt', 'holdForReview', 'markets', 'reason' ]);

  const sourceCommitSha = body.sourceCommitSha;
  const forceNewAttempt = body.forceNewAttempt ?? false;
  const holdForReview   = body.holdForReview ?? false;
  const markets         = body.markets ?? MAX_MARKETS_PER_REQUEST;
  if (sourceCommitSha !== undefined && (typeof(sourceCommitSha) !== 'string' || !/^[0-9a-f]{40}$/.test(sourceCommitSha))) {
    throw new ApiError('BAD_REQUEST', `sourceCommitSha must be a 40 character commit sha`);
  }
  if (typeof(forceNewAttempt) !== 'boolean') {
    throw new ApiError('BAD_REQUEST', `forceNewAttempt must be a boolean`);
  }
  if (typeof(holdForReview) !== 'boolean') {
    throw new ApiError('BAD_REQUEST', `holdForReview must be a boolean`);
  }
  if (typeof(markets) !== 'number' || !Number.isInteger(markets) || markets < 1 || markets > MAX_MARKETS_PER_REQUEST) {
    throw new ApiError('BAD_REQUEST', `markets must be an integer from 1 to ${MAX_MARKETS_PER_REQUEST}`);
  }
  // holding a candidate open leaves the commit unimported until someone acts on it, which is a decision like the other two
  const explicit = sourceCommitSha !== undefined || forceNewAttempt === true || holdForReview === true;
  const reason   = explicit ? requireReason(body) : null;

  const result = await runRegistrySync(env, {
    ...(sourceCommitSha === undefined ? {} : { sourceCommitSha: sourceCommitSha as string }),
    ...(forceNewAttempt ? { forceNewAttempt: true } : {}),
    ...(holdForReview ? { holdForReview: true } : {}),
    ...(reason === null ? {} : { reason }),
    markets,
    requestedBy: actor,
  });

  if (result.status === 'failed') {
    throw syncFailure(result);
  }
  return jsonResponse({
    syncRunId:         result.runId ?? null,
    registryVersionId: result.versionId ?? null,
    status:            result.status,
    outcome:           result.outcome ?? null,
    processed:         result.processed,
    /*
     * How far the run has got, so a caller can see that an import which
     * answers `running` is making progress: how many roots the commit has,
     * how many are imported, and how many this invocation left to attempt.
     */
    expected:          result.expected ?? null,
    completed:         result.completed ?? null,
    outstanding:       result.outstanding ?? null,
    heldForReview:     result.held === true,
    checksFailed:      result.checksFailed ?? 0,
    reason:            result.reason ?? null,
    created:           result.status === 'running' && result.processed === 0,
  }, { status: 202 });
}

function documentsOf(value: unknown, name: string): Array<[ string, unknown ]> {
  if (value === undefined) {
    return [];
  }
  if (typeof(value) !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiError('BAD_REQUEST', `${name} must be an object keyed by what each overlay reviews`);
  }
  return Object.entries(value);
}

/*
 * The body of `PUT /versions/{id}/overlays`: network overlays keyed by chain
 * id, market overlays keyed by `chainId/deploymentKey`, and the one reason
 * every audit event of the request is stored with.
 */
function overlayDocuments(body: Record<string, unknown>, versionId: string, actor: string): OverlayDocuments {
  requireExactKeys(body, [ 'reason', 'networks', 'markets' ]);
  const reason = requireReason(body);

  const networks = documentsOf(body.networks, 'networks').map(([ key, overlay ]) => ({
    chainId: chainIdOf(key),
    overlay,
  }));
  const markets = documentsOf(body.markets, 'markets').map(([ key, overlay ]) => {
    const separator = key.indexOf('/');
    const deploymentKey = separator === -1 ? '' : key.slice(separator + 1);
    if (separator === -1 || deploymentKey.length === 0) {
      throw new ApiError('BAD_REQUEST', `${key} must name a market as chainId/deploymentKey`);
    }
    return { chainId: chainIdOf(key.slice(0, separator)), deploymentKey, overlay };
  });

  const count = networks.length + markets.length;
  if (count === 0 || count > MAX_OVERLAYS_PER_REQUEST) {
    throw new ApiError('BAD_REQUEST', `between 1 and ${MAX_OVERLAYS_PER_REQUEST} overlays are required`);
  }
  // `1` and `01` are the same chain, so a key names one scope only after it is read
  const scopes = [
    ...networks.map(({ chainId }) => `network ${chainId}`),
    ...markets.map(({ chainId, deploymentKey }) => `market ${chainId}/${deploymentKey}`),
  ];
  const repeated = scopes.filter((scope, index) => scopes.indexOf(scope) !== index);
  if (repeated.length > 0) {
    throw new ApiError('BAD_REQUEST', `each scope may be reviewed once per request: ${[ ...new Set(repeated) ].join(', ')}`);
  }

  return { versionId, actor, reason, networks, markets };
}

const DECISION_KEYS = [ 'chainId', 'tokenAddress', 'symbol', 'isStrategic', 'reason' ];

/*
 * The body of `POST /token-policies/review` and `/apply`: a list as the export
 * answers it, edited. `registryVersion` says where it was exported from and
 * is not checked, since a decision belongs to no version. Every problem of
 * every row is reported at once, so a file is fixed in one pass.
 */
function decisionList(body: Record<string, unknown>): DecisionList {
  requireExactKeys(body, [ 'registryVersion', 'reason', 'policies' ]);
  const problems: string[] = [];
  const reason = optionalReason(body.reason, 'reason', problems);

  const policies = body.policies;
  if (!Array.isArray(policies) || policies.length === 0 || policies.length > MAX_POLICIES_PER_REQUEST) {
    throw new ApiError('BAD_REQUEST', `policies must be a list of 1 to ${MAX_POLICIES_PER_REQUEST} decisions`);
  }

  const seen = new Map<string, number>();
  const decisions: ListedDecision[] = [];
  policies.forEach((entry: unknown, index: number) => {
    const row = `row ${index + 1}`;
    if (typeof(entry) !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${row} must be an object`);
      return;
    }
    const value  = entry as Record<string, unknown>;
    const before = problems.length;

    const unexpected = Object.keys(value).filter(key => !DECISION_KEYS.includes(key));
    if (unexpected.length > 0) {
      problems.push(`${row} has unexpected properties: ${unexpected.sort().join(', ')}`);
    }
    const { chainId, tokenAddress, symbol, isStrategic } = value;
    if (typeof(chainId) !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
      problems.push(`${row}: chainId must be a positive integer`);
    }
    if (!isAddress(tokenAddress)) {
      problems.push(`${row}: tokenAddress must be an address`);
    }
    if (symbol !== undefined && symbol !== null && typeof(symbol) !== 'string') {
      problems.push(`${row}: symbol must be null or a string`);
    }
    if (typeof(isStrategic) !== 'boolean') {
      problems.push(`${row}: isStrategic must be a boolean`);
    }
    const rowReason = optionalReason(value.reason, `${row}: reason`, problems);
    if (problems.length > before) {
      return;
    }

    const address = normalizeAddress(tokenAddress as string);
    const key     = `${chainId}:${address}`;
    const first   = seen.get(key);
    if (first !== undefined) {
      problems.push(`${row} repeats row ${first} (chain ${chainId}, ${address})`);
      return;
    }
    seen.set(key, index + 1);
    decisions.push({
      chainId:      chainId as number,
      tokenAddress: address,
      symbol:       (symbol as string | null | undefined) ?? null,
      isStrategic:  isStrategic as boolean,
      reason:       rowReason,
    });
  });

  if (problems.length > 0) {
    throw new ApiError('BAD_REQUEST', `the list of token policies is invalid`, { problems });
  }
  return { reason, decisions };
}

async function routeAdmin(
  request: Request,
  env: Env,
  context: RegistryContext,
  pathname: string,
): Promise<Response | null> {
  const matching = ROUTES
    .map(entry => ({ ...entry, match: entry.pattern.exec(pathname) }))
    .filter(({ match }) => match !== null);
  if (matching.length === 0) {
    return null;
  }
  /*
   * Authentication comes before anything the answer could tell an anonymous
   * caller apart by: which administrative paths exist, which verbs they take,
   * and which versions they name all stay behind the token.
   */
  const credential = await authenticateAdmin(request, env.COMET_REGISTRY_ADMIN_TOKEN_HASH);

  const route = matching.find(entry => entry.method === request.method);
  if (route === undefined) {
    // the allowed set is every verb the path takes, and the preflight
    throw methodNotAllowed(request.method, pathname, [ ...new Set(matching.map(entry => entry.method)), 'OPTIONS' ]);
  }

  await limit(env, credential.fingerprint, route.family);

  const [ , versionId, second, third ] = route.match!;
  const body = route.method === 'GET'
    ? {}
    : await readJsonObject(request, { maxBytes: BODY_BYTES[route.handler] ?? MAX_BODY_BYTES });

  switch (route.handler) {
    case 'status':
      /*
       * Whether the registry is healthy, in one answer: what is active, what
       * the cache holds, when the source was last checked, and which
       * candidates are waiting. A monitor polls this and alerts on `alerts`.
       */
      return jsonResponse(await registryStatus(env, cacheDepsOf(env, context.debug)));
    case 'sync':
      return await postSync(env, body, context.actor);
    case 'syncRun':
      return await getSyncRun(context, versionId!);
    case 'versions':
      return await getVersions(context, new URL(request.url).searchParams);
    case 'version':
      return await getVersionDetail(context, versionId!);
    case 'proposal':
      return await getProposal(context, versionId!);
    case 'proposalReview':
      return await getProposalReview(context, versionId!);
    case 'applyProposal': {
      requireExactKeys(body, [ 'reason', 'digest' ]);
      const reason = requireReason(body);
      if (typeof(body.digest) !== 'string' || !/^[0-9a-f]{16}$/.test(body.digest)) {
        throw new ApiError('BAD_REQUEST', `digest must be the 16 hex characters the proposal's review names`);
      }
      return await applyProposal(context, versionId!, { digest: body.digest, reason }, feedReader(env));
    }
    case 'readMarketOverlay':
      return await getMarketOverlay(context, versionId!, chainIdOf(second!), third!);
    case 'changes':
      return await getChanges(context, versionId!);
    case 'shadow':
      // without a captured id the route is /admin/shadow: the active version
      return await getShadow(context, versionId);
    case 'validate':
      /*
       * Validation decides nothing: it checks the stored candidate and records
       * every check it ran, exactly as the scheduled import does unattended.
       * The decision a person makes about a version, with its reason, is the
       * activation.
       */
      requireExactKeys(body, []);
      return await postValidate(context, versionId!);
    case 'activate':
      requireExactKeys(body, [ 'reason' ]);
      return await postActivation(context, versionId!, 'activate', requireReason(body));
    case 'rollback':
      requireExactKeys(body, [ 'reason' ]);
      return await postActivation(context, versionId!, 'rollback', requireReason(body));
    case 'networkOverlay':
      requireExactKeys(body, [ 'reason', 'overlay' ]);
      return jsonResponse(await replaceNetworkOverlay(context.db, {
        versionId: versionId!,
        chainId:   chainIdOf(second!),
        overlay:   body.overlay,
        actor:     context.actor,
        reason:    requireReason(body),
      }, feedReader(env)));
    case 'marketOverlay':
      requireExactKeys(body, [ 'reason', 'overlay' ]);
      return jsonResponse(await replaceMarketOverlay(context.db, {
        versionId:     versionId!,
        chainId:       chainIdOf(second!),
        deploymentKey: third!,
        overlay:       body.overlay,
        actor:         context.actor,
        reason:        requireReason(body),
      }, feedReader(env)));
    case 'overlays':
      return jsonResponse(await replaceOverlays(context.db, overlayDocuments(body, versionId!, context.actor), feedReader(env)));
    case 'tokenPolicies':
      // the first capture of a network route is a chain id, not a version id
      return await getTokenPolicies(context, versionId!);
    case 'tokenPolicy':
      return await getTokenPolicy(context, versionId!, second!);
    case 'setTokenPolicy': {
      /*
       * A strategic decision changes which tokens the API offers for
       * discovery, so it carries a reason like every other decision, and the
       * audit event stores it beside the actor.
       */
      requireExactKeys(body, [ 'isStrategic', 'reason' ]);
      if (typeof(body.isStrategic) !== 'boolean') {
        throw new ApiError('BAD_REQUEST', `isStrategic must be a boolean`);
      }
      return await patchTokenPolicy(context, versionId!, second!, {
        isStrategic: body.isStrategic,
        reason:      requireReason(body),
      });
    }
    case 'exportTokenPolicies':
      return await getTokenPolicyExport(context);
    case 'reviewTokenPolicies':
      return await postTokenPolicyReview(context, decisionList(body));
    case 'applyTokenPolicies':
      return await postTokenPolicyApply(context, decisionList(body));
  }
}

export { MAX_MARKETS_PER_REQUEST, MAX_OVERLAYS_PER_REQUEST, MAX_POLICIES_PER_REQUEST, MAX_REASON, ROUTES, routeAdmin, syncFailure };
