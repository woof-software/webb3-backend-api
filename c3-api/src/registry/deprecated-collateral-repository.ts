import type {
  DeprecatedCollateralApplyV1,
  DeprecatedCollateralDetailV1,
  DeprecatedCollateralListV1,
  DeprecatedCollateralResultV1,
  DeprecatedCollateralReviewV1,
  RetainedDeprecatedCollateralV1,
  VersionRefV1,
} from '../../lib/model/comet-registry.js';

import type {
  CollateralOfComet,
  CollateralState,
  CollateralTables,
  ListedCollateralRow,
} from './collateral-decision-repository.js';
import {
  LIST_REFUSALS,
  collateralKind,
  exportStatements,
  leftWhileWritten,
  readCollateralDecision,
  readMarkedCollaterals,
  reviewRowOf,
} from './collateral-decision-repository.js';
import { activeVersionOf, applyDecisions, reviewDecisions, setDecision } from './decision-store.js';
import type { DeprecatedCollateralEventRow, DeprecatedCollateralRow } from './rows.js';
import { rowsOf } from './sql-condition.js';

/*
 * Deprecated collaterals: which collaterals of which Comets an administrator
 * has marked deprecated, and the audit of every change to that decision.
 *
 * They are a kind of the decision store (decision-store.ts), as token
 * policies are: the store writes, reads, reviews and applies every kind, and
 * this module describes deprecated collaterals to it, answers in the
 * decisions' own types, and reads what only these decisions are read for. A
 * decision is about a collateral of a Comet, as a hidden collateral's is, and
 * the statements of both kinds are built from their tables' names
 * (collateral-decision-repository.ts). A decision is keyed by chain id, Comet
 * address and token address, all lowercase, rather than by a versioned row,
 * so it outlives every activation; the migration that creates the tables
 * (0006, under the names 0007 gave them) explains why and enforces the rest
 * in the database. Every read here that answers for the active version
 * resolves it in the same statement or batch as the decisions, so an answer
 * never names one version while describing another.
 */

const TABLES: CollateralTables = {
  decisions:    'deprecated_collaterals',
  events:       'deprecated_collateral_events',
  expectations: 'deprecated_collateral_expectations',
  flag:         'is_deprecated',
  previous:     'previous_is_deprecated',
};

// a collateral of a Comet, as a decision names it
type DeprecatedCollateral = CollateralOfComet;

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

type DeprecatedState = CollateralState & { is_deprecated: number | null };

const DEPRECATED_COLLATERAL_KIND = collateralKind<Decision, ListedDecision, DeprecatedState>(TABLES, {
  label:    'deprecated collateral',
  listOf:   'deprecated collaterals',
  flagOf:   decision => decision.isDeprecated,
  storedOf: state => state.is_deprecated,
});

async function setDeprecatedCollateral(db: D1Database, change: DeprecatedChange): Promise<DeprecatedCollateralResultV1> {
  const after = await setDecision(db, DEPRECATED_COLLATERAL_KIND, change, () => leftWhileWritten(change));
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

// one collateral's decision and its changes, newest committed first; `inActiveVersion` says whether it applies now
async function readDeprecatedCollateral(db: D1Database, collateral: DeprecatedCollateral): Promise<DeprecatedCollateralDetailV1> {
  const { registryVersion, state, events } = await readCollateralDecision(
    db,
    DEPRECATED_COLLATERAL_KIND,
    TABLES,
    { ...collateral, isDeprecated: false, reason: null },
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
 * reads above, this one does not resolve the active version.
 */
async function readDeprecatedCollaterals(db: D1Database): Promise<DeprecatedCollateral[]> {
  return await readMarkedCollaterals(db, TABLES);
}

/*
 * Every collateral of every market of the active version with the decision in
 * force, as a list review and apply take back: the file an operator edits
 * instead of writing addresses by hand. Beside it, the decisions kept for
 * collaterals the active version does not hold (exportStatements).
 */
async function exportDeprecatedCollaterals(
  db: D1Database,
): Promise<DeprecatedCollateralListV1 & { registryVersion: VersionRefV1, retained: RetainedDeprecatedCollateralV1[] }> {
  const [ pointer, listed, kept ] = await db.batch(exportStatements(db, TABLES));

  const registryVersion = activeVersionOf(rowsOf<{ version_id: string | null, checksum: string | null }>(pointer)[0]);
  return {
    registryVersion,
    reason:      null,
    collaterals: rowsOf<ListedCollateralRow & { is_deprecated: number }>(listed).map(row => ({
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

async function reviewDeprecatedCollaterals(db: D1Database, list: DecisionList): Promise<DeprecatedCollateralReviewV1> {
  const { registryVersion, summary, planned } = await reviewDecisions(db, DEPRECATED_COLLATERAL_KIND, list);
  return { registryVersion, summary, collaterals: planned.map(reviewRowOf(DEPRECATED_COLLATERAL_KIND)) };
}

async function applyDeprecatedCollaterals(db: D1Database, list: DecisionList, actor: string): Promise<DeprecatedCollateralApplyV1> {
  const { registryVersion, summary, applied } = await applyDecisions(db, DEPRECATED_COLLATERAL_KIND, list, actor, LIST_REFUSALS);
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
