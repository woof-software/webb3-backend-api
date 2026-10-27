-- Migration number: 0009    2026-10-27T09:00:00.000Z
-- Inactive markets: which markets an administrator has marked inactive. The
-- app takes no new deposits or loans in an inactive market and lists it
-- apart, while those who hold positions in it still withdraw and repay. The
-- market keeps its lifecycle status, which a registry version sets, and is
-- served and valued as before; only /summary says it is inactive.
--
-- A decision belongs to a market as the chain knows it — a chain id and the
-- Comet's address — as a decision about a collateral belongs to the
-- collateral of a Comet (0006, 0008), and not to the rows a registry version
-- holds for the market: one keyed by what the market is survives every
-- activation, and applies again to a market a later version brings back.
--
-- A market nobody has decided about is not inactive. That default has no
-- row: a row exists once someone has changed the decision, and keeps the
-- latest.
--
-- Every change is recorded in inactive_market_events, in the same
-- transaction as the row it changes, with who made it and why. The schema
-- enforces that as 0008 does for hidden collaterals, with the same indexes,
-- triggers and view under these names, less the token: a decision row is
-- written only beside its market's newest event, which records exactly that
-- change; events are never edited, replaced or deleted, and a decision row is
-- never deleted. A decision is reversed by recording the opposite one.
--
-- A market's history is read in the order it was committed, which is rowid
-- order: events are only ever appended, so each one takes the next rowid
-- inside its writing transaction. created_at is when the Worker stamped the
-- request, and two requests in flight together can commit in the opposite
-- order to their stamps.
--
-- The migration only adds tables, with their indexes and triggers, and a
-- view, and no trigger on any table an earlier migration created: nothing the
-- release before it reads or writes, so that release, and any other release
-- on the same database, runs on beside them until the deploy that follows.
--
-- Conventions follow 0001: every statement ends with a semicolon at the end
-- of a line, every trigger body ends with a line containing only END followed
-- by a semicolon, and D1 always enforces foreign keys.

CREATE TABLE inactive_markets (
  chain_id       INTEGER NOT NULL CHECK (chain_id > 0 AND chain_id <= 9007199254740991),
  comet_address  TEXT NOT NULL CHECK (
    length(comet_address) = 42
    AND substr(comet_address, 1, 2) = '0x'
    AND substr(comet_address, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  is_inactive    INTEGER NOT NULL CHECK (is_inactive IN (0, 1)),
  updated_at     TEXT NOT NULL,
  updated_by     TEXT NOT NULL CHECK (length(trim(updated_by)) > 0),
  PRIMARY KEY (chain_id, comet_address)
) STRICT, WITHOUT ROWID;
-- without a rowid, a REPLACE can only name a decision by its market: it
-- cannot reach another market's row through a rowid and delete it unaudited

-- the inactive markets, of every chain or of one, without reading the rows that say otherwise
CREATE INDEX inactive_markets_marked
  ON inactive_markets (chain_id, comet_address)
  WHERE is_inactive = 1;

CREATE TABLE inactive_market_events (
  id                    TEXT PRIMARY KEY,
  chain_id              INTEGER NOT NULL CHECK (chain_id > 0 AND chain_id <= 9007199254740991),
  comet_address         TEXT NOT NULL CHECK (
    length(comet_address) = 42
    AND substr(comet_address, 1, 2) = '0x'
    AND substr(comet_address, 3) NOT GLOB '*[^0-9a-f]*'
  ),
  -- null when the market had no decision row, which means it was not inactive
  previous_is_inactive  INTEGER CHECK (
    previous_is_inactive IS NULL OR previous_is_inactive IN (0, 1)
  ),
  is_inactive           INTEGER NOT NULL CHECK (is_inactive IN (0, 1)),
  actor                 TEXT NOT NULL CHECK (length(trim(actor)) > 0),
  reason                TEXT NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 1000),
  created_at            TEXT NOT NULL,
  -- an event records a change, so the decision it records differs from the one it replaced
  CHECK (COALESCE(previous_is_inactive, 0) <> is_inactive)
) STRICT;

-- one market's events, in rowid order, which every index entry ends with
CREATE INDEX inactive_market_events_market_history
  ON inactive_market_events (chain_id, comet_address);

-- A decision is made about a market of the active registry version: the
-- market whose Comet that version holds at that address on that chain,
-- whatever its status.

CREATE TRIGGER inactive_markets_require_active_market_insert
BEFORE INSERT ON inactive_markets
WHEN NOT EXISTS (
  SELECT 1
  FROM registry_state AS state
  JOIN registry_networks AS network
    ON network.registry_version_id = state.active_version_id
  JOIN markets AS market
    ON market.registry_version_id = state.active_version_id
   AND market.network_id = network.id
  JOIN market_contracts AS contract
    ON contract.market_id = market.id
   AND contract.role = 'comet'
  WHERE state.singleton_id = 1
    AND network.chain_id = NEW.chain_id
    AND contract.address = NEW.comet_address
)
BEGIN
  SELECT RAISE(ABORT, 'market is not in the active registry');
END;

CREATE TRIGGER inactive_markets_require_active_market_update
BEFORE UPDATE ON inactive_markets
WHEN NOT EXISTS (
  SELECT 1
  FROM registry_state AS state
  JOIN registry_networks AS network
    ON network.registry_version_id = state.active_version_id
  JOIN markets AS market
    ON market.registry_version_id = state.active_version_id
   AND market.network_id = network.id
  JOIN market_contracts AS contract
    ON contract.market_id = market.id
   AND contract.role = 'comet'
  WHERE state.singleton_id = 1
    AND network.chain_id = NEW.chain_id
    AND contract.address = NEW.comet_address
)
BEGIN
  SELECT RAISE(ABORT, 'market is not in the active registry');
END;

-- A decision row changes only beside the event that records the change: the
-- same market, the value it replaces, the value it sets, the actor, and the
-- time. The event must be the market's newest, which the writing
-- transaction's own event always is, so an older event that happens to
-- describe the same change cannot be reused to restore a row without
-- recording why. SQLite fires the insert trigger for an upsert that becomes
-- an update as well, before the update trigger, so the insert trigger reads
-- the value being replaced from the table rather than assuming there is none.

CREATE TRIGGER inactive_markets_require_event_insert
BEFORE INSERT ON inactive_markets
WHEN NOT EXISTS (
  SELECT 1
  FROM inactive_market_events AS event
  WHERE event.chain_id = NEW.chain_id
    AND event.comet_address = NEW.comet_address
    AND event.previous_is_inactive IS (
      SELECT decision.is_inactive
      FROM inactive_markets AS decision
      WHERE decision.chain_id = NEW.chain_id
        AND decision.comet_address = NEW.comet_address
    )
    AND event.is_inactive = NEW.is_inactive
    AND event.actor = NEW.updated_by
    AND event.created_at = NEW.updated_at
    AND NOT EXISTS (
      SELECT 1
      FROM inactive_market_events AS later
      WHERE later.chain_id = event.chain_id
        AND later.comet_address = event.comet_address
        AND later.rowid > event.rowid
    )
)
BEGIN
  SELECT RAISE(ABORT, 'an inactive market decision changes only with its audit event');
END;

CREATE TRIGGER inactive_markets_require_event_update
BEFORE UPDATE ON inactive_markets
WHEN NOT EXISTS (
  SELECT 1
  FROM inactive_market_events AS event
  WHERE event.chain_id = NEW.chain_id
    AND event.comet_address = NEW.comet_address
    AND event.previous_is_inactive IS OLD.is_inactive
    AND event.is_inactive = NEW.is_inactive
    AND event.actor = NEW.updated_by
    AND event.created_at = NEW.updated_at
    AND NOT EXISTS (
      SELECT 1
      FROM inactive_market_events AS later
      WHERE later.chain_id = event.chain_id
        AND later.comet_address = event.comet_address
        AND later.rowid > event.rowid
    )
)
BEGIN
  SELECT RAISE(ABORT, 'an inactive market decision changes only with its audit event');
END;

CREATE TRIGGER inactive_markets_identity_immutable
BEFORE UPDATE OF chain_id, comet_address ON inactive_markets
WHEN NEW.chain_id IS NOT OLD.chain_id
  OR NEW.comet_address IS NOT OLD.comet_address
BEGIN
  SELECT RAISE(ABORT, 'an inactive market decision belongs to one market');
END;

CREATE TRIGGER inactive_markets_no_delete
BEFORE DELETE ON inactive_markets
BEGIN
  SELECT RAISE(ABORT, 'inactive market decisions are changed, not deleted');
END;

CREATE TRIGGER inactive_market_events_no_update
BEFORE UPDATE ON inactive_market_events
BEGIN
  SELECT RAISE(ABORT, 'inactive market events are append-only');
END;

CREATE TRIGGER inactive_market_events_no_delete
BEFORE DELETE ON inactive_market_events
BEGIN
  SELECT RAISE(ABORT, 'inactive market events are append-only');
END;

-- REPLACE removes the row it conflicts with without firing a delete trigger,
-- since D1 runs with recursive_triggers off, so it is refused before it can:
-- whether it names an existing id or a rowid. Any rowid chosen by the writer
-- is refused, since history is read in rowid order; SQLite reports NEW.rowid
-- as -1 in a BEFORE INSERT trigger when it assigns the next one itself.
CREATE TRIGGER inactive_market_events_no_replace
BEFORE INSERT ON inactive_market_events
WHEN NEW.rowid <> -1
  OR EXISTS (SELECT 1 FROM inactive_market_events WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'inactive market events are append-only');
END;

-- A writer that names rowid -1 itself is the one case the trigger above cannot
-- tell from an assigned rowid. After the insert the real rowid is known, and
-- one the table did not assign — never below 1 — is refused, a REPLACE at
-- that rowid included.
CREATE TRIGGER inactive_market_events_assigned_rowid
AFTER INSERT ON inactive_market_events
WHEN NEW.rowid < 1
BEGIN
  SELECT RAISE(ABORT, 'inactive market events are append-only');
END;

-- What a write of decisions expects to hold once it is done. Inserting into
-- this view writes nothing: its triggers abort the transaction when a market
-- is not in the active registry version, or does not hold the decision
-- expected.

CREATE VIEW inactive_market_expectations AS
SELECT chain_id, comet_address, is_inactive FROM inactive_markets WHERE 0;

CREATE TRIGGER inactive_market_expectations_require_active_market
INSTEAD OF INSERT ON inactive_market_expectations
WHEN NOT EXISTS (
  SELECT 1
  FROM registry_state AS state
  JOIN registry_networks AS network
    ON network.registry_version_id = state.active_version_id
  JOIN markets AS market
    ON market.registry_version_id = state.active_version_id
   AND market.network_id = network.id
  JOIN market_contracts AS contract
    ON contract.market_id = market.id
   AND contract.role = 'comet'
  WHERE state.singleton_id = 1
    AND network.chain_id = NEW.chain_id
    AND contract.address = NEW.comet_address
)
BEGIN
  SELECT RAISE(ABORT, 'market is not in the active registry');
END;

CREATE TRIGGER inactive_market_expectations_require_decision
INSTEAD OF INSERT ON inactive_market_expectations
WHEN COALESCE((
  SELECT decision.is_inactive
  FROM inactive_markets AS decision
  WHERE decision.chain_id = NEW.chain_id
    AND decision.comet_address = NEW.comet_address
), 0) IS NOT NEW.is_inactive
BEGIN
  SELECT RAISE(ABORT, 'inactive market decisions changed while they were being written');
END;
