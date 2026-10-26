import { registryHarness } from '../../util/registry-harness.js';

import { DEPRECATED_COLLATERALS, decisionRouteScenarios } from './decision-scenarios.js';

/*
 * What the deprecated collateral routes refuse, through the real worker: a
 * caller without the token, a malformed request, a chain, a Comet or a
 * collateral the active registry does not hold, a registry with nothing
 * active, and a database without the migration. Every refusal writes
 * nothing. The routes of every kind of decision refuse alike, so the
 * scenarios are decision-scenarios.ts's, run here for deprecated
 * collaterals.
 *
 * The token list is among the reads refused for a missing migration, and it
 * values collateral beside reading its decisions, so the node is one that
 * refuses every connection: a developer's .dev.vars may name a real one.
 */
decisionRouteScenarios(await registryHarness({
  admin: true,
  vars:  { NODE_PROXY_HOST: '127.0.0.1:1', NODE_PROXY_KEY: '' },
}), DEPRECATED_COLLATERALS);
