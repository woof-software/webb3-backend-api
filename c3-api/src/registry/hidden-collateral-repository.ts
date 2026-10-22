import type {
  HiddenCollateralApplyV1,
  HiddenCollateralDetailV1,
  HiddenCollateralListV1,
  HiddenCollateralResultV1,
  HiddenCollateralReviewV1,
  RetainedHiddenCollateralV1,
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
import type { HiddenCollateralEventRow, HiddenCollateralRow } from './rows.js';
import { rowsOf } from './sql-condition.js';

/*
 * Hidden collaterals: which collaterals of which Comets an administrator has
 * hidden, and the audit of every change to that decision. Discovery does not
 * show a token where its Comet hides it; the market still takes it as
 * collateral.
 *
 * They are a kind of the decision store (decision-store.ts), described to it
 * as deprecated collaterals are: a decision is about a collateral of a Comet,
 * keyed by chain id, Comet address and token address, all lowercase, and the
 * statements of both kinds are built from their tables' names
 * (collateral-decision-repository.ts). The migration that creates the tables
 * (0008) explains why, and enforces the rest in the database. Every read here
 * that answers for the active version resolves it in the same statement or
 * batch as the decisions, so an answer never names one version while
 * describing another.
 */

const TABLES: CollateralTables = {
  decisions:    'hidden_collaterals',
  events:       'hidden_collateral_events',
  expectations: 'hidden_collateral_expectations',
  flag:         'is_hidden',
  previous:     'previous_is_hidden',
};

// a collateral of a Comet, as a decision names it
type HiddenCollateral = CollateralOfComet;

// what one write records for a collateral: a command's decision, or one row of a list
type Decision = HiddenCollateral & {
  isHidden: boolean,
  // null for a row that leaves its collateral as it is, and so needs no reason
  reason:   string | null,
};

// the administrative command for one collateral
type HiddenChange = Decision & { reason: string, actor: string };

type ListedDecision = Decision & { deploymentKey: string | null, symbol: string | null };
type DecisionList   = { reason: string | null, decisions: ListedDecision[] };

type HiddenState = CollateralState & { is_hidden: number | null };

const HIDDEN_COLLATERAL_KIND = collateralKind<Decision, ListedDecision, HiddenState>(TABLES, {
  label:    'hidden collateral',
  listOf:   'hidden collaterals',
  flagOf:   decision => decision.isHidden,
  storedOf: state => state.is_hidden,
});

async function setHiddenCollateral(db: D1Database, change: HiddenChange): Promise<HiddenCollateralResultV1> {
  const after = await setDecision(db, HIDDEN_COLLATERAL_KIND, change, () => leftWhileWritten(change));
  return {
    registryVersion: activeVersionOf(after),
    chainId:         change.chainId,
    cometAddress:    change.cometAddress,
    tokenAddress:    change.tokenAddress,
    isHidden:        after.is_hidden === 1,
    changed:         after.written_id !== null,
    updatedAt:       after.updated_at,
  };
}

// one collateral's decision and its changes, newest committed first; `inActiveVersion` says whether it applies now
async function readHiddenCollateral(db: D1Database, collateral: HiddenCollateral): Promise<HiddenCollateralDetailV1> {
  const { registryVersion, state, events } = await readCollateralDecision(
    db,
    HIDDEN_COLLATERAL_KIND,
    TABLES,
    { ...collateral, isHidden: false, reason: null },
  );
  return {
    registryVersion,
    chainId:         collateral.chainId,
    cometAddress:    collateral.cometAddress,
    tokenAddress:    collateral.tokenAddress,
    inActiveVersion: state.token_id !== null,
    isHidden:        state.is_hidden === 1,
    updatedAt:       state.updated_at,
    updatedBy:       state.updated_by,
    events: rowsOf<HiddenCollateralEventRow>(events).map(event => ({
      id:               event.id,
      previousIsHidden: event.previous_is_hidden === null ? null : event.previous_is_hidden === 1,
      isHidden:         event.is_hidden === 1,
      actor:            event.actor,
      reason:           event.reason,
      createdAt:        event.created_at,
    })),
  };
}

/*
 * The collaterals an administrator has hidden, of every chain, for the reads
 * that mark collaterals with them, read as the deprecated ones are: one
 * statement, which does not resolve the active version, so a read answered
 * from an older version is marked by the decisions D1 gives all the same.
 */
async function readHiddenCollaterals(db: D1Database): Promise<HiddenCollateral[]> {
  return await readMarkedCollaterals(db, TABLES);
}

/*
 * Every collateral of every market of the active version with the decision in
 * force, as a list review and apply take back, and beside it the decisions
 * kept for collaterals the active version does not hold (exportStatements).
 */
async function exportHiddenCollaterals(
  db: D1Database,
): Promise<HiddenCollateralListV1 & { registryVersion: VersionRefV1, retained: RetainedHiddenCollateralV1[] }> {
  const [ pointer, listed, kept ] = await db.batch(exportStatements(db, TABLES));

  const registryVersion = activeVersionOf(rowsOf<{ version_id: string | null, checksum: string | null }>(pointer)[0]);
  return {
    registryVersion,
    reason:            null,
    hiddenCollaterals: rowsOf<ListedCollateralRow & { is_hidden: number }>(listed).map(row => ({
      chainId:       row.chain_id,
      cometAddress:  row.comet_address,
      deploymentKey: row.deployment_key,
      tokenAddress:  row.token_address,
      symbol:        row.symbol,
      isHidden:      row.is_hidden === 1,
    })),
    retained: rowsOf<HiddenCollateralRow>(kept).map(row => ({
      chainId:      row.chain_id,
      cometAddress: row.comet_address,
      tokenAddress: row.token_address,
      isHidden:     row.is_hidden === 1,
      updatedAt:    row.updated_at,
      updatedBy:    row.updated_by,
    })),
  };
}

async function reviewHiddenCollaterals(db: D1Database, list: DecisionList): Promise<HiddenCollateralReviewV1> {
  const { registryVersion, summary, planned } = await reviewDecisions(db, HIDDEN_COLLATERAL_KIND, list);
  return { registryVersion, summary, hiddenCollaterals: planned.map(reviewRowOf(HIDDEN_COLLATERAL_KIND)) };
}

async function applyHiddenCollaterals(db: D1Database, list: DecisionList, actor: string): Promise<HiddenCollateralApplyV1> {
  const { registryVersion, summary, applied } = await applyDecisions(db, HIDDEN_COLLATERAL_KIND, list, actor, LIST_REFUSALS);
  return {
    registryVersion,
    summary,
    hiddenCollaterals: applied.map(({ row, decision, state }) => ({
      row,
      chainId:       decision.chainId,
      cometAddress:  decision.cometAddress,
      deploymentKey: state.deployment_key!,
      tokenAddress:  decision.tokenAddress,
      symbol:        state.symbol!,
      isHidden:      state.is_hidden === 1,
      changed:       state.written_id !== null,
      updatedAt:     state.updated_at,
    })),
  };
}

export type { DecisionList, HiddenChange, HiddenCollateral, ListedDecision };
export {
  applyHiddenCollaterals,
  exportHiddenCollaterals,
  readHiddenCollateral,
  readHiddenCollaterals,
  reviewHiddenCollaterals,
  setHiddenCollateral,
};
