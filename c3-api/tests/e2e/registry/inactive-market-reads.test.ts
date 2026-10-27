import t from 'tap';

import C3Api, { Env } from '../../../entrypoint.js';
import type { Address } from '../../../lib/model/comet-registry.js';
import {
  DEPRECATED_KEY,
  DEPRECATED_RECORD,
  HIDDEN_KEY,
  HIDDEN_RECORD,
  markedDecisions,
  recordCollaterals,
} from '../../../src/registry/collateral-decisions.js';
import { INACTIVE_KEY, INACTIVE_RECORD } from '../../../src/registry/inactive-markets.js';

import { executionContext, settledWithin } from '../../util/execution-context.js';
import { MemoryKv } from '../../util/kv.js';
import { quietLog } from '../../util/quiet-log.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';
import { ADMIN_TOKEN, failingStatements } from '../../util/test-env.js';

import { DEPRECATED_READS, HIDDEN_READS, bindingOf, captureLogs, depsOf, envOf, fixture, get } from './collateral-read-scenarios.js';
import { INACTIVE_MARKETS, statementsOf } from './decision-scenarios.js';

import '../../../shim/node-self.js';

/*
 * The record the Worker keeps of the inactive markets, for an outage to
 * answer /summary with (inactive-markets.ts), through the worker's own entry
 * point and the record's own functions in Node: every command that decides
 * records them once it has committed, and before it answers; a read takes
 * them from D1, keeps the record in step, and while D1 cannot be reached
 * answers with the record, saying so; and each kind's record is its own, in
 * the bytes another release reads it by. What /summary answers with them is
 * ../market/summary-tokens.test.ts's.
 *
 * How a record is kept in step under load and races is the deprecated kind's
 * to test (deprecated-collateral-reads.test.ts): every kind keeps its record
 * by the same code (collateral-decisions.ts), the inactive markets too; what
 * tells one set of inactive markets from another, and so whether a record
 * holds them, is their own (inactive-markets.ts), which the second test
 * holds. And no public read of /registry/v1 carries an inactive market, which
 * the last tests hold: none of them reads the decisions, or needs their
 * tables.
 */
const mainnet = loadRegistrySnapshotFixture().networks.find(network => network.chainId === 1)!;
const cometOf = (key: string) => mainnet.markets.find(market => market.deploymentKey === key)!.contracts.comet!;

const USDT = cometOf('usdt');
const WBTC = cometOf('wbtc');

const decide = (db: D1Database, cometAddress: Address, flag: boolean) => INACTIVE_MARKETS.set(db, {
  subject: { cometAddress },
  flag,
  actor:   'test',
  reason:  'decided for an inactive market read test',
});

function command(method: string, path: string, body: unknown): Request {
  return new Request(`https://api.test.local${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

async function recorded(kv: KVNamespace): Promise<unknown[] | null> {
  return (await kv.get(INACTIVE_KEY, 'json') as { markets: unknown[] } | null)?.markets ?? null;
}

/*
 * A command does not leave its record to waitUntil, as a read leaves its
 * check: it answers once the record holds what it committed, so an outage
 * right after it answers /summary with its decision. Each command comes
 * through the worker with an execution context, as in production. The
 * records of the decisions about collaterals hold what no decision in force
 * says, so a command that wrote them, or took them away, would be seen to.
 * An environment without a fallback window answers nothing from a record, so
 * its commands keep none.
 */
t.test('a command answers once the record holds the inactive markets, though it has a waitUntil to leave them to', async t => {
  const { registry } = await fixture(t);
  const deprecated = JSON.stringify({ at: '2026-10-01T00:00:00.000Z', collaterals: [] });
  const hidden     = JSON.stringify({ at: '2026-10-02T00:00:00.000Z', collaterals: [] });
  const commands = [
    [ 'PATCH', INACTIVE_MARKETS.path(1, { cometAddress: USDT }), { isInactive: true, reason: 'decided by a command' },
      [ { chainId: 1, cometAddress: USDT } ] ],
    [ 'POST', INACTIVE_MARKETS.list.apply, { reason: 'decided by a list', inactiveMarkets: [ { chainId: 1, cometAddress: WBTC, isInactive: true } ] },
      [ { chainId: 1, cometAddress: USDT }, { chainId: 1, cometAddress: WBTC } ] ],
  ] as const;

  for (const [ method, path, body, markets ] of commands) {
    const store = MemoryKv({});
    await store.put(DEPRECATED_KEY, deprecated);
    await store.put(HIDDEN_KEY, hidden);
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const env = await envOf(registry.db, bindingOf(store, { put: async (_parameters, write) => { await released; await write(); } }));
    const { context, handed } = executionContext();
    const answer = C3Api.fetch(command(method, path, body), env, context);
    t.notOk(await settledWithin(answer, 300), `${method} ${path} does not answer while the namespace holds the write of the record`);
    t.equal(handed.length, 0, 'and hands nothing to waitUntil');
    release();
    t.equal((await answer).status, 200, 'it answers once the record is written');
    t.same(await recorded(store), markets, 'with the inactive markets in force once it committed, every chain\'s');
    t.same([ await store.get(DEPRECATED_KEY), await store.get(HIDDEN_KEY) ], [ deprecated, hidden ],
      'and leaves the records of the decisions about collaterals byte for byte as they were');
  }

  const windowless = MemoryKv({});
  const reversed = await C3Api.fetch(command('PATCH', INACTIVE_MARKETS.path(1, { cometAddress: USDT }), { isInactive: false, reason: 'taken back by a command' }),
    await envOf(registry.db, windowless, { REGISTRY_STALE_FALLBACK_MAX_S: '0' }));
  t.equal(reversed.status, 200, 'a command without a fallback window commits');
  t.equal(await windowless.get(INACTIVE_KEY), null, 'and records nothing');
});

/*
 * A read, as /summary makes one on every request, hands its check of the
 * record to the request's waitUntil, as the reads of the other kinds do, and
 * answers without waiting for it. The check puts right a record that holds
 * other decisions, as a write KV refused or a read that raced a decision
 * leaves one: the same Comet on another chain is another market.
 */
t.test('a read takes the inactive markets from the database, and from the record while it cannot be reached', async t => {
  const { registry } = await fixture(t);
  const warnings: unknown[] = [];
  const kv   = MemoryKv({});
  const usdt = { chainId: 1, cometAddress: USDT };
  const unavailable = { name: 'RegistryUnavailable', message: 'the inactive market decisions could not be read' };
  await decide(registry.db, USDT, true);

  const handed: Array<Promise<unknown>> = [];
  const read = await markedDecisions(INACTIVE_RECORD, { ...depsOf(registry.db, kv, warnings), defer: work => { handed.push(work); } });
  t.same([ read.recorded, read.decisions.markets ], [ false, [ usdt ] ], 'a read takes the decisions from the database');
  t.equal(handed.length, 1, 'and hands the check of the record to waitUntil');
  await Promise.all(handed);
  t.same(await recorded(kv), [ usdt ], 'which records them');
  const otherChain = MemoryKv({ seed: { [INACTIVE_KEY]: { at: '2026-10-27T09:00:00.000Z', markets: [ { ...usdt, chainId: 8453 } ] } } });
  const checked: Array<Promise<unknown>> = [];
  await markedDecisions(INACTIVE_RECORD, { ...depsOf(registry.db, otherChain), defer: work => { checked.push(work); } });
  await Promise.all(checked);
  t.same(await recorded(otherChain), [ usdt ], 'and puts right a record of other decisions, though it names the same Comet on another chain');

  const unreachable = failingStatements(registry.db, statementsOf(INACTIVE_MARKETS));
  const fallback = await markedDecisions(INACTIVE_RECORD, depsOf(unreachable, kv, warnings));
  t.same([ fallback.recorded, fallback.decisions.markets ], [ true, [ usdt ] ],
    'while the database does not give them, a read answers with the record, and says so');
  t.ok(fallback.decisions.has(usdt), 'which marks the market on its own chain');
  t.notOk(fallback.decisions.has({ ...usdt, chainId: 8453 }), 'and not the same Comet on another');
  await markedDecisions(INACTIVE_RECORD, depsOf(unreachable, kv, warnings));
  t.same(warnings, [ 'inactive market decisions unreadable; answering with the ones last recorded' ],
    'which the log says once a minute, not once a request');

  await t.rejects(markedDecisions(INACTIVE_RECORD, depsOf(unreachable, MemoryKv({}))), unavailable,
    'with nothing recorded, there is nothing to answer with');
  const garbled = [
    { at: '2026-10-27T09:00:00.000Z', markets: 'not a list' },
    { markets: [ usdt ] },
    { at: '2026-10-27T09:00:00.000Z', markets: [ { ...usdt, chainId: 0 } ] },
    { at: '2026-10-27T09:00:00.000Z', markets: [ { ...usdt, cometAddress: 'usdt' } ] },
  ];
  for (const record of garbled) {
    await t.rejects(markedDecisions(INACTIVE_RECORD, depsOf(unreachable, MemoryKv({ seed: { [INACTIVE_KEY]: record } }))), unavailable,
      `nor with a record that is not one: ${JSON.stringify(record)}`);
  }
  const checksummed = MemoryKv({ seed: { [INACTIVE_KEY]: { at: '2026-10-27T09:00:00.000Z', markets: [ { ...usdt, cometAddress: USDT.toUpperCase().replace('0X', '0x') } ] } } });
  t.same((await markedDecisions(INACTIVE_RECORD, depsOf(unreachable, checksummed))).decisions.markets, [ usdt ],
    'while a record that names a Comet in another case names the same market');

  const windowless = { ...depsOf(registry.db, MemoryKv({})), staleSeconds: 0 };
  await markedDecisions(INACTIVE_RECORD, windowless);
  t.equal(await windowless.kv.get(INACTIVE_KEY), null, 'without a window, a read records nothing');
  await t.rejects(
    markedDecisions(INACTIVE_RECORD, { ...windowless, db: unreachable }),
    { name: 'RegistryUnavailable', message: 'the comet registry could not be read' },
    'and decisions the database does not give are unavailable there',
  );
});

/*
 * Each kind keeps a record of its own, and what an isolate knows of one says
 * nothing of another: a command of one kind writes its own record alone, and
 * leaves the others byte for byte as they were.
 */
t.test('the inactive markets and the decisions about collaterals are recorded apart', async t => {
  const { registry, collateral, decide: decideCollateral } = await fixture(t);
  const kv   = MemoryKv({});
  const deps = depsOf(registry.db, kv);

  await markedDecisions(INACTIVE_RECORD, deps);
  await markedDecisions(DEPRECATED_RECORD, deps);
  await markedDecisions(HIDDEN_RECORD, deps);
  t.same(await recorded(kv), [], 'a read of each kind, none decided, writes each record');

  const collaterals = [ await kv.get(DEPRECATED_KEY), await kv.get(HIDDEN_KEY) ];
  await decide(registry.db, USDT, true);
  await recordCollaterals(INACTIVE_RECORD, deps);
  t.same(await recorded(kv), [ { chainId: 1, cometAddress: USDT } ], 'a market command records the inactive markets');
  t.same([ await kv.get(DEPRECATED_KEY), await kv.get(HIDDEN_KEY) ], collaterals,
    'and leaves the records of the decisions about collaterals byte for byte as they were');

  const markets = await kv.get(INACTIVE_KEY);
  await decideCollateral(DEPRECATED_READS, 'usdc', 'weETH', true);
  await recordCollaterals(DEPRECATED_RECORD, deps);
  await decideCollateral(HIDDEN_READS, 'wbtc', 'LBTC', true);
  await recordCollaterals(HIDDEN_RECORD, deps);
  t.same((await markedDecisions(DEPRECATED_RECORD, deps)).decisions.collaterals, [ collateral('usdc', 'weETH') ], 'while the collateral commands record their own');
  t.equal(await kv.get(INACTIVE_KEY), markets, 'and leave the record of the inactive markets byte for byte as it was');
  t.same((await markedDecisions(INACTIVE_RECORD, deps)).decisions.markets, [ { chainId: 1, cometAddress: USDT } ], 'whose decisions are their own');
});

/*
 * The bytes each record is written as, for the decisions a database gives,
 * in the order it gives them, at a fixed time: a record outlives the release
 * that wrote it, and the one after reads it. The deprecated and the hidden
 * records are held to the strings the release before this one (2164ffd)
 * writes for the same decisions, so that taking a market kind into the
 * record machinery changed none of their bytes; the record of the inactive
 * markets is {at, markets}, each market by its chain and its Comet.
 */
t.test('each kind writes its record in the bytes it always has, the inactive markets theirs', async t => {
  const comet = '0x3afdc9bca9213a35503b077a6072f3d0d5ab0840';
  const rows  = (sql: string) => (
      sql.includes('deprecated_collaterals') ? [
        { chain_id: 1, comet_address: comet, token_address: '0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa' },
        { chain_id: 1, comet_address: comet, token_address: '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee' },
      ]
    : sql.includes('inactive_markets') ? [
        { chain_id: 534352, comet_address: '0xb2f97c1bd3bf02f5e74d13f02e3e26f93d77ce44' },
        { chain_id: 137,    comet_address: '0xf25212e676d1f7f89cd72ffee66158f541246445' },
      ]
    : []
  );
  const db = { prepare: (sql: string) => ({ all: async () => ({ results: rows(sql) }) }) } as unknown as D1Database;
  const kv = MemoryKv({});
  const deps = { db, kv, ttlSeconds: 300, staleSeconds: 3600, debug: quietLog, now: () => new Date('2026-10-27T09:00:00.000Z') };

  await recordCollaterals(DEPRECATED_RECORD, deps);
  await recordCollaterals(HIDDEN_RECORD, deps);
  await recordCollaterals(INACTIVE_RECORD, deps);
  t.equal(await kv.get(DEPRECATED_KEY),
    '{"at":"2026-10-27T09:00:00.000Z","collaterals":[{"chainId":1,"cometAddress":"0x3afdc9bca9213a35503b077a6072f3d0d5ab0840","tokenAddress":"0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa"},{"chainId":1,"cometAddress":"0x3afdc9bca9213a35503b077a6072f3d0d5ab0840","tokenAddress":"0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee"}]}',
    'the deprecated collaterals, as 2164ffd writes them');
  t.equal(await kv.get(HIDDEN_KEY), '{"at":"2026-10-27T09:00:00.000Z","collaterals":[]}',
    'the hidden ones, none, as 2164ffd writes them');
  t.equal(await kv.get(INACTIVE_KEY),
    '{"at":"2026-10-27T09:00:00.000Z","markets":[{"chainId":534352,"cometAddress":"0xb2f97c1bd3bf02f5e74d13f02e3e26f93d77ce44"},{"chainId":137,"cometAddress":"0xf25212e676d1f7f89cd72ffee66158f541246445"}]}',
    'and the inactive markets, each by its chain and its Comet');
});

/*
 * The public reads of /registry/v1 carry no inactive market: a decision
 * changes none of their answers or their tags, and they neither read the
 * decisions nor record them, so they answer as before, confirmed, while D1
 * cannot give them, and on a database without their tables. Only the
 * inactive market routes under /registry/v1/admin/ answer the decisions.
 */
t.test('a market decision changes nothing the public reads of /registry/v1 answer, and they need none of the inactive markets', async t => {
  const { registry } = await fixture(t);
  captureLogs(t);
  const kv    = MemoryKv({});
  const paths = [ '/registry/v1/active', '/registry/v1/networks/1/markets', `/registry/v1/networks/1/markets/${USDT}` ];
  const answers = async (env: Env) => await Promise.all(paths.map(async path => {
    const response = await get(env, path);
    return [ path, response.status, response.headers.get('etag'), response.headers.get('x-registry-stale'), await response.text() ];
  }));

  const before = await answers(await envOf(registry.db, kv));
  t.ok(before.every(([ , status, , stale ]) => status === 200 && stale === null), 'every read answers, confirmed');
  await decide(registry.db, USDT, true);
  t.same(await answers(await envOf(registry.db, kv)), before, 'and answers the same bytes under the same tag once USDT\'s market is marked inactive');
  t.same(await answers(await envOf(failingStatements(registry.db, statementsOf(INACTIVE_MARKETS)), kv)), before,
    'and while the database does not give the inactive markets, confirmed all the same');
  t.equal(await kv.get(INACTIVE_KEY), null, 'having recorded none of them');

  const unmigrated = await activeRegistryDatabase({ through: '0008' });
  t.teardown(() => unmigrated.dispose());
  const early = await envOf(unmigrated.db, MemoryKv({}));
  for (const path of paths) {
    t.equal((await get(early, path)).status, 200, `${path} answers on a database without migration 0009`);
  }
});
