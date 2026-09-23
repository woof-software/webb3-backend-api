import t from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';

import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { MemoryKv } from '../../util/kv.js';
import { makeTestEnv } from '../../util/test-env.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

import '../../../shim/node-self.js';

/*
 * What the legacy routes do about the registry, before any chain request is
 * made: which version answered, what happens when there is none, and what a
 * market address means now that the version decides it.
 *
 * These cases are reachable without a node provider, which is what keeps them
 * runnable anywhere. Everything past resolution needs RPC and lives in the
 * market and transaction-history suites.
 */
const MAINNET = 'ethereum-mainnet';
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const UNKNOWN = '0x1111111111111111111111111111111111111111';

function envWith(overrides: Partial<Env> = {}): Env {
  return makeTestEnv({ MEMORY_CACHE_SEED: 'registry-consumer-routes', ...overrides });
}

async function get(env: Env, path: string): Promise<Response> {
  return C3Api.fetch(new Request(`https://api.test.local${path}`), env);
}

t.test('a market route says which version answered it', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());

  const response = await get(envWith({ APP_DB: registry.db }), `/market/${MAINNET}/${USDC}/summary`);

  t.equal(response.headers.get('x-registry-version'), registry.versionId,
    'every response whose content depends on the registry names the version');
  t.equal(response.headers.get('x-registry-checksum'), registry.snapshot.registryVersion.checksum);
  t.not(response.status, 400, 'a market of the active version resolves');
});

t.test('an address the active version does not describe is not a market', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env = envWith({ APP_DB: registry.db });

  const unknown = await get(env, `/market/${MAINNET}/${UNKNOWN}/summary`);
  t.equal(unknown.status, 400, 'an address no version describes is refused');
  t.match(await unknown.text(), /Contract address not known/);

  const otherNetwork = await get(env, `/market/polygon-mainnet/${USDC}/summary`);
  t.equal(otherNetwork.status, 400, 'and so is a market addressed on the wrong network');
});

/*
 * A market the version gives no rewards has nothing to value them with: its
 * reward feed is a placeholder at the zero address. The rewards summary says
 * so before it would read that feed, rather than failing on it.
 */
t.test('the rewards summary of a market without rewards says so', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env = envWith({ APP_DB: registry.db });

  const scroll   = registry.snapshot.networks.find(network => network.chainId === 534352)!.markets[0]!;
  t.equal(scroll.capabilities.rewards, false, 'the fixture\'s Scroll market has no rewards');

  const response = await get(env, `/market/scroll-mainnet/${scroll.contracts.comet}/rewards/summary`);
  t.equal(response.status, 404, 'its rewards summary is not found');
  t.same(await response.json(), {
    error: 'Rewards are not available for this market',
    code:  'REWARDS_NOT_AVAILABLE',
  }, 'with a code a client can act on');
  t.equal(response.headers.get('x-registry-version'), registry.versionId, 'and the version that decided it');

  const rewarded = await get(env, `/market/${MAINNET}/${USDC}/rewards/summary`);
  t.not(rewarded.status, 404, 'a market with rewards is not refused');
});

/*
 * After the cutover there is no static market list to fall back to. A request
 * that needs the registry fails while the rest of the API keeps working,
 * rather than quietly answering from a list nobody activated.
 */
t.test('without an active version the market and account routes fail explicitly', async t => {
  // a validated version nobody activated: the registry has nothing to serve
  const registry = await activeRegistryDatabase({ activate: false });
  t.teardown(() => registry.dispose());
  const env = envWith({ APP_DB: registry.db });

  for (const path of [
    `/market/${MAINNET}/${USDC}/summary`,
    `/market/all-networks/all-contracts/summary`,
    `/account/${USDC}/rewards`,
    `/account/${USDC}/transaction_history`,
  ]) {
    const response = await get(env, path);
    t.equal(response.status, 503, `${path} reports the registry as unavailable`);
    const body = await response.json() as { error: string, requestId: string };
    t.match(body.error, /registry is unavailable/);
    t.match(body.requestId, /^[0-9a-f-]{36}$/, 'with a request id to correlate with the logs');
    t.equal(response.headers.get('x-registry-version'), null, 'and no version, because none answered');
  }

  const gasPrice = await get(env, '/legacy/mainnet/gas-price');
  t.not(gasPrice.status, 503, 'a route that needs no registry is unaffected');
});

/*
 * Transaction history is read from one range of logs covering a market and
 * the rewards contract its claims are emitted by, so a market that names no
 * rewards contract has no stream. Such a market must not be filterable: the
 * empty page it would answer with is indistinguishable from a market nobody
 * has used, which is the failure the registry is supposed to remove.
 */
t.test('a market no stream reads is not addressable in the history filter', async t => {
  const fixture: RegistrySnapshotV1 = loadRegistrySnapshotFixture();
  const snapshot: RegistrySnapshotV1 = {
    ...fixture,
    networks: fixture.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets.map(market => market.deploymentKey !== 'weth' ? market : {
        ...market,
        contracts: { ...market.contracts, rewards: null },
      }),
    }),
  };

  const registry = await activeRegistryDatabase({ snapshot });
  t.teardown(() => registry.dispose());
  const env = envWith({ APP_DB: registry.db });

  const account = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';
  const weth    = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
  const refused = await get(env, `/account/${account}/transaction_history?markets[]=1_${weth}`);
  t.equal(refused.status, 400, 'the market is refused rather than answered with nothing');
  t.match(await refused.text(), /Invalid market address/);

  /*
   * The same market with its rewards contract intact is addressable; that
   * path reads logs, so it is exercised where a node provider is configured
   * rather than here.
   */
  const unknown = await get(env, `/account/${account}/transaction_history?markets[]=1_${UNKNOWN}`);
  t.equal(unknown.status, 400, 'as is an address the version does not describe at all');
});

/*
 * A cursor belongs to one version: its stream keys and block anchors describe
 * that version's markets. Reading a page against another version would mix
 * two descriptions of the same addresses, so the client is told to start over.
 */
t.test('a transaction history cursor from another version is refused', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());

  const cursor = 'cursor-from-another-version';
  const seed   = {
    [cursor]: {
      registryVersionId: '00000000-0000-4000-8000-00000000dead',
      profilesByAddress: {},
      filter:  { markets: [], actions: [], initiatedBy: [], contractAddresses: [], networks: [] },
      streamEvents: [],
      cursors: {},
    },
  };

  const response = await get(
    envWith({ APP_DB: registry.db, kv_mainnet: MemoryKv({ seed }) }),
    `/account/0x420f253087044b8BCf028dd89F8fe83Ba6275E84/transaction_history?cursor=${cursor}`,
  );

  t.equal(response.status, 409);
  const body = await response.json() as { error: { code: string, registryVersionId: string, cursorRegistryVersionId: string } };
  t.equal(body.error.code, 'REGISTRY_VERSION_CHANGED', 'with the code that tells the client to restart pagination');
  t.equal(body.error.cursorRegistryVersionId, '00000000-0000-4000-8000-00000000dead', 'naming the version the cursor held');
  t.equal(body.error.registryVersionId, registry.versionId, 'and the version that is active now');
  t.equal(response.headers.get('x-registry-version'), registry.versionId);
});
