import { BigFixnum } from '../../lib/bigfixnum.js';

import type { Address, CollateralValueStatusV1, PriceExceptionV1 } from '../../lib/model/comet-registry.js';

import type { BlockRef, CollateralMinute, CollateralView, Position, PositionOutcome } from './token-collateral.js';
import { valueOf } from './token-collateral.js';

/*
 * One token's value from a view: this minute's complete value; or, with
 * decision D7 of the TOK-0 audit, the part of this minute that could be read,
 * when that part alone already reaches the threshold; or the newest complete
 * earlier minute; or nothing.
 *
 * A token without an enabled collateral position is worth exactly nothing,
 * whatever the node says, so its value never depends on the node answering.
 */
type CollateralValueStatus = CollateralValueStatusV1;

type TokenValue = {
  status:          CollateralValueStatus,
  valueUsd:        BigFixnum | null,
  block:           BlockRef | null,
  staleAgeSeconds: number | null,
  exceptions:      PriceExceptionV1[],
};

const ok = (outcome: PositionOutcome): outcome is Exclude<PositionOutcome, { status: 'error' }> => outcome.status !== 'error';

function sumOf(outcomes: Array<Exclude<PositionOutcome, { status: 'error' }>>): BigFixnum {
  return outcomes.reduce((sum, outcome) => sum.add(valueOf(outcome.valueUsd)), BigFixnum.from({ value: 0 }));
}

// an exception as a record and a version both name it: what it does, and to which feed
const exceptionKey = (exception: PriceExceptionV1) => `${exception.kind}:${exception.priceFeedAddress}`;

/*
 * Each exception once, however many positions of the token it priced, as the
 * answering version describes it rather than as the record does: a record is
 * shared by every version that values its positions the same way, and may
 * have been valued under one that described an exception otherwise. Each of
 * those versions holds every exception the record names.
 */
function exceptionsOf(outcomes: PositionOutcome[], described: ReadonlyMap<string, PriceExceptionV1>): PriceExceptionV1[] {
  const seen = new Map<string, PriceExceptionV1>();
  for (const outcome of outcomes) {
    if (outcome.status === 'exception') {
      for (const exception of outcome.exceptions) {
        const key = exceptionKey(exception);
        seen.set(key, described.get(key) ?? exception);
      }
    }
  }
  return [ ...seen.values() ];
}

function tokenValue(
  token: Address,
  view: CollateralView,
  positions: Position[],
  threshold: BigFixnum,
  now: Date,
): TokenValue {
  const held = positions.filter(position => position.token === token);
  const keys = new Set(held.map(position => position.key));
  if (keys.size === 0) {
    return { status: 'fresh', valueUsd: BigFixnum.from({ value: 0 }), block: view.block, staleAgeSeconds: 0, exceptions: [] };
  }
  const of = (record: CollateralMinute) => record.positions.filter(entry => keys.has(entry.key)).map(entry => entry.outcome);
  // the exceptions of the network as the answering version describes them, which its positions carry
  const described = new Map(held.flatMap(position => position.comet.registry.priceExceptions)
    .map(exception => [ exceptionKey(exception), exception ] as const));
  const exceptionsIn = (outcomes: PositionOutcome[]) => exceptionsOf(outcomes, described);

  if (view.current !== null) {
    const outcomes = of(view.current);
    const readable = outcomes.filter(ok);
    if (readable.length === outcomes.length) {
      const exceptions = exceptionsIn(outcomes);
      return {
        status:          exceptions.length === 0 ? 'fresh' : 'exception',
        valueUsd:        sumOf(readable),
        block:           view.current.block,
        staleAgeSeconds: 0,
        exceptions,
      };
    }
    // values are never negative, so what could be read is a lower bound of the whole
    const partial = sumOf(readable);
    if (partial.gte(threshold)) {
      return { status: 'partial', valueUsd: partial, block: view.current.block, staleAgeSeconds: 0, exceptions: exceptionsIn(readable) };
    }
  }

  for (const record of view.earlier) {
    const outcomes = of(record);
    const readable = outcomes.filter(ok);
    if (readable.length === outcomes.length) {
      const reference = view.block?.timestamp ?? Math.floor(now.getTime() / 1000);
      return {
        status:          'stale',
        valueUsd:        sumOf(readable),
        block:           record.block,
        staleAgeSeconds: Math.max(1, reference - record.block.timestamp),
        exceptions:      exceptionsIn(outcomes),
      };
    }
  }

  return { status: 'unavailable', valueUsd: null, block: null, staleAgeSeconds: null, exceptions: [] };
}

export type { TokenValue };
export { tokenValue };
