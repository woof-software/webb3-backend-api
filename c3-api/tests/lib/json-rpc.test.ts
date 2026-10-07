import t from 'tap';
import * as Fallible from '../../lib/fallible/fallible.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../shim/node-self.js';

import * as JsonRpc from '../../lib/json-rpc/json-rpc.js';
let jsonRpc = JsonRpc;

import * as mock from '../util/mock/mock.js';
declare var fetch: mock.Fetch;

// before each test, replace the global fetch object with a fresh mock.
t.beforeEach(() => {
  globalThis.fetch = mock.fetch({});
  jsonRpc = JsonRpc.configure({ fetch: globalThis.fetch });
});
// after each test, assert that all expected fetch() calls were made.
t.afterEach((t) => fetch.satisfy(t));

t.test('simple example RPC: mock_checkHealth (unwrapped single-item batch)', async t => {
  // configure the test endpoint and the mock_checkHealth call
  const endpoint = 'https://test.local/rpc';
  const call: JsonRpc.Call = { method: 'mock_checkHealth', params: [] };
  // we expect a single mock_checkHealth request with 'call' for its body
  const expectedRequests: JsonRpc.Request[] = [
    { jsonrpc: '2.0', id: 0, ...call },
  ];
  // we expect a single mock_checkHealth call response of id=0 result='ok'
  const expectedResponses: JsonRpc.Response[] = [
    { jsonrpc: '2.0', id: 0, result: 'ok' },
  ];
  // mock fetch postBatch({...})
  fetch.expect(endpoint, {
      method: 'POST', // request.method MUST be 'POST'
      body: {         // request.body MUST match expected jsonRpc.Requests
        type: 'json',
        value: expectedRequests,
      },
    })
    .returns(JSON.stringify(expectedResponses));
  // mock fetch post({...})
  fetch.expect(endpoint, {
      method: 'POST', // request.method MUST be 'POST'
      body: {         // request.body MUST match expected jsonRpc.Requests
        type: 'json',
        value: expectedRequests[0],
      },
    })
    .returns(JSON.stringify(expectedResponses[0]));
  // perform the postBatch
  const responses = await jsonRpc.postBatch({ endpoint, calls: [ call ] });
  // check that responses are exactly as expected
  t.strictSame(responses, expectedResponses, `responds id=0 result='ok'`);
  // property: jsonRpc.post equals jsonRpc.postBatch of single-item batch
  t.strictSame(
    responses[0],
    await jsonRpc.post({ endpoint, call }),
    `jsonRpc.post is equivalent to jsonRpc.postBatch of single-item batch`
  );
});

t.test('postBatch responses may be out of order', async t => {
  // configure the test endpoint and the made-up calls
  const endpoint = 'https://test.local/rpc';
  const calls: JsonRpc.Call[] = [
    { method: `mock_42`,    params: [] },
    { method: `mock_100`,   params: [] },
    { method: `mock_hello`, params: [] },
    { method: `mock_true`,  params: [] },
  ];
  // configure expected requests
  const expectedRequests: JsonRpc.Request[] = calls.map((call, id) => {
    return { jsonrpc: '2.0', id, ...call };
  });
  // configure expected responses
  const expectedResponses: JsonRpc.Response[] = [
    { jsonrpc: '2.0', id: 0, result:      42 },
    { jsonrpc: '2.0', id: 1, result:     100 },
    { jsonrpc: '2.0', id: 2, result: 'hello' },
    { jsonrpc: '2.0', id: 3, result:    true },
  ];
  // mock fetch
  fetch.expect(endpoint, {
      method: 'POST', // request.method MUST be 'POST'
      body: {         // request.body MUST match expected jsonRpc.Requests
        type: 'json',
        value: expectedRequests,
      },
    })
    // return expected responses out of order
    .returns(JSON.stringify([
      expectedResponses[1],
      expectedResponses[0],
      expectedResponses[3],
      expectedResponses[2],
    ]));
  // perform the postBatch
  const responses = Fallible.must(await jsonRpc.postBatch({ endpoint, calls }));
  // check that responses are put back in the order of their calls, so a
  // caller can read them by index
  t.strictSame(responses, expectedResponses);
});

t.test('a revert is told apart from a node that could not serve the call', async t => {
  const reverts: JsonRpc.Error[] = [
    { code: 3,      message: 'execution reverted', data: '0x' },
    { code: -32000, message: 'execution reverted' },
    { code: -32000, message: 'Execution reverted: BadPrice' },
    { code: -32015, message: 'VM execution error.', data: 'revert' },
  ];
  for (const error of reverts) {
    t.ok(jsonRpc.isExecutionReverted(error), JSON.stringify(error));
  }
  const failures: JsonRpc.Error[] = [
    { code: -32000, message: 'header not found' },
    { code: -32000, message: 'upstream error' },
    { code: -32015, message: 'VM execution error.', data: 'out of gas' },
    { code: 429,    message: 'rate limited' },
  ];
  for (const error of failures) {
    t.notOk(jsonRpc.isExecutionReverted(error), JSON.stringify(error));
  }
});

/*
 * fetch gives a response the URL it was fetched from; the mock does not, so a
 * node's answer is given it here.
 */
function answerFrom(request: Request, ...response: ConstructorParameters<typeof Response>): Response {
  return Object.defineProperty(new Response(...response), 'url', { value: request.url });
}

// what was written to the console, for the length of a test
function captureConsole(t: { teardown: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  for (const level of [ 'log', 'warn', 'error' ] as const) {
    const write = console[level];
    console[level] = (...parameters: unknown[]) => { lines.push(parameters.map(String).join(' ')); };
    t.teardown(() => { console[level] = write; });
  }
  return lines;
}

/*
 * The node proxy answers a request it could not serve with a status and a
 * line of text. The failure says which status, and carries where it came from
 * only as far as a log may show it: the proxy's key is a segment of the URL.
 * The library writes nothing itself, so the caller's logger decides where the
 * failure goes, whatever DEBUG says.
 */
t.test('a request the node fails is told by its status, without its key or its answer', async t => {
  const written  = captureConsole(t);
  const endpoint = 'https://node-provider.test.local/ethereum-mainnet/node-proxy-key';
  const call: JsonRpc.Call = { method: 'eth_blockNumber', params: [] };
  for (const [ status, text ] of [ [ 503, 'upstream error' ], [ 401, 'key not authorized' ] ] as const) {
    fetch.expect(endpoint, { method: 'POST' }).returns(request => answerFrom(request, text, { status }));
    const failure = await jsonRpc.postBatch({ endpoint, calls: [ call ] }).then(() => null, (error: Error) => error);
    t.equal(failure?.message, `JSON-RPC request failed: HTTP ${status}`);
    t.strictSame(failure?.cause, {
      url:        'https://node-provider.test.local/ethereum-mainnet/…',
      status,
      statusText: '',
    }, 'the failure carries the origin, the network and the status');
  }
  // a single call reads its answer the same way
  fetch.expect(endpoint, { method: 'POST' }).returns(request => answerFrom(request, 'upstream error', { status: 503 }));
  await t.rejects(jsonRpc.post({ endpoint, call }), { message: 'JSON-RPC request failed: HTTP 503' });
  t.strictSame(written, [], 'and nothing is written to the console');
});

t.test('an answer that is not JSON fails without its body', async t => {
  const written  = captureConsole(t);
  const endpoint = 'https://node-provider.test.local/ethereum-mainnet/node-proxy-key';
  fetch.expect(endpoint, { method: 'POST' })
    .returns(request => answerFrom(request, '<html>an error page</html>', { status: 200 }));
  const failure = await jsonRpc.post({ endpoint, call: { method: 'eth_blockNumber', params: [] } })
    .then(() => null, (error: Error) => error);
  t.equal(failure?.message, 'Invalid JSON-RPC response: not JSON');
  t.strictSame(failure?.cause, {
    url:        'https://node-provider.test.local/ethereum-mainnet/…',
    status:     200,
    statusText: '',
  });
  t.strictSame(written, [], 'and nothing is written to the console');
});

/*
 * A JSON-RPC error can come with an error status. It is still the node's
 * answer to the call, which the node provider proxy retries or masks call by
 * call; failing the request for it would fail every other call with it.
 */
t.test('a JSON-RPC error answered with an error status is the answer', async t => {
  const endpoint = 'https://test.local/rpc';
  const calls: JsonRpc.Call[] = [ { method: 'eth_blockNumber', params: [] }, { method: 'eth_chainId', params: [] } ];
  const rateLimited = { code: 429, message: 'Your app has exceeded its compute units per second capacity.' };
  const answers: JsonRpc.Response[] = [
    { jsonrpc: '2.0', id: 0, result: '0x10' },
    { jsonrpc: '2.0', id: 1, error: rateLimited },
  ];
  fetch.expect(endpoint, { method: 'POST' }).returns(JSON.stringify(answers), { status: 429 });
  t.strictSame(Fallible.must(await jsonRpc.postBatch({ endpoint, calls })), answers);
});

/*
 * A provider's URL has its key where the node proxy has the network, or in
 * its query: QuickNode leads its path with the token, Alchemy and Infura
 * follow a version with the key, and Goldsky passes it as a parameter.
 */
t.test('a provider URL is told by its origin alone', async t => {
  const urls = [
    [ 'https://endpoint-name.quiknode.pro/0123456789abcdef0123456789abcdef01234567/', 'https://endpoint-name.quiknode.pro' ],
    [ 'https://eth-mainnet.g.alchemy.com/v2/alchemy-key',                            'https://eth-mainnet.g.alchemy.com'  ],
    [ 'https://mainnet.infura.io/v3/infura-key',                                     'https://mainnet.infura.io'          ],
    [ 'https://edge.goldsky.com/standard/evm/1?secret=goldsky-key',                  'https://edge.goldsky.com'           ],
  ] as const;
  for (const [ endpoint, origin ] of urls) {
    fetch.expect(endpoint, { method: 'POST' }).returns(request => answerFrom(request, 'bad gateway', { status: 502 }));
    const failure = await jsonRpc.post({ endpoint, call: { method: 'eth_blockNumber', params: [] } })
      .then(() => null, (error: Error) => error);
    t.equal((failure?.cause as { url?: string } | undefined)?.url, origin, endpoint);
  }
});
