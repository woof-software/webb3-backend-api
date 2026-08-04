import t from 'tap';

/*
 * NOTE: eth-constants MUST be imported before contracts/utils.
 *
 * utils.ts imports eth-constants.js ahead of types.js, and eth-constants
 * evaluates every per-network contracts file, each of which calls ERC20()
 * and friends at module scope. Entering the module graph at utils.js
 * therefore runs those calls before types.js has initialized
 * ContractTypeTag, throwing "Cannot access 'ContractTypeTag' before
 * initialization". Entering at eth-constants.js -- as the worker entrypoint
 * and every other test does -- orders the cycle correctly.
 */
import { wellKnownContractsByNetwork } from '../../../../lib/eth-constants.js';

import { getCometContractsForNetwork } from '../../../../lib/well-known/contracts/utils.js';

import '../../../../shim/node-self.js';

const network = 'ethereum-mainnet' as const;
const testMarketAddress = '0xf5a628D53c47fBA2C062cd6F5B6D255cb05645Eb';
const testRewardsAddress = '0x3c2b39375f8b3813842b6c59CA8afD0fe3b4b0d7';
const prodRewardsAddress = '0x1b0e765f6224c21223aea2af16c1c46e38885a40';

/*
 * ctestUSDCv3 is a test deployment on a production network and NOTHING filters
 * it out: it is returned by getCometContractsForNetwork() like any other
 * market, so it appears in every `all-contracts` aggregate response. Isolation
 * is a deployment concern -- this declaration is meant to ship only to stage.
 *
 * This test pins that reality rather than asserting a filter that does not
 * exist, so that the day someone adds filtering the test fails loudly and gets
 * updated deliberately.
 */
t.test('ctestUSDCv3 is aggregated like any other market', async t => {
  const contracts = getCometContractsForNetwork(network);

  t.ok(
    contracts.some(({ address }) => address === testMarketAddress),
    'ctestUSDCv3 IS present in ethereum-mainnet aggregation (nothing hides it)'
  );
  t.ok(
    contracts.some(({ displayName }) => displayName === 'cUSDCv3'),
    'production markets are present alongside it'
  );
});

/*
 * This is the load-bearing assertion.
 *
 * get-reward-configs-sleuth.ts batches every comet returned here into a single
 * Sleuth query against cometMarkets[0].rewards.contract, assuming one
 * CometRewards per network. ctestUSDCv3 brings a second CometRewards to
 * ethereum-mainnet, and since it is NOT filtered out it enters that batch. The
 * only thing keeping production markets correct is that ctestUSDCv3 is declared
 * last in contractData, so cometMarkets[0] is still cUSDCv3 with the canonical
 * CometRewards.
 *
 * If this test fails, production reward configs are being read from the test
 * rewards contract and will silently come back zero.
 */
t.test('cometMarkets[0] still uses the production CometRewards', async t => {
  const contracts = getCometContractsForNetwork(network);

  t.equal(contracts[0].displayName, 'cUSDCv3', 'cometMarkets[0] is cUSDCv3');
  t.equal(
    contracts[0].rewards.contract.address,
    prodRewardsAddress,
    'cometMarkets[0] uses the production CometRewards'
  );
  t.not(
    contracts[0].rewards.contract.address,
    testRewardsAddress,
    'cometMarkets[0] does not use the test rewards contract'
  );
  t.equal(
    contracts[contracts.length - 1].address,
    testMarketAddress,
    'ctestUSDCv3 is last, so it can never become cometMarkets[0]'
  );
});

t.test('registry lookups resolve the test market and its contracts', async t => {
  const wellKnown = wellKnownContractsByNetwork[network];

  t.equal(
    (wellKnown as any)[testMarketAddress].displayName,
    'ctestUSDCv3',
    'resolves by address'
  );
  t.equal(
    (wellKnown as any)['Comet']['ctestUSDCv3'].address,
    testMarketAddress,
    'resolves by displayName alias'
  );
  t.equal(
    (wellKnown as any)['Comet']['01-testusdc'].address,
    testMarketAddress,
    'resolves by 01-testusdc alias'
  );
  t.equal(
    (wellKnown as any)['CometRewards']['default'].address,
    prodRewardsAddress,
    'the production CometRewards still owns the default alias'
  );
  t.equal(
    (wellKnown as any)['CometRewards']['test-svc-patch'].address,
    testRewardsAddress,
    'the test CometRewards is reachable under its own alias'
  );
});
