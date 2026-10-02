import type {
  Address,
  TokenPoliciesV1,
  TokenPolicyApplyV1,
  TokenPolicyDetailV1,
  TokenPolicyEventRow,
  TokenPolicyListV1,
  TokenPolicyResultV1,
  TokenPolicyReviewV1,
  VersionRefV1,
} from '../../lib/model/comet-registry.js';

import { ApiError } from '../http/errors.js';

import { changedRows } from './repository.js';
import { registryHeaders } from './version-headers.js';

/*
 * Token policies: which tokens an administrator has marked strategic, and the
 * audit of every change to that decision.
 *
 * A policy is keyed by chain id and lowercase address rather than by a
 * versioned token row, so it outlives every activation; the migration that
 * creates the tables explains why and enforces the rest in the database.
 * Every read here resolves the active version in the same statement or batch
 * as the policy rows, so an answer never names one version while describing
 * another.
 *
 * One decision and a whole list of them are written the same way, by one
 * batch whose statements take the tokens as one JSON parameter: a list of any
 * length is a handful of statements, and it is written completely or not at
 * all.
 */

// how many changes one policy read lists, newest first; a token's decision changes rarely
const MAX_POLICY_EVENTS = 100;

// one decision to write
type Decision = {
  chainId:      number,
  // lowercase, as the registry stores every address
  tokenAddress: Address,
  isStrategic:  boolean,
  // null for a row that leaves its token as it is, and so needs no reason
  reason:       string | null,
};

// the administrative command for one token
type PolicyChange = Decision & { reason: string, actor: string };

// a row of a list as the router read it, and the reason the list gives every row
type ListedDecision = Decision & { symbol: string | null };
type DecisionList   = { reason: string | null, decisions: ListedDecision[] };

/*
 * The tokens a statement is about, as the one JSON parameter it reads with
 * json_each: `i` is the event id a write records for the token, `c` its
 * chain, `t` its address, `s` the decision as 0 or 1, `r` the reason or null.
 */
function keyed(decisions: Decision[]): string {
  return JSON.stringify(decisions.map(decision => ({
    i: crypto.randomUUID(),
    c: decision.chainId,
    t: decision.tokenAddress,
    s: decision.isStrategic ? 1 : 0,
    r: decision.reason,
  })));
}

/*
 * Each token of a list as the active version and the stored decision describe
 * it, in the list's order. The pointer is a seeded singleton, so every token
 * has a row and every miss is a null column. `written_id` names the event a
 * write recorded for the token, and is null where it changed nothing.
 */
type TokenState = {
  version_id:   string | null,
  checksum:     string | null,
  network_id:   string | null,
  token_id:     string | null,
  symbol:       string | null,
  is_strategic: number | null,
  updated_at:   string | null,
  updated_by:   string | null,
  written_id:   string | null,
};

function statesStatement(db: D1Database, tokens: string): D1PreparedStatement {
  return db.prepare(
    `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
            network.id AS network_id, token.id AS token_id, token.symbol AS symbol,
            policy.is_strategic AS is_strategic, policy.updated_at AS updated_at, policy.updated_by AS updated_by,
            written.id AS written_id
     FROM json_each(?1) AS row
     JOIN registry_state AS state ON state.singleton_id = 1
     LEFT JOIN registry_versions AS version ON version.id = state.active_version_id
     LEFT JOIN registry_networks AS network
       ON network.registry_version_id = state.active_version_id
      AND network.chain_id = json_extract(row.value, '$.c')
     LEFT JOIN tokens AS token
       ON token.registry_version_id = state.active_version_id
      AND token.network_id = network.id
      AND token.address = json_extract(row.value, '$.t')
     LEFT JOIN token_policies AS policy
       ON policy.chain_id = json_extract(row.value, '$.c')
      AND policy.token_address = json_extract(row.value, '$.t')
     LEFT JOIN token_policy_events AS written ON written.id = json_extract(row.value, '$.i')
     ORDER BY row.key`
  ).bind(tokens);
}

function rowsOf<T>(result: D1Result | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function activeVersionOf(row: { version_id: string | null, checksum: string | null } | null | undefined): VersionRefV1 {
  if (row === null || row === undefined || row.version_id === null || row.checksum === null) {
    throw new ApiError('REGISTRY_NOT_ACTIVE', `No active registry snapshot is available`);
  }
  return { id: row.version_id, checksum: row.checksum };
}

/*
 * A refusal decided against a version names it, as a success would: the
 * token is missing from that version, and may be in the next one.
 */
function refusal(
  code: 'NOT_FOUND' | 'CONFLICT' | 'UNPROCESSABLE',
  message: string,
  registryVersion: VersionRefV1,
  details: Record<string, unknown> = {},
): ApiError {
  return new ApiError(code, message, { registryVersion, ...details }, registryHeaders(registryVersion));
}

// why the active version cannot take a decision about this token, or null where it can
function missingFrom(state: TokenState, decision: { chainId: number, tokenAddress: Address }): string | null {
  if (state.network_id === null) {
    return `chain ${decision.chainId} is not part of the active registry`;
  }
  if (state.token_id === null) {
    return `${decision.tokenAddress} is not a token of the active registry on chain ${decision.chainId}`;
  }
  return null;
}

/*
 * The version a request about one token resolves against, refusing a chain or
 * a token that version does not hold. A policy is a decision about a token the
 * registry serves; one about an address it does not describe would be a
 * decision nobody could check.
 */
function requireActiveToken(state: TokenState | undefined, chainId: number, tokenAddress: Address): VersionRefV1 {
  const registryVersion = activeVersionOf(state);
  const missing = missingFrom(state!, { chainId, tokenAddress });
  if (missing !== null) {
    throw refusal('NOT_FOUND', missing, registryVersion);
  }
  return registryVersion;
}

/*
 * The statements of a write, each reading the tokens from ?1, with the actor
 * as ?2 and the time as ?3.
 *
 * The event and the policy row are written only for a token whose stored
 * decision differs from the one asked for, where a token without a row is not
 * strategic, and only for a row that states a reason. The condition is
 * evaluated inside the batch, against what is stored when the batch runs, not
 * against a read taken before it: two identical requests write one event
 * between them, and a request for what already applies writes nothing.
 *
 * The triggers check, row by row, that the token is in the active version and
 * that each policy row is written beside its newest event. The expectations
 * then state what every token of the request must hold now, the tokens left
 * unchanged included, and abort the transaction where one does not: a version
 * activated meanwhile without the token, or a decision someone else changed
 * meanwhile for a row that states no reason and so was not written.
 */
const WRITE_EVENTS = `
  INSERT INTO token_policy_events (
    id, chain_id, token_address, previous_is_strategic, is_strategic, actor, reason, created_at
  )
  SELECT json_extract(row.value, '$.i'), json_extract(row.value, '$.c'), json_extract(row.value, '$.t'),
         policy.is_strategic, json_extract(row.value, '$.s'), ?2, json_extract(row.value, '$.r'), ?3
  FROM json_each(?1) AS row
  LEFT JOIN token_policies AS policy
    ON policy.chain_id = json_extract(row.value, '$.c')
   AND policy.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(policy.is_strategic, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key`;

const WRITE_POLICIES = `
  INSERT INTO token_policies (chain_id, token_address, is_strategic, updated_at, updated_by)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.t'), json_extract(row.value, '$.s'), ?3, ?2
  FROM json_each(?1) AS row
  LEFT JOIN token_policies AS policy
    ON policy.chain_id = json_extract(row.value, '$.c')
   AND policy.token_address = json_extract(row.value, '$.t')
  WHERE json_extract(row.value, '$.r') IS NOT NULL
    AND COALESCE(policy.is_strategic, 0) <> json_extract(row.value, '$.s')
  ORDER BY row.key
  ON CONFLICT (chain_id, token_address) DO UPDATE
  SET is_strategic = excluded.is_strategic, updated_at = excluded.updated_at, updated_by = excluded.updated_by`;

const EXPECT_DECISIONS = `
  INSERT INTO token_policy_expectations (chain_id, token_address, is_strategic)
  SELECT json_extract(row.value, '$.c'), json_extract(row.value, '$.t'), json_extract(row.value, '$.s')
  FROM json_each(?1) AS row`;

/*
 * Writes the decisions of `tokens` (as keyed() wrote them) in one batch, and
 * reads back what each token holds when it is done. The answer comes from the
 * batch's own final read, never from what the request saw on the way in.
 */
async function writeDecisions(
  db: D1Database,
  tokens: string,
  actor: string,
  conflicts: { left: () => ApiError, changed: () => ApiError },
): Promise<TokenState[]> {
  const timestamp = new Date().toISOString();

  let results: D1Result[];
  try {
    results = await db.batch([
      db.prepare(WRITE_EVENTS).bind(tokens, actor, timestamp),
      db.prepare(WRITE_POLICIES).bind(tokens, actor, timestamp),
      db.prepare(EXPECT_DECISIONS).bind(tokens),
      statesStatement(db, tokens),
    ]);
  } catch (error) {
    const message = String(error);
    if (message.includes('token is not in the active registry')) {
      throw conflicts.left();
    }
    if (message.includes('changed while they were being written')) {
      throw conflicts.changed();
    }
    throw error;
  }

  const audited = changedRows(results[0]!);
  const written = changedRows(results[1]!);
  const states  = rowsOf<TokenState>(results[3]);
  // both writes carry one condition, so a difference is a defect, and it must not be reported as a success
  if (audited !== written || states.filter(state => state.written_id !== null).length !== written) {
    throw new Error(`token policy writes and their audit disagree: ${audited} event(s), ${written} row(s)`);
  }
  return states;
}

/*
 * The write of one decision alone, without the read before it: what
 * setTokenPolicy does once that read has passed, and what a test calls to
 * make the active version change in between.
 */
async function writeTokenPolicy(db: D1Database, change: PolicyChange): Promise<TokenPolicyResultV1> {
  const left = new ApiError(
    'CONFLICT',
    `${change.tokenAddress} left the active registry on chain ${change.chainId} while its policy was being written`,
  );
  const [ after ] = await writeDecisions(db, keyed([ change ]), change.actor, { left: () => left, changed: () => left });
  return {
    registryVersion: activeVersionOf(after),
    chainId:         change.chainId,
    tokenAddress:    change.tokenAddress,
    isStrategic:     after!.is_strategic === 1,
    changed:         after!.written_id !== null,
    updatedAt:       after!.updated_at,
  };
}

/*
 * The administrative command for one token: refuse a request the active
 * version cannot answer before writing anything, then write.
 *
 * The read first is only for a precise refusal — an unknown chain, an unknown
 * token, no active version — and decides nothing: the write checks membership
 * again inside its own transaction.
 */
async function setTokenPolicy(db: D1Database, change: PolicyChange): Promise<TokenPolicyResultV1> {
  const [ before ] = rowsOf<TokenState>(await statesStatement(db, keyed([ change ])).all());
  requireActiveToken(before, change.chainId, change.tokenAddress);
  return await writeTokenPolicy(db, change);
}

/*
 * One token's decision and the changes that led to it, read in one batch so
 * that the history and the decision it explains are the same moment's.
 *
 * The changes are listed in the order they were committed, newest first,
 * which is rowid order (migrations/0004_token_policies.sql says why), so the
 * first one is always the change that set the decision in force.
 *
 * A decision outlives a version that drops its token, and applies again when
 * a later version brings the token back, so it stays readable meanwhile:
 * `inActiveVersion` says whether it applies now. Only a token the active
 * version does not hold and nobody ever decided about is not found.
 */
async function readTokenPolicy(db: D1Database, chainId: number, tokenAddress: Address): Promise<TokenPolicyDetailV1> {
  const [ head, events ] = await db.batch([
    statesStatement(db, keyed([ { chainId, tokenAddress, isStrategic: false, reason: null } ])),
    db.prepare(
      `SELECT * FROM token_policy_events
       WHERE chain_id = ?1 AND token_address = ?2
       ORDER BY rowid DESC
       LIMIT ?3`
    ).bind(chainId, tokenAddress, MAX_POLICY_EVENTS),
  ]);

  const [ state ] = rowsOf<TokenState>(head);
  const history   = rowsOf<TokenPolicyEventRow>(events);
  const decided   = (state !== undefined && state.is_strategic !== null) || history.length > 0;
  const registryVersion = decided ? activeVersionOf(state) : requireActiveToken(state, chainId, tokenAddress);
  return {
    registryVersion,
    chainId,
    tokenAddress,
    inActiveVersion: state!.token_id !== null,
    isStrategic:     state!.is_strategic === 1,
    updatedAt:       state!.updated_at,
    updatedBy:       state!.updated_by,
    events: history.map(event => ({
      id:                  event.id,
      previousIsStrategic: event.previous_is_strategic === null ? null : event.previous_is_strategic === 1,
      isStrategic:         event.is_strategic === 1,
      actor:               event.actor,
      reason:              event.reason,
      createdAt:           event.created_at,
    })),
  };
}

/*
 * Every token one network of the active version holds, with the decision in
 * force for each, and beside them the decisions kept for tokens of the chain
 * that the active version does not hold, each of which applies again if a
 * version brings its token back. A chain the active version dropped entirely
 * still answers with what is kept for it; only a chain with neither tokens nor
 * decisions is not found. One batch, so the version it names is the version
 * it lists.
 */
async function readTokenPolicies(db: D1Database, chainId: number): Promise<TokenPoliciesV1> {
  const [ listed, kept ] = await db.batch([
    db.prepare(
      `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
              network.id AS network_id,
              token.address AS address, token.symbol AS symbol, token.name AS name, token.decimals AS decimals,
              policy.is_strategic AS is_strategic, policy.updated_at AS updated_at, policy.updated_by AS updated_by
       FROM registry_state AS state
       LEFT JOIN registry_versions AS version ON version.id = state.active_version_id
       LEFT JOIN registry_networks AS network
         ON network.registry_version_id = state.active_version_id AND network.chain_id = ?1
       LEFT JOIN tokens AS token
         ON token.registry_version_id = state.active_version_id AND token.network_id = network.id
       LEFT JOIN token_policies AS policy
         ON policy.chain_id = ?1 AND policy.token_address = token.address
       WHERE state.singleton_id = 1
       ORDER BY token.symbol COLLATE NOCASE, token.address`
    ).bind(chainId),
    db.prepare(
      `SELECT policy.token_address AS address, policy.is_strategic AS is_strategic,
              policy.updated_at AS updated_at, policy.updated_by AS updated_by
       FROM token_policies AS policy
       WHERE policy.chain_id = ?1
         AND NOT EXISTS (
           SELECT 1
           FROM registry_state AS state
           JOIN registry_networks AS network
             ON network.registry_version_id = state.active_version_id AND network.chain_id = policy.chain_id
           JOIN tokens AS token
             ON token.registry_version_id = state.active_version_id
            AND token.network_id = network.id
            AND token.address = policy.token_address
           WHERE state.singleton_id = 1
         )
       ORDER BY policy.token_address`
    ).bind(chainId),
  ]);

  const rows = rowsOf<{
    version_id:   string | null,
    checksum:     string | null,
    network_id:   string | null,
    address:      Address | null,
    symbol:       string | null,
    name:         string | null,
    decimals:     number | null,
    is_strategic: number | null,
    updated_at:   string | null,
    updated_by:   string | null,
  }>(listed);
  const retained = rowsOf<{ address: Address, is_strategic: number, updated_at: string, updated_by: string }>(kept);

  const registryVersion = activeVersionOf(rows[0]);
  const inActiveVersion = rows[0]!.network_id !== null;
  if (!inActiveVersion && retained.length === 0) {
    throw refusal('NOT_FOUND', `chain ${chainId} is not part of the active registry`, registryVersion);
  }
  return {
    registryVersion,
    chainId,
    inActiveVersion,
    tokens: rows.filter(row => row.address !== null).map(row => ({
      address:     row.address!,
      symbol:      row.symbol!,
      name:        row.name!,
      decimals:    row.decimals!,
      isStrategic: row.is_strategic === 1,
      updatedAt:   row.updated_at,
      updatedBy:   row.updated_by,
    })),
    retained: retained.map(row => ({
      address:     row.address,
      isStrategic: row.is_strategic === 1,
      updatedAt:   row.updated_at,
      updatedBy:   row.updated_by,
    })),
  };
}

/*
 * Every token of every network of the active version with the decision in
 * force, as a list review and apply take back: the file an operator edits
 * instead of writing addresses by hand. One batch, for one version.
 */
async function exportTokenPolicies(db: D1Database): Promise<TokenPolicyListV1 & { registryVersion: VersionRefV1 }> {
  const [ pointer, listed ] = await db.batch([
    db.prepare(
      `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum
       FROM registry_state AS state
       LEFT JOIN registry_versions AS version ON version.id = state.active_version_id
       WHERE state.singleton_id = 1`
    ),
    db.prepare(
      `SELECT network.chain_id AS chain_id, token.address AS address, token.symbol AS symbol,
              COALESCE(policy.is_strategic, 0) AS is_strategic
       FROM registry_state AS state
       JOIN registry_networks AS network ON network.registry_version_id = state.active_version_id
       JOIN tokens AS token
         ON token.registry_version_id = state.active_version_id AND token.network_id = network.id
       LEFT JOIN token_policies AS policy
         ON policy.chain_id = network.chain_id AND policy.token_address = token.address
       WHERE state.singleton_id = 1
       ORDER BY network.chain_id, token.symbol COLLATE NOCASE, token.address`
    ),
  ]);

  const registryVersion = activeVersionOf(rowsOf<{ version_id: string | null, checksum: string | null }>(pointer)[0]);
  return {
    registryVersion,
    reason:   null,
    policies: rowsOf<{ chain_id: number, address: Address, symbol: string, is_strategic: number }>(listed).map(row => ({
      chainId:      row.chain_id,
      tokenAddress: row.address,
      symbol:       row.symbol,
      isStrategic:  row.is_strategic === 1,
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
  rows:            Array<TokenPolicyReviewV1['policies'][number]>,
};

// each row with the reason it is written with: its own, or the list's
function decisionsOf(list: DecisionList): ListedDecision[] {
  const decisions = list.decisions.map(decision => ({ ...decision, reason: decision.reason ?? list.reason }));
  const keys = new Set(decisions.map(decision => `${decision.chainId}:${decision.tokenAddress}`));
  if (keys.size !== decisions.length) {
    // the router refuses a repeated token; two events for one token in one write would break its history
    throw new Error(`a list of token policies names a token twice`);
  }
  return decisions;
}

async function planDecisions(db: D1Database, list: DecisionList): Promise<Planned> {
  const decisions = decisionsOf(list);
  const states    = rowsOf<TokenState>(await statesStatement(db, keyed(decisions)).all());
  const registryVersion = activeVersionOf(states[0]);

  const rows = decisions.map((decision, index) => {
    const state   = states[index]!;
    const current = state.is_strategic === 1;
    const action  = current === decision.isStrategic ? 'unchanged' as const : 'change' as const;
    const named   = state.symbol ?? decision.tokenAddress;
    const problem = missingFrom(state, decision)
      ?? (decision.symbol !== null && state.symbol !== decision.symbol
        ? `the list names ${decision.tokenAddress} ${decision.symbol}, which the active registry calls ${state.symbol}`
        : null)
      ?? (action === 'change' && decision.reason === null
        ? `${decision.tokenAddress} (${named}) changes, and needs a reason: its own or the list's`
        : null);
    return {
      row:          index + 1,
      chainId:      decision.chainId,
      tokenAddress: decision.tokenAddress,
      symbol:       state.symbol,
      current,
      requested:    decision.isStrategic,
      action,
      reason:       decision.reason,
      problem,
    };
  });
  return { registryVersion, rows };
}

async function reviewTokenPolicies(db: D1Database, list: DecisionList): Promise<TokenPolicyReviewV1> {
  const { registryVersion, rows } = await planDecisions(db, list);
  return {
    registryVersion,
    summary: {
      change:    rows.filter(row => row.action === 'change').length,
      unchanged: rows.filter(row => row.action === 'unchanged').length,
      problems:  rows.filter(row => row.problem !== null).length,
    },
    policies: rows,
  };
}

/*
 * The write of a list alone, without the review before it: every decision it
 * changes, with one event each, in one transaction that also requires every
 * row to hold what the list says once it is done. A list that met a
 * concurrent activation or change writes nothing.
 */
async function writeTokenPolicyList(db: D1Database, list: DecisionList, actor: string): Promise<TokenPolicyApplyV1> {
  const states = await writeDecisions(db, keyed(decisionsOf(list)), actor, {
    left: () => new ApiError(
      'CONFLICT',
      `a version that does not hold every token of the list was activated while it was being applied; nothing was written`,
    ),
    changed: () => new ApiError(
      'CONFLICT',
      `a decision of the list was changed by someone else while it was being applied; nothing was written`,
    ),
  });
  const applied = list.decisions.map((decision, index) => ({
    row:          index + 1,
    chainId:      decision.chainId,
    tokenAddress: decision.tokenAddress,
    symbol:       states[index]!.symbol!,
    isStrategic:  states[index]!.is_strategic === 1,
    changed:      states[index]!.written_id !== null,
    updatedAt:    states[index]!.updated_at,
  }));
  return {
    registryVersion: activeVersionOf(states[0]),
    summary: {
      changed:   applied.filter(row => row.changed).length,
      unchanged: applied.filter(row => !row.changed).length,
    },
    policies: applied,
  };
}

/*
 * The administrative command for a list: refuse it whole, before writing
 * anything, if any row cannot be applied, then write it. As for one token,
 * the review first is for a precise refusal; the write checks again inside
 * its own transaction.
 */
async function applyTokenPolicies(db: D1Database, list: DecisionList, actor: string): Promise<TokenPolicyApplyV1> {
  const { registryVersion, rows } = await planDecisions(db, list);
  const problems = rows.filter(row => row.problem !== null);
  if (problems.length > 0) {
    throw refusal(
      'UNPROCESSABLE',
      `${problems.length} row(s) of the list cannot be applied; nothing was written`,
      registryVersion,
      { problems: problems.map(({ row, chainId, tokenAddress, problem }) => ({ row, chainId, tokenAddress, problem })) },
    );
  }
  return await writeTokenPolicyList(db, list, actor);
}

export type { DecisionList, ListedDecision, PolicyChange };
export {
  MAX_POLICY_EVENTS,
  applyTokenPolicies,
  exportTokenPolicies,
  readTokenPolicies,
  readTokenPolicy,
  reviewTokenPolicies,
  setTokenPolicy,
  writeTokenPolicy,
  writeTokenPolicyList,
};
