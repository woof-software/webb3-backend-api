import t from 'tap';

import { createTestHarness } from 'wrangler';
import type { TestHarness } from 'wrangler';

import type { Env } from '../../entrypoint.js';
import { sha256 } from '../../lib/hash.js';

import { applyMigrations } from './d1.js';
import { ADMIN_TOKEN } from './test-env.js';

/*
 * The worker from wrangler.toml, run in real workerd with local D1, KV and
 * rate-limit bindings, for one file of tests: started before its first test
 * and closed after its last.
 *
 * With `admin`, the worker is given the hash of ADMIN_TOKEN as a secret, as
 * production is given only the hash of its token, and the tests present the
 * token itself. `vars` are set over the ones wrangler.toml and a developer's
 * .dev.vars give the worker.
 */
type HarnessOptions = {
  admin?: boolean,
  vars?:  Record<string, string>,
};

// the migrations a fresh database is given: all of them, or those up to and including `through`
type Migrated = { through?: string | undefined };

type RegistryHarness = {
  server:        TestHarness,
  // the worker's environment over new storage, migrated
  freshEnv:      (migrated?: Migrated) => Promise<Env>,
  freshDatabase: (migrated?: Migrated) => Promise<D1Database>,
  // the worker again, with `vars` set over the harness's own, until the next fresh environment
  withVars:      (vars: Record<string, string>) => Promise<void>,
};

async function registryHarness({ admin = false, vars }: HarnessOptions = {}): Promise<RegistryHarness> {
  const secrets = admin ? { COMET_REGISTRY_ADMIN_TOKEN_HASH: await sha256(ADMIN_TOKEN) } : undefined;
  const worker  = (more?: Record<string, string>) => ({
    configPath: './wrangler.toml',
    ...(secrets === undefined ? {} : { secrets }),
    ...(vars === undefined && more === undefined ? {} : { vars: { ...vars, ...more } }),
  });
  const server = createTestHarness({ workers: [ worker() ] });

  t.before(async () => {
    await server.listen();
  });
  t.teardown(() => server.close());

  const freshEnv = async ({ through }: Migrated = {}): Promise<Env> => {
    await server.reset();
    const env = await server.getWorker<Env>().getEnv();
    await applyMigrations(env.APP_DB, undefined, through === undefined ? {} : { through });
    return env;
  };
  return {
    server,
    freshEnv,
    freshDatabase: async migrated => (await freshEnv(migrated)).APP_DB,
    withVars:      async more => { await server.update({ workers: [ worker(more) ] }); },
  };
}

export type { RegistryHarness };
export { registryHarness };
