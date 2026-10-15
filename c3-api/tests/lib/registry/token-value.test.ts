import t from 'tap';

import { BigFixnum } from '../../../lib/bigfixnum.js';

import type { CollateralMinute, CollateralView } from '../../../src/registry/token-collateral.js';
import { tokenValue } from '../../../src/registry/token-value.js';

const NOW       = new Date('2026-10-05T12:00:30.000Z');
const MINUTE    = Math.floor(NOW.getTime() / 60_000);
const THRESHOLD = BigFixnum.from({ value: 250000 });

/*
 * A token's value from a view, by the rule: fresh or exception, then the D7
 * lower bound, then the newest complete earlier minute, then nothing.
 */
t.test('a token takes the newest value it can stand behind', async t => {
  const remap = { kind: 'deprecated_price_remap', priceFeedAddress: '0x0000000000000000000000000000000000000001', replacementPriceFeed: { address: '0x0000000000000000000000000000000000000002', decimals: 8 }, provenance: 'x', expiresAt: null };
  // two positions of one token, of a version whose network holds the remap
  const comet = { registry: { priceExceptions: [ remap ] } };
  const positions = [
    { key: 'a@1#0', token: '0x00000000000000000000000000000000000000aa', assetIndex: 0, comet },
    { key: 'b@1#0', token: '0x00000000000000000000000000000000000000aa', assetIndex: 0, comet },
  ] as any[];
  const TOKEN = '0x00000000000000000000000000000000000000aa';
  const block = (minute: number) => ({ number: minute, timestamp: minute * 60 });
  const usd = (value: string) => ({ status: 'success' as const, valueUsd: { value, decimals: 0 } });
  const record = (minute: number, outcomes: unknown[]): CollateralMinute => ({
    chainId: 1, minute, positionSet: 'x', block: block(minute),
    positions: positions.map((position, index) => ({ key: position.key, token: TOKEN, outcome: outcomes[index] as any })),
  });
  const valueOf = (view: CollateralView) => tokenValue(TOKEN, view, positions, THRESHOLD, NOW);
  const reverted = { status: 'error', reason: 'price_reverted' };

  const fresh = valueOf({ block: block(100), current: record(100, [ usd('100000'), usd('150000') ]), earlier: [] });
  t.same([ fresh.status, fresh.valueUsd?.toString(), fresh.staleAgeSeconds ], [ 'fresh', '250000', 0 ], 'complete now is fresh');

  const excepted = valueOf({ block: block(100), current: record(100, [
    { status: 'exception', valueUsd: { value: '1', decimals: 0 }, exceptions: [ remap ] },
    { status: 'exception', valueUsd: { value: '1', decimals: 0 }, exceptions: [ remap ] },
  ]), earlier: [] });
  t.same([ excepted.status, excepted.exceptions.length ], [ 'exception', 1 ], 'an exception is named once, whatever it priced');

  const partial = valueOf({ block: block(100), current: record(100, [ usd('300000'), reverted ]), earlier: [ record(99, [ usd('1'), usd('1') ]) ] });
  t.same([ partial.status, partial.valueUsd?.toString() ], [ 'partial', '300000' ], 'what was read already reaching the threshold proves it (D7)');
  const partialExcepted = valueOf({ block: block(100), current: record(100, [
    { status: 'exception', valueUsd: { value: '300000', decimals: 0 }, exceptions: [ remap ] },
    reverted,
  ]), earlier: [] });
  t.same([ partialExcepted.status, partialExcepted.exceptions ], [ 'partial', [ remap ] ], 'and names the exceptions of what it read');

  const stale = valueOf({ block: block(100), current: record(100, [ usd('1'), reverted ]), earlier: [ record(97, [ usd('2'), usd('3') ]) ] });
  t.same([ stale.status, stale.valueUsd?.toString(), stale.staleAgeSeconds, stale.block ], [ 'stale', '5', 180, block(97) ],
    'below the threshold, the newest complete minute answers, and says how old it is');
  const staleExcepted = valueOf({ block: block(100), current: null, earlier: [ record(97, [
    { status: 'exception', valueUsd: { value: '2', decimals: 0 }, exceptions: [ remap ] },
    usd('3'),
  ]) ] });
  t.same([ staleExcepted.status, staleExcepted.exceptions ], [ 'stale', [ remap ] ], 'with the exceptions that minute applied');

  // without the latest block a value is aged by the clock, which a block of the clock's own minute may be ahead of
  const clock = Math.floor(NOW.getTime() / 1000);
  const blind = valueOf({ block: null, current: null, earlier: [ record(MINUTE - 2, [ usd('2'), usd('3') ]) ] });
  t.same([ blind.status, blind.staleAgeSeconds ], [ 'stale', 150 ],
    'without the latest block, the newest complete minute is as old as the clock says: from 11:58:00 to 12:00:30');
  const ahead = valueOf({ block: null, current: null, earlier: [ { ...record(MINUTE, [ usd('2'), usd('3') ]), block: { number: MINUTE, timestamp: clock + 5 } } ] });
  t.same([ ahead.status, ahead.staleAgeSeconds ], [ 'stale', 1 ], 'and at least a second old, though its block is ahead of the clock');

  /*
   * Why an exception was added and until when it applies change no value, so
   * a record is shared by versions that differ only in them: each answers
   * with its own description, whichever valued the minute.
   */
  const redescribed = { ...remap, provenance: 'y', expiresAt: '2999-01-01T00:00:00.000Z' };
  const answering   = positions.map(position => ({ ...position, comet: { registry: { priceExceptions: [ redescribed ] } } }));
  const remapped    = { status: 'exception', valueUsd: { value: '1', decimals: 0 }, exceptions: [ remap ] };
  t.same(tokenValue(TOKEN, { block: block(100), current: record(100, [ remapped, remapped ]), earlier: [] }, answering, THRESHOLD, NOW).exceptions,
    [ redescribed ], 'an exception of this minute is described as the version answering describes it');
  t.same(tokenValue(TOKEN, { block: block(100), current: null, earlier: [ record(97, [ remapped, usd('3') ]) ] }, answering, THRESHOLD, NOW).exceptions,
    [ redescribed ], 'and so is one of an earlier minute');

  const unavailable = valueOf({ block: null, current: null, earlier: [ record(97, [ usd('1'), reverted ]) ] });
  t.same([ unavailable.status, unavailable.valueUsd, unavailable.block ], [ 'unavailable', null, null ],
    'an earlier minute that could not value it either is not an answer');

  const absent = tokenValue('0x00000000000000000000000000000000000000bb', { block: null, current: null, earlier: [] }, positions, THRESHOLD, NOW);
  t.same([ absent.status, absent.valueUsd?.toString() ], [ 'fresh', '0' ],
    'a token without a collateral position is worth nothing, whether or not the node answers');
});
