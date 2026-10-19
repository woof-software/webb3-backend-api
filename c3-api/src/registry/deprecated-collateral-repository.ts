import type {
  Address,
  DeprecatedCollateralApplyV1,
  DeprecatedCollateralDetailV1,
  DeprecatedCollateralListV1,
  DeprecatedCollateralResultV1,
  DeprecatedCollateralReviewV1,
  RetainedDeprecatedCollateralV1,
  VersionRefV1,
} from '../../lib/model/comet-registry.js';

import {
  DecisionKind,
  Planned,
  StateRow,
  activeVersionOf,
  applyDecisions,
  readDecision,
  reviewDecisions,
  setDecision,
} from './decision-store.js';
import { conflict } from './errors.js';
import type { DeprecatedCollateralEventRow, DeprecatedCollateralRow } from './rows.js';
import { rowsOf } from './sql-condition.js';

/*
 * Deprecated collaterals: which collaterals of which Comets an administrator
 * has marked deprecated, and the audit of every change to that decision.
 *
 * They are a kind of the decision store (decision-store.ts), as token
 * policies are: the store writes, reads, reviews and applies both, and this
 * module describes a collateral of a Comet to it, answers in the decisions'
 * own types, and reads what only these decisions are read for. A decision is
 * keyed by chain id, Comet address and token address, all lowercase, rather
 * than by a versioned row, so it outlives every activation; the migration
 * that creates the tables (0006, under the names 0007 gave them) explains why
 * and enforces the rest in the database. Every read here that answers for
 * the active version resolves it in the same statement or batch as the
 * decisions, so an answer never names one version while describing another.
 */

// how many changes one decision read lists, newest first; a collateral's decision changes rarely
const MAX_DEPRECATED_EVENTS = 100;

// a collateral of a Comet, as a decision names it: lowercase, as the registry stores every address
type DeprecatedCollateral = {
  chainId:      number,
  cometAddress: Address,
  tokenAddress: Address,
};

// what one write records for a collateral: a command's decision, or one row of a list
type Decision = DeprecatedCollateral & {
  isDeprecated: boolean,
  // null for a row that leaves its collateral as it is, and so needs no reason
  reason:       string | null,
};

// the administrative command for one collateral
type DeprecatedChange = Decision & { reason: string, actor: string };

type ListedDecision = Decision & { deploymentKey: string | null, symbol: string | null };
type DecisionList   = { reason: string | null, decisions: ListedDecision[] };

/*
 * Each collateral of a JSON parameter (`c` its chain, `m` its Comet, `t` its
 * token) as the active version and the stored decision describe it. A miss is
 * a chain the version does not hold, a Comet that is no market of it, or a
 * token that is no collateral of that market.
 */
type CollateralState = StateRow & {
  market_id:      string | null,
  deployment_key: string | null,
  is_deprecated:  number | null,
};

/*
 * The market and the token are found by subqueries that name one row each, so
 * every collateral of the list has exactly one row of the answer: a validated
 * version holds one market per Comet of a network, and lists a token once
 * among a market's collateral.
 */
function statesStatement(db: D1Database, collaterals: string): D1PreparedStatement {
  return db.prepare(
    `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
            network.id AS network_id, market.id AS market_id, market.deployment_key AS deployment_key,
            token.id AS token_id, token.symbol AS symbol,
            decision.is_deprecated AS is_deprecated, decision.updated_at AS updated_at, decision.updated_by AS updated_by,
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
     LEFT JOIN deprecated_collaterals AS decision
       ON decision.chain_id = json_extract(row.value, '$.c')
      AND decision.comet_address = json_extract(row.value, '$.m')
      AND decision.token_address = json_extract(row.value, '$.t')
     LEFT JOIN deprecated_collateral_events AS written ON written.id = json_extract(row.value, '$.i')
     ORDER BY row.key`
  ).bind(collaterals);
}

function missingFrom(state: CollateralState, collateral: DeprecatedCollateral): string | null {
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
function misnamed(decision: ListedDecision, state: CollateralState): string | null {
  if (decision.deploymentKey !== null && state.deployment_key !== decision.deploymentKey) {
    return `the list names ${decision.cometAddress} ${decision.deploymentKey}, which the active registry calls ${state.deployment_key}`;
  }
  if (decision.symbol !== null && state.symbol !== decision.symbol) {
    return `the list names ${decision.tokenAddress} ${decision.symbol}, which the active registry calls ${state.symbol}`;
  }
  return null;
}

// the statements of a write, which writeDecisions (decision-store.ts) explains: a collateral without a row is not deprecated
const WRITE_EVENTS = `
  INSERT INTO deprecated_collateral_events (
    id, chain_id, comet_address, token_address, previous_is_deprecated, is_deprecated, actor, reason, created_at
  )
  SELECT json_extract(row.value, '$.i'), json_extract(row.value, '$.c'), json_extract(row.value, '$.m'),
         json_extract(row.value, '$.t'), decision.is_deprecated, json_extract(row.value, '$.s'), ?2,
         json_extract(row.value, '$.r'), ?3
  FROM json_each(?1) AS row
  LEFT JOIN deprecated_collaterals AS decision
    ON decision.chain_id = json_extract(row.value, '$.c')
   AND decision.comet_address = json_extract(row.value, '$.m')
   AND decision.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(decision.is_deprecated, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key`;

const WRITE_DECISIONS = `
  INSERT INTO deprecated_collaterals (chain_id, comet_address, token_address, is_deprecated, updated_at, updated_by)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.m'), json_extract(row.value, '$.t'),
         json_extract(row.value, '$.s'), ?3, ?2
  FROM json_each(?1) AS row
  LEFT JOIN deprecated_collaterals AS decision
    ON decision.chain_id = json_extract(row.value, '$.c')
   AND decision.comet_address = json_extract(row.value, '$.m')
   AND decision.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(decision.is_deprecated, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key
  ON CONFLICT (chain_id, comet_address, token_address) DO UPDATE
  SET is_deprecated = excluded.is_deprecated, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;

const EXPECT_DECISIONS = `
  INSERT INTO deprecated_collateral_expectations (chain_id, comet_address, token_address, is_deprecated)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.m'), json_extract(row.value, '$.t'),
         json_extract(row.value, '$.s')
  FROM json_each(?1) AS row`;

/*
 * Deprecated collaterals, as the store takes them. A decision is about a
 * collateral of a market the registry serves; one about anything else would
 * be a decision nobody could check.
 */
const DEPRECATED_COLLATERAL_KIND: DecisionKind<Decision, ListedDecision, CollateralState> = {
  label:       'deprecated collateral',
  listOf:      'deprecated collaterals',
  subject:     'collateral',
  identity:    decision => ({ c: decision.chainId, m: decision.cometAddress, t: decision.tokenAddress }),
  keyOf:       decision => `${decision.chainId}:${decision.cometAddress}:${decision.tokenAddress}`,
  flagOf:      decision => decision.isDeprecated,
  storedOf:    state => state.is_deprecated,
  states:      statesStatement,
  writes:      { events: WRITE_EVENTS, rows: WRITE_DECISIONS, expectations: EXPECT_DECISIONS },
  leftAbort:   'collateral is not in the active registry',
  missingFrom,
  misnamed,
  named:       (state, decision) => `${state.symbol ?? decision.tokenAddress} of ${state.deployment_key ?? decision.cometAddress}`,
};

async function setDeprecatedCollateral(db: D1Database, change: DeprecatedChange): Promise<DeprecatedCollateralResultV1> {
  const after = await setDecision(db, DEPRECATED_COLLATERAL_KIND, change, () => conflict(
    'COLLATERAL_LEFT_REGISTRY',
    `${change.tokenAddress} left the collateral of ${change.cometAddress} in the active registry on chain ${change.chainId} `
      + `while its decision was being written`,
  ));
  return {
    registryVersion: activeVersionOf(after),
    chainId:         change.chainId,
    cometAddress:    change.cometAddress,
    tokenAddress:    change.tokenAddress,
    isDeprecated:    after.is_deprecated === 1,
    changed:         after.written_id !== null,
    updatedAt:       after.updated_at,
  };
}

/*
 * One collateral's decision and the changes that led to it (readDecision).
 * `inActiveVersion` says whether the decision applies now.
 *
 * The changes are listed in the order they were committed, newest first,
 * which is rowid order (migrations/0006_legacy_collaterals.sql says why), so
 * the first one is always the change that set the decision in force.
 */
async function readDeprecatedCollateral(db: D1Database, collateral: DeprecatedCollateral): Promise<DeprecatedCollateralDetailV1> {
  const { registryVersion, state, events } = await readDecision(
    db,
    DEPRECATED_COLLATERAL_KIND,
    { ...collateral, isDeprecated: false, reason: null },
    () => db.prepare(
      `SELECT * FROM deprecated_collateral_events
       WHERE chain_id = ?1 AND comet_address = ?2 AND token_address = ?3
       ORDER BY rowid DESC
       LIMIT ?4`
    ).bind(collateral.chainId, collateral.cometAddress, collateral.tokenAddress, MAX_DEPRECATED_EVENTS),
  );
  return {
    registryVersion,
    chainId:         collateral.chainId,
    cometAddress:    collateral.cometAddress,
    tokenAddress:    collateral.tokenAddress,
    inActiveVersion: state.token_id !== null,
    isDeprecated:    state.is_deprecated === 1,
    updatedAt:       state.updated_at,
    updatedBy:       state.updated_by,
    events: rowsOf<DeprecatedCollateralEventRow>(events).map(event => ({
      id:                   event.id,
      previousIsDeprecated: event.previous_is_deprecated === null ? null : event.previous_is_deprecated === 1,
      isDeprecated:         event.is_deprecated === 1,
      actor:                event.actor,
      reason:               event.reason,
      createdAt:            event.created_at,
    })),
  };
}

/*
 * The collaterals an administrator has marked deprecated, of every chain, for
 * the reads that mark collaterals with them. The active reads and the token
 * list take this one statement, and each picks out the decisions of the chain
 * it marks by DeprecatedDecisions.has, which is keyed by chain. Unlike the
 * reads above, this one does not resolve the active version: each of those
 * reads marks the version it has already resolved, and a decision belongs to
 * no version.
 */
async function readDeprecatedCollaterals(db: D1Database): Promise<DeprecatedCollateral[]> {
  const { results } = await db.prepare(
    `SELECT chain_id, comet_address, token_address FROM deprecated_collaterals
     WHERE is_deprecated = 1
     ORDER BY chain_id, comet_address, token_address`
  ).all<{ chain_id: number, comet_address: Address, token_address: Address }>();
  return (results ?? []).map(row => ({ chainId: row.chain_id, cometAddress: row.comet_address, tokenAddress: row.token_address }));
}

/*
 * Every collateral of every market of the active version with the decision in
 * force, as a list review and apply take back: the file an operator edits
 * instead of writing addresses by hand. Beside it, the decisions kept for
 * collaterals the active version does not hold, each of which applies again
 * if a version brings its collateral back to its Comet. One batch, for one
 * version.
 *
 * A disabled market's collaterals are listed too: a decision about one is
 * made while nobody is offered the market, and applies once it is served.
 */
async function exportDeprecatedCollaterals(
  db: D1Database,
): Promise<DeprecatedCollateralListV1 & { registryVersion: VersionRefV1, retained: RetainedDeprecatedCollateralV1[] }> {
  const [ pointer, listed, kept ] = await db.batch([
    db.prepare(
      `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum
       FROM registry_state AS state
       LEFT JOIN registry_versions AS version ON version.id = state.active_version_id
       WHERE state.singleton_id = 1`
    ),
    db.prepare(
      `SELECT network.chain_id AS chain_id, contract.address AS comet_address, market.deployment_key AS deployment_key,
              token.address AS token_address, token.symbol AS symbol, COALESCE(decision.is_deprecated, 0) AS is_deprecated
       FROM registry_state AS state
       JOIN registry_networks AS network ON network.registry_version_id = state.active_version_id
       JOIN markets AS market
         ON market.registry_version_id = state.active_version_id AND market.network_id = network.id
       JOIN market_contracts AS contract ON contract.market_id = market.id AND contract.role = 'comet'
       JOIN market_assets AS asset ON asset.market_id = market.id AND asset.role = 'collateral'
       JOIN tokens AS token ON token.id = asset.token_id
       LEFT JOIN deprecated_collaterals AS decision
         ON decision.chain_id = network.chain_id
        AND decision.comet_address = contract.address
        AND decision.token_address = token.address
       WHERE state.singleton_id = 1
       ORDER BY network.chain_id, market.deployment_key, asset.asset_index`
    ),
    db.prepare(
      `SELECT decision.chain_id AS chain_id, decision.comet_address AS comet_address, decision.token_address AS token_address,
              decision.is_deprecated AS is_deprecated, decision.updated_at AS updated_at, decision.updated_by AS updated_by
       FROM deprecated_collaterals AS decision
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
  ]);

  const registryVersion = activeVersionOf(rowsOf<{ version_id: string | null, checksum: string | null }>(pointer)[0]);
  return {
    registryVersion,
    reason:      null,
    collaterals: rowsOf<{
      chain_id:       number,
      comet_address:  Address,
      deployment_key: string,
      token_address:  Address,
      symbol:         string,
      is_deprecated:  number,
    }>(listed).map(row => ({
      chainId:       row.chain_id,
      cometAddress:  row.comet_address,
      deploymentKey: row.deployment_key,
      tokenAddress:  row.token_address,
      symbol:        row.symbol,
      isDeprecated:  row.is_deprecated === 1,
    })),
    retained: rowsOf<DeprecatedCollateralRow>(kept).map(row => ({
      chainId:      row.chain_id,
      cometAddress: row.comet_address,
      tokenAddress: row.token_address,
      isDeprecated: row.is_deprecated === 1,
      updatedAt:    row.updated_at,
      updatedBy:    row.updated_by,
    })),
  };
}

function reviewRow(
  { row, decision, state, current, action, problem }: Planned<ListedDecision, CollateralState>,
): DeprecatedCollateralReviewV1['collaterals'][number] {
  return {
    row,
    chainId:       decision.chainId,
    cometAddress:  decision.cometAddress,
    deploymentKey: state.deployment_key,
    tokenAddress:  decision.tokenAddress,
    symbol:        state.symbol,
    current,
    requested:     decision.isDeprecated,
    action,
    reason:        decision.reason,
    problem,
  };
}

async function reviewDeprecatedCollaterals(db: D1Database, list: DecisionList): Promise<DeprecatedCollateralReviewV1> {
  const { registryVersion, summary, planned } = await reviewDecisions(db, DEPRECATED_COLLATERAL_KIND, list);
  return { registryVersion, summary, collaterals: planned.map(reviewRow) };
}

async function applyDeprecatedCollaterals(db: D1Database, list: DecisionList, actor: string): Promise<DeprecatedCollateralApplyV1> {
  const { registryVersion, summary, applied } = await applyDecisions(db, DEPRECATED_COLLATERAL_KIND, list, actor, {
    problemOf: ({ row, decision, problem }) => (
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
  });
  return {
    registryVersion,
    summary,
    collaterals: applied.map(({ row, decision, state }) => ({
      row,
      chainId:       decision.chainId,
      cometAddress:  decision.cometAddress,
      deploymentKey: state.deployment_key!,
      tokenAddress:  decision.tokenAddress,
      symbol:        state.symbol!,
      isDeprecated:  state.is_deprecated === 1,
      changed:       state.written_id !== null,
      updatedAt:     state.updated_at,
    })),
  };
}

export type { DecisionList, DeprecatedChange, DeprecatedCollateral, ListedDecision };
export {
  applyDeprecatedCollaterals,
  exportDeprecatedCollaterals,
  readDeprecatedCollateral,
  readDeprecatedCollaterals,
  reviewDeprecatedCollaterals,
  setDeprecatedCollateral,
};
