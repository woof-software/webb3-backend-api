import t from 'tap';
import * as streamInto from 'node:stream/consumers';

import { makeTestEnv } from '../../../../util/test-env.js';

import type { RegistrySnapshotV1 } from '../../../../../lib/model/comet-registry.js';
import { catalogOf } from '../../../../../src/registry/catalog.js';
import * as KnownNetwork from '../../../../../lib/well-known/networks/network.js';
import * as Debug    from '../../../../../lib/debug-log.js';
import * as Flags    from '../../../../../lib/flags.js';
import * as Eth   from '../../../../../lib/eth-constants.js';

import C3Api, { Env } from '../../../../../entrypoint.js';

import { setupTestEnvVars } from '../../../../util/setupTestEnvVars.js';
import { activeRegistryDatabase } from '../../../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../../../util/registry-fixture.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../../shim/node-self.js';

const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const testDebug = debug.scope('test');
testDebug.log({ flags });

const { apiHost, nodeHost, nodeKey } = setupTestEnvVars();

const CIUSDCV3 = '0x207158a267cbd2598bb3d611d8cbdee2709f2f8c';

/*
 * The institutional USDC market, described the way the registry would after
 * importing it: same base asset and rewards as the mainnet USDC market, its
 * own Comet and configurator. The frozen fixture does not carry it, and this
 * test is about what a near-empty market reports, not about the fixture.
 *
 * ciUSDCv3 has no timelock, which is why its contracts differ from the other
 * mainnet markets beyond the Comet address.
 */
function withInstitutionalUsdc(): RegistrySnapshotV1 {
  const snapshot = loadRegistrySnapshotFixture();
  return {
    ...snapshot,
    networks: snapshot.networks.map(network => {
      if (network.chainId !== 1) {
        return network;
      }
      const usdc = network.markets.find(market => market.deploymentKey === 'usdc')!;
      return {
        ...network,
        markets: [ ...network.markets, {
          ...usdc,
          id:              '00000000-0000-4000-8000-0000000001ff',
          deploymentKey:   'iusdc',
          displayName:     'USDC',
          slug:            'usdc-institutional',
          contractName:    'ciUSDCv3',
          isDefault:       false,
          isInstitutional: true,
          creationBlock:   21_035_000,
          contracts: {
            ...usdc.contracts,
            comet:        CIUSDCV3 as `0x${string}`,
            configurator: '0x316f9708bb98af7da9c68c1c3b5e79039cd336e3' as `0x${string}`,
          },
        } ],
      };
    }),
  };
}

/*
 * ciUSDCv3 is newly deployed and nearly empty, which is the point of covering
 * it separately from 01-usdc: it exercises the low/zero-liquidity path through
 * the summary computation, where the reward APR computations short-circuit on
 * totalSupplyBase.lte(baseMinForRewards) rather than dividing by a zero supply.
 *
 * Assertions are on shape, not on values. The market is live and its balances
 * change; hardcoding today's zeros would turn the first deposit into a test
 * failure.
 *
 * NOTE: like the other e2e market tests, this one hits live node providers and
 * requires V3_API_HOST / NODE_PROXY_HOST / NODE_PROXY_KEY in the environment.
 */
t.test(`/market/.../summary response format looks reasonable for a near-empty market`, async t => {
  const registry = await activeRegistryDatabase({ snapshot: withInstitutionalUsdc() });
  t.teardown(() => registry.dispose());

  const testEnv: Env = makeTestEnv({
    'V3_API_HOST': apiHost,
    'NODE_PROXY_HOST': nodeHost,
    'NODE_PROXY_KEY': nodeKey,
    'MEMORY_CACHE_SEED': 'market',
    APP_DB: registry.db,
  });
  const network: KnownNetwork.Name = 'ethereum-mainnet';
  const contract = catalogOf(registry.snapshot).marketAt(network, CIUSDCV3)!.comet;
  const request  = new Request(`https://${nodeHost}/market/${network}/${contract.address}/summary`);

  const response = await C3Api.fetch(request, testEnv);
  t.ok(response.body);
  // non-null assert (!) is safe because of the t.ok(response.body) above.
  const responseJson = await streamInto.json(response.body! as any);

  const {
    chain_id,
    comet,
    borrow_apr,
    supply_apr,
    total_borrow_value,
    total_supply_value,
    total_collateral_value,
    utilization,
  } = responseJson as any;

  t.equal(chain_id, 1, 'reports ethereum mainnet');
  t.ok(Eth.parseAddress(comet.address), 'comet address parses');
  t.equal(
    comet.address.toLowerCase(),
    contract.address.toLowerCase(),
    'echoes back the requested comet'
  );

  /*
   * Interest APRs are rate-model outputs and are well-formed even at zero
   * utilization.
   */
  t.ok(/^\d+\.\d+$/.test(borrow_apr), 'borrow_apr is a decimal string');
  t.ok(/^\d+\.\d+$/.test(supply_apr), 'supply_apr is a decimal string');

  t.ok(/^\d+\.\d+$/.test(total_borrow_value), 'total_borrow_value is a decimal string');
  t.ok(/^\d+\.\d+$/.test(total_supply_value), 'total_supply_value is a decimal string');
  t.ok(/^\d+\.\d+$/.test(total_collateral_value), 'total_collateral_value is a decimal string');
  t.ok(BigInt(utilization) >= BigInt(0), 'utilization is non-negative');

  t.end();
});
