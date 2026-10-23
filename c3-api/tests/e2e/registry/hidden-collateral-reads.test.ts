import t from 'tap';

import {
  DEPRECATED_KEY,
  DEPRECATED_RECORD,
  HIDDEN_KEY,
  HIDDEN_RECORD,
  markedDecisions,
  recordCollaterals,
} from '../../../src/registry/collateral-decisions.js';

import { MemoryKv } from '../../util/kv.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { failingStatements } from '../../util/test-env.js';

import {
  DEPRECATED_READS,
  HIDDEN_READS,
  captureLogs,
  decisionReadScenarios,
  depsOf,
  envOf,
  fixture,
  get,
  recorded,
} from './collateral-read-scenarios.js';
import { DEPRECATED_COLLATERALS, HIDDEN_COLLATERALS, statementsOf } from './decision-scenarios.js';

import '../../../shim/node-self.js';

/*
 * What the active reads answer about hidden collaterals, through the
 * worker's own entry point: what they answer for every kind of decision
 * about a collateral is in collateral-read-scenarios.ts, run here for hidden
 * collaterals. How a record is kept in step under load and races is the
 * deprecated kind's to test (deprecated-collateral-reads.test.ts): the two
 * kinds keep their records by the same code. Beside them, what the hidden
 * kind is to the deprecated one: each keeps a record of its own, and a read
 * that can take neither kind's decisions fails for one of them.
 */
decisionReadScenarios(HIDDEN_READS);

type Envelope = { error: { code: string, message: string } };

/*
 * Each kind keeps a record of its own, and what an isolate knows of one says
 * nothing of the other: the record of one kind's decisions, the same as the
 * other's as none are made, is no reason to leave the other's unwritten.
 */
t.test('the hidden and the deprecated decisions are recorded apart', async t => {
  const { registry, collateral, decide } = await fixture(t);
  const kv   = MemoryKv({});
  const deps = depsOf(registry.db, kv);

  await markedDecisions(HIDDEN_RECORD, deps);
  await markedDecisions(DEPRECATED_RECORD, deps);
  t.same([ await recorded(kv, HIDDEN_KEY), await recorded(kv, DEPRECATED_KEY) ], [ [], [] ],
    'a read of each kind, neither decided, writes each record');

  const mEth = collateral('usdt', 'mETH');
  await decide(HIDDEN_READS, 'usdt', 'mETH', true);
  await decide(DEPRECATED_READS, 'usdc', 'weETH', true);
  await recordCollaterals(HIDDEN_RECORD, deps);
  t.same([ await recorded(kv, HIDDEN_KEY), await recorded(kv, DEPRECATED_KEY) ], [ [ mEth ], [] ],
    'a hidden command records the hidden decisions alone');
  t.same((await markedDecisions(DEPRECATED_RECORD, deps)).decisions.collaterals, [ collateral('usdc', 'weETH') ],
    'while the deprecated ones are their own');
  t.same((await markedDecisions(HIDDEN_RECORD, deps)).decisions.collaterals, [ mEth ], 'as the hidden ones are');
});

/*
 * The active reads mark every collateral with both kinds or answer nothing
 * (collateral-decisions.ts, readMarks), and an answer refused for want of
 * both is the same 503 whichever kind it names. It names the deprecated
 * one, which is what its log line puts the request's failure down to.
 */
t.test('a read that can take neither kind of decision fails for want of the deprecated ones', async t => {
  const { registry } = await fixture(t);
  const logs    = captureLogs(t);
  const neither = failingStatements(failingStatements(registry.db, statementsOf(DEPRECATED_COLLATERALS)), statementsOf(HIDDEN_COLLATERALS));

  const unread = await get(await envOf(neither, MemoryKv({})), '/registry/v1/active');
  t.same([ unread.status, (await unread.json() as Envelope).error.code ], [ 503, 'UPSTREAM_UNAVAILABLE' ],
    'neither kind given by the database, nor recorded, is a 503');
  t.ok(logs.some(line => line.includes('RegistryUnavailable: the deprecated collateral decisions could not be read')),
    'which the log puts down to the deprecated decisions');
  t.notOk(logs.some(line => line.includes('hidden collateral decisions')), 'and not to the hidden ones');

  logs.length = 0;
  const unmigrated = await activeRegistryDatabase({ through: '0005' });
  t.teardown(() => unmigrated.dispose());
  const early = await get(await envOf(unmigrated.db, MemoryKv({})), '/registry/v1/active');
  t.same([ early.status, (await early.json() as Envelope).error.code ], [ 503, 'UPSTREAM_UNAVAILABLE' ],
    'and so is a database migrated before either kind\'s tables');
  t.ok(logs.some(line => line.includes('no such table: deprecated_collaterals')), 'which the log puts down to the deprecated table');
  t.notOk(logs.some(line => line.includes('no such table: hidden_collaterals')), 'and not to the hidden one');
});
