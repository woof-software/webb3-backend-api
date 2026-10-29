import { registryHarness } from '../../util/registry-harness.js';

import { INACTIVE_MARKETS, decisionRouteScenarios } from './decision-scenarios.js';

/*
 * What the inactive market routes refuse, through the real worker: a caller
 * without the token, a malformed request, a chain or a Comet the active
 * registry does not hold, a registry with nothing active, and a database
 * without the migration. Every refusal writes nothing. The routes of every
 * kind of decision refuse alike, so the scenarios are decision-scenarios.ts's,
 * run here for inactive markets.
 */
decisionRouteScenarios(await registryHarness({ admin: true }), INACTIVE_MARKETS);
