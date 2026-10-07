import t, { Test } from 'tap';

import { randomUUID } from 'node:crypto';

import C3Api, { Env } from '../../entrypoint.js';

import { MemoryKv } from '../util/kv.js';
import { activeRegistryDatabase } from '../util/registry-database.js';
import { makeTestEnv } from '../util/test-env.js';

import '../../shim/node-self.js';

/*
 * Testnets are not served. The registry imports mainnets alone, so every
 * route that takes a network or a chain from the request answers one that
 * names a testnet with the same refusal — 400 TESTNET_NOT_SERVED in the error
 * envelope, naming what named it — instead of nothing, mainnet data, or a
 * message about something else. It is refused before anything is read from
 * the registry or the chain. The same route with a mainnet goes on as
 * before: here, where no node answers, as far as asking the node.
 */
const ACCOUNT    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const USDC       = '0xc3d688b66703497daa19211eedff47f25384cdc3';
// the Sepolia markets webb3-frontend's hidden transaction history mode names
const SEPOLIA    = [ '11155111_0x2943ac1216979aD8dB76D9147F64E61adc126e96', '11155111_0xAec1F48e02Cfb822Be958B68C7957156EB3F0b6e' ];
const SEPOLIA_RW = '0x8bf5b658bdf0388e8b482ed51b14aef58f90abfd';

type Envelope = { error: { code: string, message: string, requestId: string } };

/*
 * Cursors as the history issued them before the registry, keyed by network:
 * one a request for the Sepolia markets started, and one a request for every
 * market did.
 */
function legacyCursor(network: string, markets: string[], comets: string[], rewards: string) {
  const stream = { network, marketContractAddresses: comets, rewardsContractAddress: rewards };
  return {
    profilesByAddress: {},
    filter: {
      markets,
      actions:           [],
      initiatedBy:       [],
      contractAddresses: [ ...comets, rewards ],
      networks:          [ network ],
    },
    streamEvents: [ stream ],
    cursors:      { [network]: { ...stream, blockNumber: 1, transactionHash: '0x0' } },
  };
}

const CURSORS = {
  'legacy-sepolia': legacyCursor('ethereum-sepolia', SEPOLIA, SEPOLIA.map(market => market.split('_')[1]!), SEPOLIA_RW),
  'legacy-mainnet': legacyCursor('ethereum-mainnet', [], [ USDC ], '0x1b0e765f6224c21223aea2af16c1c46e38885a40'),
};

/*
 * A node that never answers, and remembers being asked, for the whole file.
 * It stays in place from one test to the next: a route can answer before
 * every evaluation it started has ended — /account/{address}/rewards answers
 * once one network has failed — and what is left goes on asking the node
 * after its test is over. Each harness asks it under a key of its own, so it
 * counts what it asked, and nothing a test before it left running.
 */
const requests: string[] = [];
const fetchBefore        = globalThis.fetch;
const consoleBefore      = { error: console.error, warn: console.warn, log: console.log };

t.before(() => {
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    requests.push(new Request(input, init).url);
    throw new TypeError('fetch failed');
  }) as unknown as typeof globalThis.fetch;
  // the worker logs every request the node fails
  console.error = console.warn = console.log = () => {};
});
t.teardown(() => {
  globalThis.fetch = fetchBefore;
  Object.assign(console, consoleBefore);
});

// a registry with the fixture on — or, with `activate: false`, with nothing on
async function registryOf(t: Test, options: { activate?: boolean } = {}): Promise<D1Database> {
  const registry = await activeRegistryDatabase(options);
  t.teardown(() => registry.dispose());
  return registry.db;
}

// a database whose every statement fails as `message` says
function failing(message: string): D1Database {
  const fail = () => { throw new Error(message); };
  return { prepare: fail, batch: fail, exec: fail, dump: fail } as unknown as D1Database;
}

// the worker over `db`, the registry fixture unless a test says otherwise, asking the node under a key of its own
async function harness(t: Test, db?: D1Database): Promise<{ get: (path: string) => Promise<Response>, asked: () => number }> {
  const key = randomUUID();
  const env: Env = makeTestEnv({
    DEBUG:             '',
    MEMORY_CACHE_SEED: 'testnets',
    APP_DB:            db ?? await registryOf(t),
    NODE_PROXY_KEY:    key,
    kv_mainnet:        MemoryKv({ seed: CURSORS }),
  });
  return {
    get:   path => C3Api.fetch(new Request(`https://api.test.local${path}`), env),
    asked: () => requests.filter(url => url.endsWith(`/${key}`)).length,
  };
}

async function refuses(t: Test, response: Response, named: string, what: string): Promise<void> {
  t.equal(response.status, 400, `${what} is refused`);
  t.match(response.headers.get('content-type'), /^application\/json/, 'as JSON');
  const { error } = await response.json() as Envelope;
  t.same([ error.code, error.message ], [ 'TESTNET_NOT_SERVED', `testnets are not served: ${named}` ],
    `in the envelope, naming ${named}`);
  t.match(error.requestId, /^[0-9a-f-]{36}$/, 'under a request id');
}

t.test('a market route that names a testnet is refused', async t => {
  const { get, asked } = await harness(t);

  for (const [ path, named ] of [
    [ '/market/sepolia/all/summary', 'ethereum-sepolia' ],
    [ '/market/ethereum-sepolia/0x2943ac1216979aD8dB76D9147F64E61adc126e96/summary', 'ethereum-sepolia' ],
    [ '/market/polygon-mumbai/all/historical/summary', 'polygon-mumbai' ],
    [ '/market/base-sepolia/0x61490650AbaA31393464C3f34E8B29cd1C44118E/rewards/summary', 'base-sepolia' ],
    [ '/market/arbitrum-goerli/all/rewards/dapp-data', 'arbitrum-goerli' ],
  ] as const) {
    await refuses(t, await get(path), named, path);
  }
  t.equal(asked(), 0, 'before the chain is asked anything');

  const mainnet = await get(`/market/ethereum-mainnet/${USDC}/summary`);
  t.not(mainnet.status, 400, 'the same route with a mainnet is not refused');
  t.ok(asked() > 0, 'and goes on to ask the node, as before');
});

t.test('a route over every network that asks for testnets is refused', async t => {
  const { get, asked } = await harness(t);

  for (const path of [
    '/market/all-networks/all-contracts/summary?testnets=include',
    '/market/all-networks/all-contracts/historical/summary?testnets=include',
    '/market/all-networks/all-contracts/rewards/dapp-data?testnets=include',
    `/account/${ACCOUNT}/rewards?testnets=include`,
  ]) {
    await refuses(t, await get(path), 'testnets=include', path);
  }
  t.equal(asked(), 0, 'before the chain is asked anything');

  for (const path of [ '/market/all-networks/all-contracts/summary', `/account/${ACCOUNT}/rewards?testnets=exclude` ]) {
    const before   = asked();
    const response = await get(path);
    t.not(response.status, 400, `${path} is not refused`);
    t.ok(asked() > before, 'and asks the node for the mainnets, as before');
  }
});

t.test('a transaction history that names a testnet market, or a cursor that reads one, is refused', async t => {
  const { get, asked } = await harness(t);
  const history = `/account/${ACCOUNT}/transaction_history`;

  await refuses(t, await get(`${history}?markets[]=${SEPOLIA.join(',')}`), 'ethereum-sepolia', 'a Sepolia market');
  await refuses(t, await get(`${history}?markets[]=1_${USDC},${SEPOLIA[0]}`), 'ethereum-sepolia', 'a Sepolia market beside a mainnet one');
  await refuses(t, await get(`${history}?cursor=legacy-sepolia&markets[]=${SEPOLIA.join(',')}`), 'ethereum-sepolia',
    'a Sepolia cursor sent with its filter');
  await refuses(t, await get(`${history}?cursor=legacy-sepolia`), 'ethereum-sepolia', 'and sent without it');
  t.equal(asked(), 0, 'before the chain is asked anything');

  /*
   * The same requests for mainnet markets go on to the checks that came after
   * this one, and are answered as they were; reading a history from a node
   * that does not answer is the network tests' to show.
   */
  const unknown = `0x${'9'.repeat(40)}`;
  const market  = await get(`${history}?markets[]=1_${unknown}`);
  t.same([ market.status, await market.text() ], [ 400, `Invalid market address ${unknown}` ],
    'a mainnet market the registry does not serve is refused for that, as before');
  const cursor = await get(`${history}?cursor=legacy-mainnet&markets[]=1_${USDC}`);
  t.same([ cursor.status, await cursor.text() ], [ 400, 'Cursor is having different markets filter' ],
    'and a mainnet cursor sent with another filter for that');
});

/*
 * A testnet is refused before the registry is read, on every route: the
 * registry has none to answer with, so whether a version is on, and whether
 * the database answers at all, changes nothing about the answer.
 */
t.test('a testnet is refused while no version is on, and while the database does not answer', async t => {
  const history = `/account/${ACCOUNT}/transaction_history`;

  for (const [ db, state ] of [
    [ await registryOf(t, { activate: false }), 'no version is on' ],
    [ failing('D1_ERROR: Network connection lost.'), 'the database does not answer' ],
  ] as const) {
    const { get, asked } = await harness(t, db);
    for (const [ path, named ] of [
      [ '/market/sepolia/all/summary', 'ethereum-sepolia' ],
      [ '/market/all-networks/all-contracts/summary?testnets=include', 'testnets=include' ],
      [ `/account/${ACCOUNT}/rewards?testnets=include`, 'testnets=include' ],
      [ `${history}?markets[]=${SEPOLIA[0]}`, 'ethereum-sepolia' ],
      [ `${history}?cursor=legacy-sepolia`, 'ethereum-sepolia' ],
    ] as const) {
      await refuses(t, await get(path), named, `${path} while ${state}`);
    }
    t.equal(asked(), 0, 'before the chain is asked anything');

    const mainnet = await get(`${history}?markets[]=1_${USDC}`);
    t.equal(mainnet.status, 503, `while ${state}, the history of a mainnet market is what cannot be answered`);
  }
});
