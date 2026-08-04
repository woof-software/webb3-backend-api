import t from 'tap';
import * as streamInto from 'node:stream/consumers';

import { MemoryKv } from '../../../../util/kv.js';

import { wellKnownContractsByNetwork } from '../../../../../lib/eth-constants.js';
import * as KnownNetwork from '../../../../../lib/well-known/networks/network.js';
import * as Debug    from '../../../../../lib/debug-log.js';
import * as Flags    from '../../../../../lib/flags.js';
import * as Eth   from '../../../../../lib/eth-constants.js';

import C3Api, { Env } from '../../../../../entrypoint.js';

import { setupTestEnvVars } from '../../../../util/setupTestEnvVars.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../../shim/node-self.js';

const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const testDebug = debug.scope('test');
testDebug.log({ flags });

const { apiHost, nodeHost, nodeKey } = setupTestEnvVars();

/*
 * ctestUSDCv3 ("Compound TEST Svc Patch USDC") is an empty market: as of its
 * deployment, totalSupply() and totalBorrow() are both 0. This exercises the
 * zero-liquidity path through the summary computation, where the reward APR
 * computations short-circuit on totalSupplyBase.lte(baseMinForRewards) rather
 * than dividing by a zero supply value.
 *
 * NOTE: like the other e2e market tests, this one hits live node providers and
 * requires V3_API_HOST / NODE_PROXY_HOST / NODE_PROXY_KEY in the environment.
 */
t.test(`/market/.../summary response format looks reasonable for an empty market`, async t => {
  const testEnv: Env = {
    'TALLY_API_KEY': 'test',
    'V3_API_HOST': apiHost,
    'NODE_PROXY_HOST': nodeHost,
    'NODE_PROXY_KEY': nodeKey,
    'ENVIRONMENT': 'test',
    'MEMORY_CACHE_SEED': 'market',
    'kv_testnet':  MemoryKv({}),
    'kv_mainnet': MemoryKv({}),
  };
  const network: KnownNetwork.Name = 'ethereum-mainnet';
  const contract = wellKnownContractsByNetwork[network]['Comet']['ctestUSDCv3'];
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
    '0xf5a628d53c47fba2c062cd6f5b6d255cb05645eb',
    'echoes back the requested comet'
  );

  /*
   * Interest APRs are rate-model outputs and are well-formed even at zero
   * utilization, so assert shape rather than value.
   */
  t.ok(/^\d+\.\d+$/.test(borrow_apr), 'borrow_apr is a decimal string');
  t.ok(/^\d+\.\d+$/.test(supply_apr), 'supply_apr is a decimal string');

  /*
   * Values, by contrast, must be exactly zero while the market is empty.
   */
  t.equal(Number(total_borrow_value), 0, 'total_borrow_value is zero');
  t.equal(Number(total_supply_value), 0, 'total_supply_value is zero');
  t.equal(Number(total_collateral_value), 0, 'total_collateral_value is zero');
  t.equal(Number(utilization), 0, 'utilization is zero');

  t.end();
});
