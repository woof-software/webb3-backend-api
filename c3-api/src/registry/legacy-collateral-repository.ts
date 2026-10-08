import type {
  Address,
  LegacyCollateralApplyV1,
  LegacyCollateralDetailV1,
  LegacyCollateralEventRow,
  LegacyCollateralListV1,
  LegacyCollateralResultV1,
  LegacyCollateralReviewV1,
  RetainedLegacyCollateralV1,
  VersionRefV1,
} from '../../lib/model/comet-registry.js';

import { ApiError } from '../http/errors.js';

import { changedRows } from './repository.js';
import { activeVersionOf, refusal, rowsOf } from './token-policy-repository.js';

/*
 * Legacy collaterals: which collaterals of which Comets an administrator has
 * marked legacy, and the audit of every change to that decision.
 *
 * It is written as the token policies are (token-policy-repository.ts), for
 * a collateral of a Comet in place of a token. A decision is keyed by chain
 * id, Comet address and token address, all lowercase, rather than by a
 * versioned row, so it outlives every activation; the migration that creates
 * the tables explains why and enforces the rest in the database. Every read
 * here that answers for the active version resolves it in the same statement
 * or batch as the decisions, so an answer never names one version while
 * describing another.
 *
 * One decision and a whole list of them are written the same way, by one
 * batch whose statements take the collaterals as one JSON parameter: a list
 * of any length is a handful of statements, and it is written completely or
 * not at all.
 */

// how many changes one decision read lists, newest first; a collateral's decision changes rarely
const MAX_LEGACY_EVENTS = 100;

// a collateral of a Comet, as a decision names it: lowercase, as the registry stores every address
type LegacyCollateral = {
  chainId:      number,
  cometAddress: Address,
  tokenAddress: Address,
};

// one decision to write
type Decision = LegacyCollateral & {
  isLegacy: boolean,
  // null for a row that leaves its collateral as it is, and so needs no reason
  reason:   string | null,
};

// the administrative command for one collateral
type LegacyChange = Decision & { reason: string, actor: string };

// a row of a list as the router read it, and the reason the list gives every row
type ListedDecision = Decision & { deploymentKey: string | null, symbol: string | null };
type DecisionList   = { reason: string | null, decisions: ListedDecision[] };

/*
 * The collaterals a statement is about, as the one JSON parameter it reads
 * with json_each: `i` is the event id a write records for the collateral, `c`
 * its chain, `m` its Comet, `t` its token, `s` the decision as 0 or 1, `r` the
 * reason or null.
 */
function keyed(decisions: Decision[]): string {
  return JSON.stringify(decisions.map(decision => ({
    i: crypto.randomUUID(),
    c: decision.chainId,
    m: decision.cometAddress,
    t: decision.tokenAddress,
    s: decision.isLegacy ? 1 : 0,
    r: decision.reason,
  })));
}

/*
 * Each collateral of a list as the active version and the stored decision
 * describe it, in the list's order. The pointer is a seeded singleton, so
 * every collateral has a row and every miss is a null column: a chain the
 * version does not hold, a Comet that is no market of it, or a token that is
 * no collateral of that market. `written_id` names the event a write recorded
 * for the collateral, and is null where it changed nothing.
 */
type CollateralState = {
  version_id:     string | null,
  checksum:       string | null,
  network_id:     string | null,
  market_id:      string | null,
  deployment_key: string | null,
  token_id:       string | null,
  symbol:         string | null,
  is_legacy:      number | null,
  updated_at:     string | null,
  updated_by:     string | null,
  written_id:     string | null,
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
            decision.is_legacy AS is_legacy, decision.updated_at AS updated_at, decision.updated_by AS updated_by,
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
     LEFT JOIN legacy_collaterals AS decision
       ON decision.chain_id = json_extract(row.value, '$.c')
      AND decision.comet_address = json_extract(row.value, '$.m')
      AND decision.token_address = json_extract(row.value, '$.t')
     LEFT JOIN legacy_collateral_events AS written ON written.id = json_extract(row.value, '$.i')
     ORDER BY row.key`
  ).bind(collaterals);
}

// why the active version cannot take a decision about this collateral, or null where it can
function missingFrom(state: CollateralState, collateral: LegacyCollateral): string | null {
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

/*
 * The version a request about one collateral resolves against, refusing a
 * chain, a Comet or a token that version does not hold. A decision is about a
 * collateral of a market the registry serves; one about anything else would be
 * a decision nobody could check.
 */
function requireActiveCollateral(state: CollateralState | undefined, collateral: LegacyCollateral): VersionRefV1 {
  const registryVersion = activeVersionOf(state);
  const missing = missingFrom(state!, collateral);
  if (missing !== null) {
    throw refusal('NOT_FOUND', missing, registryVersion);
  }
  return registryVersion;
}

/*
 * The statements of a write, each reading the collaterals from ?1, with the
 * actor as ?2 and the time as ?3.
 *
 * The event and the decision row are written only for a collateral whose
 * stored decision differs from the one asked for, where a collateral without
 * a row is not legacy, and only for a row that states a reason. The condition
 * is evaluated inside the batch, against what is stored when the batch runs,
 * not against a read taken before it: two identical requests write one event
 * between them, and a request for what already applies writes nothing.
 *
 * The triggers check, row by row, that the collateral is in the active
 * version and that each decision row is written beside its newest event. The
 * expectations then state what every collateral of the request must hold now,
 * the ones left unchanged included, and abort the transaction where one does
 * not: a version activated meanwhile without the collateral, or a decision
 * someone else changed meanwhile for a row that states no reason and so was
 * not written.
 */
const WRITE_EVENTS = `
  INSERT INTO legacy_collateral_events (
    id, chain_id, comet_address, token_address, previous_is_legacy, is_legacy, actor, reason, created_at
  )
  SELECT json_extract(row.value, '$.i'), json_extract(row.value, '$.c'), json_extract(row.value, '$.m'),
         json_extract(row.value, '$.t'), decision.is_legacy, json_extract(row.value, '$.s'), ?2,
         json_extract(row.value, '$.r'), ?3
  FROM json_each(?1) AS row
  LEFT JOIN legacy_collaterals AS decision
    ON decision.chain_id = json_extract(row.value, '$.c')
   AND decision.comet_address = json_extract(row.value, '$.m')
   AND decision.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(decision.is_legacy, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key`;

const WRITE_DECISIONS = `
  INSERT INTO legacy_collaterals (chain_id, comet_address, token_address, is_legacy, updated_at, updated_by)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.m'), json_extract(row.value, '$.t'),
         json_extract(row.value, '$.s'), ?3, ?2
  FROM json_each(?1) AS row
  LEFT JOIN legacy_collaterals AS decision
    ON decision.chain_id = json_extract(row.value, '$.c')
   AND decision.comet_address = json_extract(row.value, '$.m')
   AND decision.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(decision.is_legacy, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key
  ON CONFLICT (chain_id, comet_address, token_address) DO UPDATE
  SET is_legacy = excluded.is_legacy, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;

const EXPECT_DECISIONS = `
  INSERT INTO legacy_collateral_expectations (chain_id, comet_address, token_address, is_legacy)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.m'), json_extract(row.value, '$.t'),
         json_extract(row.value, '$.s')
  FROM json_each(?1) AS row`;

/*
 * Writes the decisions of `collaterals` (as keyed() wrote them) in one batch,
 * and reads back what each collateral holds when it is done. The answer comes
 * from the batch's own final read, never from what the request saw on the way
 * in.
 */
async function writeDecisions(
  db: D1Database,
  collaterals: string,
  actor: string,
  conflicts: { left: () => ApiError, changed: () => ApiError },
): Promise<CollateralState[]> {
  const timestamp = new Date().toISOString();

  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(WRITE_EVENTS).bind(collaterals, actor, timestamp),
      db.prepare(WRITE_DECISIONS).bind(collaterals, actor, timestamp),
      db.prepare(EXPECT_DECISIONS).bind(collaterals),
      statesStatement(db, collaterals),
    ]);
  } catch (error) {
    const message = String(error);
    if (message.includes('collateral is not in the active registry')) {
      throw conflicts.left();
    }
    if (message.includes('changed while they were being written')) {
      throw conflicts.changed();
    }
    throw error;
  }

  const audited = changedRows(results[0]!);
  const written = changedRows(results[1]!);
  const states  = rowsOf<CollateralState>(results[3]);
  // both writes carry one condition, so a difference is a defect, and it must not be reported as a success
  if (audited !== written || states.filter(state => state.written_id !== null).length !== written) {
    throw new Error(`legacy collateral writes and their audit disagree: ${audited} event(s), ${written} row(s)`);
  }
  return states;
}

/*
 * The write of one decision alone, without the read before it: what
 * setLegacyCollateral does once that read has passed, and what a test calls
 * to make the active version change in between.
 */
async function writeLegacyCollateral(db: D1Database, change: LegacyChange): Promise<LegacyCollateralResultV1> {
  const left = new ApiError(
    'CONFLICT',
    `${change.tokenAddress} left the collateral of ${change.cometAddress} in the active registry on chain ${change.chainId} `
      + `while its decision was being written`,
  );
  const [ after ] = await writeDecisions(db, keyed([ change ]), change.actor, { left: () => left, changed: () => left });
  return {
    registryVersion: activeVersionOf(after),
    chainId:         change.chainId,
    cometAddress:    change.cometAddress,
    tokenAddress:    change.tokenAddress,
    isLegacy:        after!.is_legacy === 1,
    changed:         after!.written_id !== null,
    updatedAt:       after!.updated_at,
  };
}

/*
 * The administrative command for one collateral: refuse a request the active
 * version cannot answer before writing anything, then write.
 *
 * The read first is only for a precise refusal — an unknown chain, Comet or
 * collateral, no active version — and decides nothing: the write checks
 * membership again inside its own transaction.
 */
async function setLegacyCollateral(db: D1Database, change: LegacyChange): Promise<LegacyCollateralResultV1> {
  const [ before ] = rowsOf<CollateralState>(await statesStatement(db, keyed([ change ])).all());
  requireActiveCollateral(before, change);
  return await writeLegacyCollateral(db, change);
}

/*
 * One collateral's decision and the changes that led to it, read in one batch
 * so that the history and the decision it explains are the same moment's.
 *
 * The changes are listed in the order they were committed, newest first,
 * which is rowid order (migrations/0006_legacy_collaterals.sql says why), so
 * the first one is always the change that set the decision in force.
 *
 * A decision outlives a version that drops its collateral, and applies again
 * when a later version brings it back, so it stays readable meanwhile:
 * `inActiveVersion` says whether it applies now. Only a collateral the active
 * version does not hold and nobody ever decided about is not found.
 */
async function readLegacyCollateral(db: D1Database, collateral: LegacyCollateral): Promise<LegacyCollateralDetailV1> {
  const [ head, events ] = await db.batch([
    statesStatement(db, keyed([ { ...collateral, isLegacy: false, reason: null } ])),
    db.prepare(
      `SELECT * FROM legacy_collateral_events
       WHERE chain_id = ?1 AND comet_address = ?2 AND token_address = ?3
       ORDER BY rowid DESC
       LIMIT ?4`
    ).bind(collateral.chainId, collateral.cometAddress, collateral.tokenAddress, MAX_LEGACY_EVENTS),
  ]);

  const [ state ] = rowsOf<CollateralState>(head);
  const history   = rowsOf<LegacyCollateralEventRow>(events);
  const decided   = (state !== undefined && state.is_legacy !== null) || history.length > 0;
  const registryVersion = decided ? activeVersionOf(state) : requireActiveCollateral(state, collateral);
  return {
    registryVersion,
    chainId:         collateral.chainId,
    cometAddress:    collateral.cometAddress,
    tokenAddress:    collateral.tokenAddress,
    inActiveVersion: state!.token_id !== null,
    isLegacy:        state!.is_legacy === 1,
    updatedAt:       state!.updated_at,
    updatedBy:       state!.updated_by,
    events: history.map(event => ({
      id:               event.id,
      previousIsLegacy: event.previous_is_legacy === null ? null : event.previous_is_legacy === 1,
      isLegacy:         event.is_legacy === 1,
      actor:            event.actor,
      reason:           event.reason,
      createdAt:        event.created_at,
    })),
  };
}

/*
 * The collaterals an administrator has marked legacy, of every chain or of
 * one, for the reads that mark collaterals with them. Unlike the reads above,
 * this one does not resolve the active version: each of those reads marks the
 * version it has already resolved, and a decision belongs to no version.
 */
async function readLegacyCollaterals(db: D1Database, chainId?: number): Promise<LegacyCollateral[]> {
  const statement = chainId === undefined
    ? db.prepare(
        `SELECT chain_id, comet_address, token_address FROM legacy_collaterals
         WHERE is_legacy = 1
         ORDER BY chain_id, comet_address, token_address`
      )
    : db.prepare(
        `SELECT chain_id, comet_address, token_address FROM legacy_collaterals
         WHERE chain_id = ?1 AND is_legacy = 1
         ORDER BY comet_address, token_address`
      ).bind(chainId);
  const { results } = await statement.all<{ chain_id: number, comet_address: Address, token_address: Address }>();
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
async function exportLegacyCollaterals(
  db: D1Database,
): Promise<LegacyCollateralListV1 & { registryVersion: VersionRefV1, retained: RetainedLegacyCollateralV1[] }> {
  const [ pointer, listed, kept ] = await db.batch([
    db.prepare(
      `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum
       FROM registry_state AS state
       LEFT JOIN registry_versions AS version ON version.id = state.active_version_id
       WHERE state.singleton_id = 1`
    ),
    db.prepare(
      `SELECT network.chain_id AS chain_id, contract.address AS comet_address, market.deployment_key AS deployment_key,
              token.address AS token_address, token.symbol AS symbol, COALESCE(decision.is_legacy, 0) AS is_legacy
       FROM registry_state AS state
       JOIN registry_networks AS network ON network.registry_version_id = state.active_version_id
       JOIN markets AS market
         ON market.registry_version_id = state.active_version_id AND market.network_id = network.id
       JOIN market_contracts AS contract ON contract.market_id = market.id AND contract.role = 'comet'
       JOIN market_assets AS asset ON asset.market_id = market.id AND asset.role = 'collateral'
       JOIN tokens AS token ON token.id = asset.token_id
       LEFT JOIN legacy_collaterals AS decision
         ON decision.chain_id = network.chain_id
        AND decision.comet_address = contract.address
        AND decision.token_address = token.address
       WHERE state.singleton_id = 1
       ORDER BY network.chain_id, market.deployment_key, asset.asset_index`
    ),
    db.prepare(
      `SELECT decision.chain_id AS chain_id, decision.comet_address AS comet_address, decision.token_address AS token_address,
              decision.is_legacy AS is_legacy, decision.updated_at AS updated_at, decision.updated_by AS updated_by
       FROM legacy_collaterals AS decision
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
      is_legacy:      number,
    }>(listed).map(row => ({
      chainId:       row.chain_id,
      cometAddress:  row.comet_address,
      deploymentKey: row.deployment_key,
      tokenAddress:  row.token_address,
      symbol:        row.symbol,
      isLegacy:      row.is_legacy === 1,
    })),
    retained: rowsOf<{
      chain_id:      number,
      comet_address: Address,
      token_address: Address,
      is_legacy:     number,
      updated_at:    string,
      updated_by:    string,
    }>(kept).map(row => ({
      chainId:      row.chain_id,
      cometAddress: row.comet_address,
      tokenAddress: row.token_address,
      isLegacy:     row.is_legacy === 1,
      updatedAt:    row.updated_at,
      updatedBy:    row.updated_by,
    })),
  };
}

/*
 * A list compared with what is stored, row by row: what each row would change,
 * and why the list cannot be applied where it cannot. Review answers this as
 * it is; apply refuses on any problem before writing anything.
 */
type Planned = {
  registryVersion: VersionRefV1,
  rows:            Array<LegacyCollateralReviewV1['collaterals'][number]>,
};

// each row with the reason it is written with: its own, or the list's
function decisionsOf(list: DecisionList): ListedDecision[] {
  const decisions = list.decisions.map(decision => ({ ...decision, reason: decision.reason ?? list.reason }));
  const keys = new Set(decisions.map(decision => `${decision.chainId}:${decision.cometAddress}:${decision.tokenAddress}`));
  if (keys.size !== decisions.length) {
    // the router refuses a repeated collateral; two events for one collateral in one write would break its history
    throw new Error(`a list of legacy collaterals names a collateral twice`);
  }
  return decisions;
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

async function planDecisions(db: D1Database, list: DecisionList): Promise<Planned> {
  const decisions = decisionsOf(list);
  const states    = rowsOf<CollateralState>(await statesStatement(db, keyed(decisions)).all());
  const registryVersion = activeVersionOf(states[0]);

  const rows = decisions.map((decision, index) => {
    const state   = states[index]!;
    const current = state.is_legacy === 1;
    const action  = current === decision.isLegacy ? 'unchanged' as const : 'change' as const;
    const named   = `${state.symbol ?? decision.tokenAddress} of ${state.deployment_key ?? decision.cometAddress}`;
    const problem = missingFrom(state, decision)
      ?? misnamed(decision, state)
      ?? (action === 'change' && decision.reason === null
        ? `${decision.tokenAddress} (${named}) changes, and needs a reason: its own or the list's`
        : null);
    return {
      row:           index + 1,
      chainId:       decision.chainId,
      cometAddress:  decision.cometAddress,
      deploymentKey: state.deployment_key,
      tokenAddress:  decision.tokenAddress,
      symbol:        state.symbol,
      current,
      requested:     decision.isLegacy,
      action,
      reason:        decision.reason,
      problem,
    };
  });
  return { registryVersion, rows };
}

async function reviewLegacyCollaterals(db: D1Database, list: DecisionList): Promise<LegacyCollateralReviewV1> {
  const { registryVersion, rows } = await planDecisions(db, list);
  return {
    registryVersion,
    summary: {
      change:    rows.filter(row => row.action === 'change').length,
      unchanged: rows.filter(row => row.action === 'unchanged').length,
      problems:  rows.filter(row => row.problem !== null).length,
    },
    collaterals: rows,
  };
}

/*
 * The write of a list alone, without the review before it: every decision it
 * changes, with one event each, in one transaction that also requires every
 * row to hold what the list says once it is done. A list that met a
 * concurrent activation or change writes nothing.
 */
async function writeLegacyCollateralList(db: D1Database, list: DecisionList, actor: string): Promise<LegacyCollateralApplyV1> {
  const states = await writeDecisions(db, keyed(decisionsOf(list)), actor, {
    left: () => new ApiError(
      'CONFLICT',
      `a version that does not hold every collateral of the list was activated while it was being applied; nothing was written`,
    ),
    changed: () => new ApiError(
      'CONFLICT',
      `a decision of the list was changed by someone else while it was being applied; nothing was written`,
    ),
  });
  const applied = list.decisions.map((decision, index) => ({
    row:           index + 1,
    chainId:       decision.chainId,
    cometAddress:  decision.cometAddress,
    deploymentKey: states[index]!.deployment_key!,
    tokenAddress:  decision.tokenAddress,
    symbol:        states[index]!.symbol!,
    isLegacy:      states[index]!.is_legacy === 1,
    changed:       states[index]!.written_id !== null,
    updatedAt:     states[index]!.updated_at,
  }));
  return {
    registryVersion: activeVersionOf(states[0]),
    summary: {
      changed:   applied.filter(row => row.changed).length,
      unchanged: applied.filter(row => !row.changed).length,
    },
    collaterals: applied,
  };
}

/*
 * The administrative command for a list: refuse it whole, before writing
 * anything, if any row cannot be applied, then write it.
 *
 * The list is compared with the decisions in force when it is applied, not
 * when it was reviewed. Only the rows that comparison finds to change are
 * written. Every other row is stated without a reason, so the write asserts
 * it rather than writing it: a decision someone makes on such a collateral
 * between the comparison and the write aborts the list instead of being
 * reverted.
 */
async function applyLegacyCollaterals(db: D1Database, list: DecisionList, actor: string): Promise<LegacyCollateralApplyV1> {
  const { registryVersion, rows } = await planDecisions(db, list);
  const problems = rows.filter(row => row.problem !== null);
  if (problems.length > 0) {
    throw refusal(
      'UNPROCESSABLE',
      `${problems.length} row(s) of the list cannot be applied; nothing was written`,
      registryVersion,
      {
        problems: problems.map(({ row, chainId, cometAddress, tokenAddress, problem }) => (
          { row, chainId, cometAddress, tokenAddress, problem }
        )),
      },
    );
  }
  const decisions = decisionsOf(list).map((decision, index) =>
    rows[index]!.action === 'change' ? decision : { ...decision, reason: null });
  return await writeLegacyCollateralList(db, { reason: null, decisions }, actor);
}

export type { DecisionList, LegacyChange, LegacyCollateral, ListedDecision };
export {
  MAX_LEGACY_EVENTS,
  applyLegacyCollaterals,
  exportLegacyCollaterals,
  readLegacyCollateral,
  readLegacyCollaterals,
  reviewLegacyCollaterals,
  setLegacyCollateral,
  writeLegacyCollateral,
  writeLegacyCollateralList,
};
