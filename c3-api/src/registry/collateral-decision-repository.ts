import type { Address, VersionRefV1 } from '../../lib/model/comet-registry.js';

import type { ApiError } from '../http/errors.js';

import type { DecisionKind, Planned, StateRow } from './decision-store.js';
import { readDecision } from './decision-store.js';
import { conflict } from './errors.js';

/*
 * What the kinds of decision about a collateral of a Comet share: deprecated
 * collaterals (deprecated-collateral-repository.ts) and hidden collaterals
 * (hidden-collateral-repository.ts). Each is a kind of the decision store
 * (decision-store.ts), and their tables are one shape under two sets of names
 * (migrations 0006, under the names 0007 gave it, and 0008), so each kind's
 * statements are built here from its tables' names: the same text, naming
 * the kind's own tables and no other's. A read of one kind never reads the
 * other's decisions, and a test that picks a statement out by its text picks
 * one kind's.
 *
 * Each kind answers in its own types, as the store's kinds do. What is here
 * is said of a collateral of a Comet, not of what a kind decides about it.
 */

// how many changes one decision read lists, newest first; a collateral's decision changes rarely
const MAX_COLLATERAL_EVENTS = 100;

// a collateral of a Comet, as a decision names it: lowercase, as the registry stores every address
type CollateralOfComet = {
  chainId:      number,
  cometAddress: Address,
  tokenAddress: Address,
};

// what a row of a list names beside its collateral, for the person editing the file
type ListedNames = { deploymentKey: string | null, symbol: string | null };

/*
 * A kind's tables: the decisions in force, their audit, and the view a write
 * states what it expects in; the column of the flag, and an event's column of
 * the flag it replaces.
 */
type CollateralTables = {
  decisions:    string,
  events:       string,
  expectations: string,
  flag:         string,
  previous:     string,
};

/*
 * Each collateral of a JSON parameter (`c` its chain, `m` its Comet, `t` its
 * token) as the active version and the stored decision describe it, beside the
 * kind's column of the flag. A miss is a chain the version does not hold, a
 * Comet that is no market of it, or a token that is no collateral of that
 * market.
 */
type CollateralState = StateRow & {
  market_id:      string | null,
  deployment_key: string | null,
};

/*
 * The market and the token are found by subqueries that name one row each, so
 * every collateral of the list has exactly one row of the answer: a validated
 * version holds one market per Comet of a network, and lists a token once
 * among a market's collateral.
 */
function statesStatement(db: D1Database, { decisions, events, flag }: CollateralTables, collaterals: string): D1PreparedStatement {
  return db.prepare(
    `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
            network.id AS network_id, market.id AS market_id, market.deployment_key AS deployment_key,
            token.id AS token_id, token.symbol AS symbol,
            decision.${flag} AS ${flag}, decision.updated_at AS updated_at, decision.updated_by AS updated_by,
            written.id AS written_id
     FROM json_each(?1) AS row
     JOIN registry_state AS state ON state.singleton_id = 1
     LEFT JOIN registry_versions AS version ON version.id = state.active_version_id
     LEFT JOIN registry_networks AS network
       ON network.registry_version_id = state.active_version_id
      AND network.chain_id = json_extract(row.value, '$.c')
     LEFT JOIN markets AS market
       ON market.id = (
         SELECT candidate.id
         FROM markets AS candidate
         JOIN market_contracts AS contract
           ON contract.market_id = candidate.id
          AND contract.role = 'comet'
         WHERE candidate.registry_version_id = state.active_version_id
           AND candidate.network_id = network.id
           AND contract.address = json_extract(row.value, '$.m')
       )
     LEFT JOIN tokens AS token
       ON token.id = (
         SELECT asset.token_id
         FROM market_assets AS asset
         JOIN tokens AS held ON held.id = asset.token_id
         WHERE asset.market_id = market.id
           AND asset.role = 'collateral'
           AND held.address = json_extract(row.value, '$.t')
       )
     LEFT JOIN ${decisions} AS decision
       ON decision.chain_id = json_extract(row.value, '$.c')
      AND decision.comet_address = json_extract(row.value, '$.m')
      AND decision.token_address = json_extract(row.value, '$.t')
     LEFT JOIN ${events} AS written ON written.id = json_extract(row.value, '$.i')
     ORDER BY row.key`
  ).bind(collaterals);
}

function missingFrom(state: CollateralState, collateral: CollateralOfComet): string | null {
  if (state.network_id === null) {
    return `chain ${collateral.chainId} is not part of the active registry`;
  }
  if (state.market_id === null) {
    return `${collateral.cometAddress} is not a market of the active registry on chain ${collateral.chainId}`;
  }
  if (state.token_id === null) {
    return `${collateral.tokenAddress} is not a collateral of ${collateral.cometAddress} in the active registry on chain ${collateral.chainId}`;
  }
  return null;
}

// what a row names that the active version names otherwise: its market, or its token's symbol
function misnamed(decision: CollateralOfComet & ListedNames, state: CollateralState): string | null {
  if (decision.deploymentKey !== null && state.deployment_key !== decision.deploymentKey) {
    return `the list names ${decision.cometAddress} ${decision.deploymentKey}, which the active registry calls ${state.deployment_key}`;
  }
  if (decision.symbol !== null && state.symbol !== decision.symbol) {
    return `the list names ${decision.tokenAddress} ${decision.symbol}, which the active registry calls ${state.symbol}`;
  }
  return null;
}

// the statements of a write, which writeDecisions (decision-store.ts) explains: a collateral without a row has the flag unset
function writesOf({ decisions, events, expectations, flag, previous }: CollateralTables): { events: string, rows: string, expectations: string } {
  return {
    events: `
  INSERT INTO ${events} (
    id, chain_id, comet_address, token_address, ${previous}, ${flag}, actor, reason, created_at
  )
  SELECT json_extract(row.value, '$.i'), json_extract(row.value, '$.c'), json_extract(row.value, '$.m'),
         json_extract(row.value, '$.t'), decision.${flag}, json_extract(row.value, '$.s'), ?2,
         json_extract(row.value, '$.r'), ?3
  FROM json_each(?1) AS row
  LEFT JOIN ${decisions} AS decision
    ON decision.chain_id = json_extract(row.value, '$.c')
   AND decision.comet_address = json_extract(row.value, '$.m')
   AND decision.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(decision.${flag}, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key`,
    rows: `
  INSERT INTO ${decisions} (chain_id, comet_address, token_address, ${flag}, updated_at, updated_by)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.m'), json_extract(row.value, '$.t'),
         json_extract(row.value, '$.s'), ?3, ?2
  FROM json_each(?1) AS row
  LEFT JOIN ${decisions} AS decision
    ON decision.chain_id = json_extract(row.value, '$.c')
   AND decision.comet_address = json_extract(row.value, '$.m')
   AND decision.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(decision.${flag}, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key
  ON CONFLICT (chain_id, comet_address, token_address) DO UPDATE
  SET ${flag} = excluded.${flag}, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    expectations: `
  INSERT INTO ${expectations} (chain_id, comet_address, token_address, ${flag})
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.m'), json_extract(row.value, '$.t'),
         json_extract(row.value, '$.s')
  FROM json_each(?1) AS row`,
  };
}

/*
 * A kind of decision about a collateral of a Comet, as the store takes it:
 * the kind's names, its flag, and its tables. A decision is about a
 * collateral of a market the registry serves; one about anything else would
 * be a decision nobody could check. Both migrations' triggers abort the same
 * way where the active version does not hold the collateral.
 */
function collateralKind<
  Decision extends CollateralOfComet & { reason: string | null },
  Listed extends Decision & ListedNames,
  State extends CollateralState,
>(
  tables: CollateralTables,
  { label, listOf, flagOf, storedOf }: Pick<DecisionKind<Decision, Listed, State>, 'label' | 'listOf' | 'flagOf' | 'storedOf'>,
): DecisionKind<Decision, Listed, State> {
  return {
    label,
    listOf,
    subject:     'collateral',
    identity:    decision => ({ c: decision.chainId, m: decision.cometAddress, t: decision.tokenAddress }),
    keyOf:       decision => `${decision.chainId}:${decision.cometAddress}:${decision.tokenAddress}`,
    flagOf,
    storedOf,
    states:      (db, collaterals) => statesStatement(db, tables, collaterals),
    writes:      writesOf(tables),
    leftAbort:   'collateral is not in the active registry',
    missingFrom,
    misnamed,
    named:       (state, decision) => `${state.symbol ?? decision.tokenAddress} of ${state.deployment_key ?? decision.cometAddress}`,
  };
}

/*
 * One collateral's decision and the changes that led to it (readDecision).
 * The changes are listed in the order they were committed, newest first,
 * which is rowid order (migrations/0006_legacy_collaterals.sql says why), so
 * the first one is always the change that set the decision in force.
 */
async function readCollateralDecision<
  Decision extends CollateralOfComet & { reason: string | null },
  Listed extends Decision & ListedNames,
  State extends CollateralState,
>(
  db: D1Database,
  kind: DecisionKind<Decision, Listed, State>,
  { events }: CollateralTables,
  decision: NoInfer<Decision>,
): Promise<{ registryVersion: VersionRefV1, state: State, events: D1Result }> {
  return await readDecision(
    db,
    kind,
    decision,
    () => db.prepare(
      `SELECT * FROM ${events}
       WHERE chain_id = ?1 AND comet_address = ?2 AND token_address = ?3
       ORDER BY rowid DESC
       LIMIT ?4`
    ).bind(decision.chainId, decision.cometAddress, decision.tokenAddress, MAX_COLLATERAL_EVENTS),
  );
}

/*
 * The collaterals whose flag is set, of every chain, for the reads that mark
 * collaterals with them: one statement, through the kind's partial index.
 * Unlike the reads of one decision or of a list, it does not resolve the
 * active version: each read that marks collaterals marks the version it has
 * already resolved, and a decision belongs to no version.
 */
async function readMarkedCollaterals(db: D1Database, { decisions, flag }: CollateralTables): Promise<CollateralOfComet[]> {
  const { results } = await db.prepare(
    `SELECT chain_id, comet_address, token_address FROM ${decisions}
     WHERE ${flag} = 1
     ORDER BY chain_id, comet_address, token_address`
  ).all<{ chain_id: number, comet_address: Address, token_address: Address }>();
  return (results ?? []).map(row => ({ chainId: row.chain_id, cometAddress: row.comet_address, tokenAddress: row.token_address }));
}

// a collateral of the export, beside the decision in force, which the kind's column of the flag holds
type ListedCollateralRow = {
  chain_id:       number,
  comet_address:  Address,
  deployment_key: string,
  token_address:  Address,
  symbol:         string,
};

/*
 * The export, as one batch for one version: the active version; every
 * collateral of every market of it, disabled ones included, with the decision
 * in force; and the decisions kept for collaterals it does not hold, each of
 * which applies again if a version brings its collateral back to its Comet.
 * A disabled market's collaterals are listed because a decision about one is
 * made while nobody is offered the market, and applies once it is served.
 */
function exportStatements(db: D1Database, { decisions, flag }: CollateralTables): D1PreparedStatement[] {
  return [
    db.prepare(
      `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum
       FROM registry_state AS state
       LEFT JOIN registry_versions AS version ON version.id = state.active_version_id
       WHERE state.singleton_id = 1`
    ),
    db.prepare(
      `SELECT network.chain_id AS chain_id, contract.address AS comet_address, market.deployment_key AS deployment_key,
              token.address AS token_address, token.symbol AS symbol, COALESCE(decision.${flag}, 0) AS ${flag}
       FROM registry_state AS state
       JOIN registry_networks AS network ON network.registry_version_id = state.active_version_id
       JOIN markets AS market
         ON market.registry_version_id = state.active_version_id AND market.network_id = network.id
       JOIN market_contracts AS contract ON contract.market_id = market.id AND contract.role = 'comet'
       JOIN market_assets AS asset ON asset.market_id = market.id AND asset.role = 'collateral'
       JOIN tokens AS token ON token.id = asset.token_id
       LEFT JOIN ${decisions} AS decision
         ON decision.chain_id = network.chain_id
        AND decision.comet_address = contract.address
        AND decision.token_address = token.address
       WHERE state.singleton_id = 1
       ORDER BY network.chain_id, market.deployment_key, asset.asset_index`
    ),
    db.prepare(
      `SELECT decision.chain_id AS chain_id, decision.comet_address AS comet_address, decision.token_address AS token_address,
              decision.${flag} AS ${flag}, decision.updated_at AS updated_at, decision.updated_by AS updated_by
       FROM ${decisions} AS decision
       WHERE NOT EXISTS (
         SELECT 1
         FROM registry_state AS state
         JOIN registry_networks AS network
           ON network.registry_version_id = state.active_version_id AND network.chain_id = decision.chain_id
         JOIN markets AS market
           ON market.registry_version_id = state.active_version_id AND market.network_id = network.id
         JOIN market_contracts AS contract
           ON contract.market_id = market.id AND contract.role = 'comet' AND contract.address = decision.comet_address
         JOIN market_assets AS asset ON asset.market_id = market.id AND asset.role = 'collateral'
         JOIN tokens AS token ON token.id = asset.token_id AND token.address = decision.token_address
         WHERE state.singleton_id = 1
       )
       ORDER BY decision.chain_id, decision.comet_address, decision.token_address`
    ),
  ];
}

// the refusal of one collateral's decision, which a version activated meanwhile without the collateral aborted
function leftWhileWritten(collateral: CollateralOfComet): ApiError {
  return conflict(
    'COLLATERAL_LEFT_REGISTRY',
    `${collateral.tokenAddress} left the collateral of ${collateral.cometAddress} in the active registry on chain ${collateral.chainId} `
      + `while its decision was being written`,
  );
}

/*
 * How applying a list is refused: a row that cannot be applied, named by its
 * collateral; a version activated meanwhile without one of the list's
 * collaterals; and a decision someone made meanwhile on a row the list leaves
 * as it is.
 */
const LIST_REFUSALS = {
  problemOf: ({ row, decision, problem }: Planned<CollateralOfComet, CollateralState>) => (
    { row, chainId: decision.chainId, cometAddress: decision.cometAddress, tokenAddress: decision.tokenAddress, problem }
  ),
  conflicts: {
    left: () => conflict(
      'COLLATERAL_LEFT_REGISTRY',
      `a version that does not hold every collateral of the list was activated while it was being applied; nothing was written`,
    ),
    changed: () => conflict(
      'DECISION_CHANGED',
      `a decision of the list was changed by someone else while it was being applied; nothing was written`,
    ),
  },
};

// a row of a review, as every kind answers it: what the active version calls the collateral, and what applying would do
function reviewRowOf<
  Decision extends CollateralOfComet & { reason: string | null },
  Listed extends Decision & ListedNames,
  State extends CollateralState,
>(
  kind: DecisionKind<Decision, Listed, State>,
): (planned: Planned<Listed, State>) => {
  row:           number,
  chainId:       number,
  cometAddress:  Address,
  deploymentKey: string | null,
  tokenAddress:  Address,
  symbol:        string | null,
  current:       boolean,
  requested:     boolean,
  action:        'change' | 'unchanged',
  reason:        string | null,
  problem:       string | null,
} {
  return ({ row, decision, state, current, action, problem }) => ({
    row,
    chainId:       decision.chainId,
    cometAddress:  decision.cometAddress,
    deploymentKey: state.deployment_key,
    tokenAddress:  decision.tokenAddress,
    symbol:        state.symbol,
    current,
    requested:     kind.flagOf(decision),
    action,
    reason:        decision.reason,
    problem,
  });
}

export type { CollateralOfComet, CollateralState, CollateralTables, ListedCollateralRow, ListedNames };
export {
  LIST_REFUSALS,
  collateralKind,
  exportStatements,
  leftWhileWritten,
  readCollateralDecision,
  readMarkedCollaterals,
  reviewRowOf,
};
