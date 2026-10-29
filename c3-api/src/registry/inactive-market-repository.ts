import type {
  Address,
  InactiveMarketApplyV1,
  InactiveMarketDetailV1,
  InactiveMarketListV1,
  InactiveMarketResultV1,
  InactiveMarketReviewV1,
  RetainedInactiveMarketV1,
  VersionRefV1,
} from '../../lib/model/comet-registry.js';

import type { ApiError } from '../http/errors.js';

import type { DecisionKind, DecisionList, KindNames, KindTables, Planned, StateRow } from './decision-store.js';
import {
  activeVersionOf,
  activeVersionStatement,
  applyDecisions,
  decisionWrites,
  historyOf,
  identityOf,
  member,
  readDecision,
  reviewDecisions,
  setDecision,
} from './decision-store.js';
import { conflict } from './errors.js';
import type { InactiveMarketEventRow, InactiveMarketRow } from './rows.js';
import { rowsOf } from './sql-condition.js';

/*
 * Inactive markets: which markets an administrator has marked inactive, and
 * the audit of every change to that decision. The app takes no new deposits
 * or loans in an inactive market and lists it apart, while those who hold
 * positions in it still withdraw and repay. Nothing else changes: the market
 * keeps its lifecycle status, is served as any market is, and has its
 * collaterals decided and valued as any market's.
 *
 * A kind of the decision store (decision-store.ts), as token policies are:
 * the store builds the statements every kind shares from the kind's tables
 * (INACTIVE_MARKET_TABLES), and this module describes a market to it, answers
 * in the kind's own types (lib/model/comet-registry.ts), and reads what only
 * these decisions are read for. A decision is keyed by chain id and Comet
 * address, lowercase, rather than by a versioned market row, so it outlives
 * every activation; migration 0009 creates the tables and enforces the rest in
 * the database. A market of any status may be decided about: a decision about
 * a disabled one applies once it is served. Every read here that answers for
 * the active version resolves it in the same statement or batch as the
 * decisions, so an answer never names one version while describing another.
 *
 * Of the public reads, only /summary reads the decisions, on every request
 * (inactive-markets.ts, summary-tokens.ts); no public read of /registry/v1
 * carries them, and only the kind's own routes under /registry/v1/admin/
 * answer them (decision-handlers.ts).
 */

// how many changes one decision read lists, newest first; a market's decision changes rarely
const MAX_MARKET_EVENTS = 100;

// a market of a chain, as a decision names it: by its Comet, lowercase, as the registry stores every address
type MarketOfChain = {
  chainId:      number,
  cometAddress: Address,
};

// what tells a market of a chain from another, in a list and in a set of decisions
function chainCometKey({ chainId, cometAddress }: MarketOfChain): string {
  return `${chainId}:${cometAddress}`;
}

// what one write records for a market: a command's decision, or one row of a list
type MarketDecision = MarketOfChain & {
  isInactive: boolean,
  // null for a row that leaves its market as it is, and so needs no reason
  reason:     string | null,
};

// the administrative command for one market
type MarketChange = MarketDecision & { reason: string, actor: string };

type ListedMarketDecision = MarketDecision & { deploymentKey: string | null };

type FoundMarket = {
  network_id:     string,
  market_id:      string,
  deployment_key: string,
};

type MissingMarket = {
  market_id:      null,
  deployment_key: null,
};

// each market of a JSON parameter (`c` its chain, `m` its Comet) as the active version and the stored decision describe it
type MarketState = StateRow & (FoundMarket | MissingMarket) & { is_inactive: number | null };

/*
 * The market is found by a subquery that names one row, so every market of
 * the list has exactly one row of the answer: a validated version holds one
 * market per Comet of a network. Its status is not read: a decision is about
 * a market the version holds, whatever its status.
 */
function statesStatement(db: D1Database, markets: string): D1PreparedStatement {
  return db.prepare(
    `SELECT state.active_version_id AS version_id, version.snapshot_checksum AS checksum,
            network.id AS network_id, market.id AS market_id, market.deployment_key AS deployment_key,
            decision.is_inactive AS is_inactive, decision.updated_at AS updated_at, decision.updated_by AS updated_by,
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
     LEFT JOIN inactive_markets AS decision
       ON decision.chain_id = json_extract(row.value, '$.c')
      AND decision.comet_address = json_extract(row.value, '$.m')
     LEFT JOIN inactive_market_events AS written ON written.id = json_extract(row.value, '$.i')
     ORDER BY row.key`
  ).bind(markets);
}

function marketIn(state: MarketState, market: MarketOfChain): { found: StateRow & FoundMarket } | { missing: string } {
  if (state.network_id === null) {
    return { missing: `chain ${market.chainId} is not part of the active registry` };
  }
  if (state.market_id === null) {
    return { missing: `${market.cometAddress} is not a market of the active registry on chain ${market.chainId}` };
  }
  return { found: state };
}

function missingFrom(state: MarketState, market: MarketOfChain): string | null {
  const held = marketIn(state, market);
  return 'missing' in held ? held.missing : null;
}

// the tables of migrations/0009_inactive_markets.sql: a market without a row is not inactive
const INACTIVE_MARKET_TABLES: KindTables<MarketOfChain> = {
  decisions:    'inactive_markets',
  events:       'inactive_market_events',
  expectations: 'inactive_market_expectations',
  flag:         'is_inactive',
  previous:     'previous_is_inactive',
  keys:         { chainId: [ 'c', 'chain_id' ], cometAddress: [ 'm', 'comet_address' ] },
  alias:        'decision',
};

/*
 * Inactive markets, as the store takes them and as their routes and their
 * record name them (admin-router.ts, inactive-markets.ts). A decision is about
 * a market the registry serves, or may serve; one about a Comet the active
 * version does not hold would be a decision nobody could check.
 */
const INACTIVE_MARKET_KIND: DecisionKind<MarketOfChain, MarketDecision, ListedMarketDecision, MarketState>
  & KindNames<'isInactive', 'inactiveMarkets'> & { recordKey: string } = {
  label:       'inactive market',
  listOf:      'inactive markets',
  flag:        'isInactive',
  listKey:     'inactiveMarkets',
  segment:     'inactive',
  listPath:    'inactive-markets',
  recordKey:   'inactive-markets:v1',
  subject:     'market',
  identity:    identityOf(INACTIVE_MARKET_TABLES),
  keyOf:       chainCometKey,
  flagOf:      decision => decision.isInactive,
  storedOf:    state => state.is_inactive,
  states:      statesStatement,
  writes:      decisionWrites(INACTIVE_MARKET_TABLES),
  leftAbort:   'market is not in the active registry',
  missingFrom,
  misnamed:    (decision, state) => decision.deploymentKey !== null && state.deployment_key !== decision.deploymentKey
    ? `the list names ${decision.cometAddress} ${decision.deploymentKey}, which the active registry calls ${state.deployment_key}`
    : null,
  named:       (state, market) => `${market.cometAddress} (${state.deployment_key ?? market.cometAddress})`,
};

// the refusal of one market's decision, which a version activated meanwhile without the market aborted
function leftWhileWritten(market: MarketOfChain): ApiError {
  return conflict(
    'MARKET_LEFT_REGISTRY',
    `${market.cometAddress} left the active registry on chain ${market.chainId} while its decision was being written`,
  );
}

async function setInactiveMarket(db: D1Database, change: MarketChange): Promise<InactiveMarketResultV1> {
  const after = await setDecision(db, INACTIVE_MARKET_KIND, change, () => leftWhileWritten(change));
  return {
    registryVersion: activeVersionOf(after),
    chainId:         change.chainId,
    cometAddress:    change.cometAddress,
    isInactive:      after.is_inactive === 1,
    changed:         after.written_id !== null,
    updatedAt:       after.updated_at,
  };
}

/*
 * One market's decision and the changes that led to it (readDecision), the
 * first of which is always the change that set the decision in force
 * (historyOf; migrations/0009_inactive_markets.sql says why).
 */
async function readInactiveMarket(db: D1Database, market: MarketOfChain): Promise<InactiveMarketDetailV1> {
  const { registryVersion, state, events } = await readDecision(
    db,
    INACTIVE_MARKET_KIND,
    market,
    () => historyOf(db, INACTIVE_MARKET_TABLES, market, MAX_MARKET_EVENTS),
  );
  return {
    registryVersion,
    chainId:         market.chainId,
    cometAddress:    market.cometAddress,
    inActiveVersion: state.market_id !== null,
    isInactive:      state.is_inactive === 1,
    updatedAt:       state.updated_at,
    updatedBy:       state.updated_by,
    events: rowsOf<InactiveMarketEventRow>(events).map(event => ({
      id:                 event.id,
      previousIsInactive: event.previous_is_inactive === null ? null : event.previous_is_inactive === 1,
      isInactive:         event.is_inactive === 1,
      actor:              event.actor,
      reason:             event.reason,
      createdAt:          event.created_at,
    })),
  };
}

/*
 * The export, as one batch for one version: the active version; every market
 * of it, disabled ones included, with the decision in force; and the
 * decisions kept for markets it does not hold, each of which applies again if
 * a version brings its Comet back.
 */
function exportStatements(db: D1Database): D1PreparedStatement[] {
  return [
    activeVersionStatement(db),
    db.prepare(
      `SELECT network.chain_id AS chain_id, contract.address AS comet_address, market.deployment_key AS deployment_key,
              COALESCE(decision.is_inactive, 0) AS is_inactive
       FROM registry_state AS state
       JOIN registry_networks AS network ON network.registry_version_id = state.active_version_id
       JOIN markets AS market
         ON market.registry_version_id = state.active_version_id AND market.network_id = network.id
       JOIN market_contracts AS contract ON contract.market_id = market.id AND contract.role = 'comet'
       LEFT JOIN inactive_markets AS decision
         ON decision.chain_id = network.chain_id
        AND decision.comet_address = contract.address
       WHERE state.singleton_id = 1
       ORDER BY network.chain_id, market.deployment_key`
    ),
    db.prepare(
      `SELECT decision.chain_id AS chain_id, decision.comet_address AS comet_address,
              decision.is_inactive AS is_inactive, decision.updated_at AS updated_at, decision.updated_by AS updated_by
       FROM inactive_markets AS decision
       WHERE NOT EXISTS (
         SELECT 1
         FROM registry_state AS state
         JOIN registry_networks AS network
           ON network.registry_version_id = state.active_version_id AND network.chain_id = decision.chain_id
         JOIN markets AS market
           ON market.registry_version_id = state.active_version_id AND market.network_id = network.id
         JOIN market_contracts AS contract
           ON contract.market_id = market.id AND contract.role = 'comet' AND contract.address = decision.comet_address
         WHERE state.singleton_id = 1
       )
       ORDER BY decision.chain_id, decision.comet_address`
    ),
  ];
}

/*
 * Every market of the active version with the decision in force, as a list
 * review and apply take back: the file an operator edits instead of writing
 * Comets by hand. Beside it, the decisions kept for markets the active
 * version does not hold (exportStatements).
 */
async function exportInactiveMarkets(
  db: D1Database,
): Promise<InactiveMarketListV1 & { registryVersion: VersionRefV1, retained: RetainedInactiveMarketV1[] }> {
  const [ pointer, listed, kept ] = await db.batch(exportStatements(db));

  const registryVersion = activeVersionOf(rowsOf<{ version_id: string | null, checksum: string | null }>(pointer)[0]);
  return {
    registryVersion,
    reason: null,
    ...member(
      INACTIVE_MARKET_KIND.listKey,
      rowsOf<{ chain_id: number, comet_address: Address, deployment_key: string, is_inactive: number }>(listed).map(row => ({
        chainId:       row.chain_id,
        cometAddress:  row.comet_address,
        deploymentKey: row.deployment_key,
        isInactive:    row.is_inactive === 1,
      })),
    ),
    retained: rowsOf<InactiveMarketRow>(kept).map(row => ({
      chainId:      row.chain_id,
      cometAddress: row.comet_address,
      isInactive:   row.is_inactive === 1,
      updatedAt:    row.updated_at,
      updatedBy:    row.updated_by,
    })),
  };
}

/*
 * How applying a list is refused: a row that cannot be applied, named by its
 * market, and a version activated meanwhile without one of the list's
 * markets.
 */
const LIST_REFUSALS = {
  // typed by what it reads, so that applyDecisions takes the type of a row's state from the kind rather than from it
  problemOf: ({ row, decision, problem }: Pick<Planned<MarketOfChain, MarketState>, 'row' | 'decision' | 'problem'>) => (
    { row, chainId: decision.chainId, cometAddress: decision.cometAddress, problem }
  ),
  left:      () => conflict(
    'MARKET_LEFT_REGISTRY',
    `a version that does not hold every market of the list was activated while it was being applied; nothing was written`,
  ),
};

async function reviewInactiveMarkets(db: D1Database, list: DecisionList<ListedMarketDecision>): Promise<InactiveMarketReviewV1> {
  const { registryVersion, summary, planned } = await reviewDecisions(db, INACTIVE_MARKET_KIND, list);
  return {
    registryVersion,
    summary,
    ...member(INACTIVE_MARKET_KIND.listKey, planned.map(({ row, decision, state, current, action, problem }) => ({
      row,
      chainId:       decision.chainId,
      cometAddress:  decision.cometAddress,
      deploymentKey: state.deployment_key,
      current,
      requested:     decision.isInactive,
      action,
      reason:        decision.reason,
      problem,
    }))),
  };
}

/*
 * Each row of a list applied, as the transaction that wrote it left it. The
 * write's expectations abort the list unless the active version holds every
 * row's market (writeDecisions), so each row's market is found; one that is
 * not is a defect, and must not be answered as written.
 */
async function applyInactiveMarkets(db: D1Database, list: DecisionList<ListedMarketDecision>, actor: string): Promise<InactiveMarketApplyV1> {
  const { registryVersion, summary, applied } = await applyDecisions(db, INACTIVE_MARKET_KIND, list, actor, LIST_REFUSALS);
  return {
    registryVersion,
    summary,
    ...member(INACTIVE_MARKET_KIND.listKey, applied.map(({ row, decision, state }) => {
      const held = marketIn(state, decision);
      if ('missing' in held) {
        throw new Error(`a list of ${INACTIVE_MARKET_KIND.listOf} was applied with a row the active registry does not hold: ${held.missing}`);
      }
      return {
        row,
        chainId:       decision.chainId,
        cometAddress:  decision.cometAddress,
        deploymentKey: held.found.deployment_key,
        isInactive:    state.is_inactive === 1,
        changed:       state.written_id !== null,
        updatedAt:     state.updated_at,
      };
    })),
  };
}

export type { ListedMarketDecision, MarketOfChain };
export {
  INACTIVE_MARKET_KIND,
  INACTIVE_MARKET_TABLES,
  applyInactiveMarkets,
  chainCometKey,
  exportInactiveMarkets,
  readInactiveMarket,
  reviewInactiveMarkets,
  setInactiveMarket,
};
