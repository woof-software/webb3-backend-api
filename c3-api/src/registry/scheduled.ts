import * as Debug from '../../lib/debug-log.js';

import type * as KnownNetwork from '../../lib/well-known/networks/network.js';
import type { Env, ServiceBindings } from '../../entrypoint.js';

import { proxyTransport } from './enrichment.js';
import { RegistryError, isRegistryError } from './errors.js';
import { ImporterDeps, InvocationResult, ManualRequest, runInvocation } from './importer.js';
import type { RegistryFetch } from './source/github.js';

/*
 * The Cron entry point of the registry importer: it turns the Worker
 * environment into importer dependencies and runs one bounded invocation.
 *
 * A scheduled invocation is not allowed to fail loudly: the next one resumes
 * from the checkpoints in D1, so an error is reported and swallowed rather
 * than left to retry the whole import.
 */
function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RegistryError('SOURCE_CONFIGURATION_INVALID', `${name} must be a positive integer`);
  }
  return parsed;
}

/*
 * The registry's own fetch. It applies the same service binding overrides as
 * the request path, so a node provider request reaches the proxy worker
 * directly instead of the public internet, but it holds no shared state.
 *
 * The module-global counting fetch belongs to the request handler: it keeps
 * one quota and one counter for the whole isolate, and an import running in
 * waitUntil would have both reset underneath it by any request that arrives
 * meanwhile.
 */
function registryFetch(env: Env): (input: Request | string, init?: RequestInit) => Promise<Response> {
  const overrides = env.URL_SERVICE_BINDING_OVERRIDES ?? [];
  return async (input, init) => {
    const request  = typeof(input) === 'string' ? new Request(input, init) : new Request(input, init);
    const override = overrides.find(({ host }) => host === new URL(request.url).hostname);
    if (override === undefined) {
      return fetch(request);
    }
    const binding = env[override.binding] as ServiceBindings[keyof ServiceBindings];
    if (binding === undefined) {
      throw new RegistryError(
        'SOURCE_CONFIGURATION_INVALID',
        `${override.host} is mapped to the ${override.binding} service binding, which is not configured`,
      );
    }
    return binding.fetch(request) as Promise<Response>;
  };
}

function importerDeps(env: Env): ImporterDeps {
  const token = env.COMET_GITHUB_TOKEN;
  const fetch = registryFetch(env);
  return {
    db: env.APP_DB,
    source: {
      repository: env.COMET_SOURCE_REPOSITORY,
      ref:        env.COMET_SOURCE_REF,
      fetch:      fetch as RegistryFetch,
      ...(token === undefined || token.length === 0 ? {} : { token }),
    },
    transportFor: network => proxyTransport({
      apiHost:  env.V3_API_HOST,
      nodeHost: env.NODE_PROXY_HOST,
      nodeKey:  env.NODE_PROXY_KEY,
      network:  network as KnownNetwork.Name,
      fetch,
    }),
    config: {
      leaseSeconds:            positiveInteger(env.COMET_SYNC_LEASE_SECONDS, 'COMET_SYNC_LEASE_SECONDS', 900),
      marketsPerInvocation:    positiveInteger(env.COMET_SYNC_MARKETS_PER_INVOCATION, 'COMET_SYNC_MARKETS_PER_INVOCATION', 2),
      upstreamIntervalSeconds: positiveInteger(env.COMET_UPSTREAM_CHECK_INTERVAL_S, 'COMET_UPSTREAM_CHECK_INTERVAL_S', 86400),
    },
    actor: `registry-cron:${env.ENVIRONMENT}`,
  };
}

/*
 * Runs one invocation of the importer and reports its outcome. Returns the
 * result so a manual administrative sync can answer with it.
 */
async function runRegistrySync(env: Env, request: ManualRequest = {}): Promise<InvocationResult> {
  const debug = Debug.MakeLogger([ 'registry' ]).configure(env);
  try {
    const result = await runInvocation(importerDeps(env), request);
    debug.log({ registrySync: result });
    return result;
  } catch (error) {
    /*
     * Only a sanitized code reaches the logs: an upstream body or a token
     * must not be written where diagnostics are read.
     */
    const reason = isRegistryError(error) ? `${error.code}: ${error.message}` : 'an unexpected error interrupted the import';
    debug.error(`registry sync failed`, { reason });
    return { status: 'failed', processed: 0, reason };
  }
}

export { importerDeps, registryFetch, runRegistrySync };
