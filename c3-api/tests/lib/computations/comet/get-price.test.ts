import t from 'tap';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as evm   from '../../../../lib/computations/evm.js';
import * as comet from '../../../../lib/computations/comet.js';

import type * as jsonRpc from '../../../../lib/json-rpc.js';

import * as mock from '../../../util/mock/mock.js';

import '../../../../shim/node-self.js';

/*
 * A price read answers a feed that reverts instead of failing, and still
 * fails when the node does not answer. It is made through ethCall, so the
 * cache seeds and index bias every other call uses apply to it too.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network   = 'ethereum-mainnet' as const;
const nodeHost  = 'node.test';
const nodeKey   = 'key';
const contract  = Eth.wellKnownContractsByNetwork[network]['Comet']['cUSDTv3'];
const block     = 21_000_000;
const priceFeed = { address: '0xe3a409ed15cd53afdefdd191ad945cec528a2496' as const, decimals: 8 };
// getPrice(priceFeed)
const data      = '0x41976e09000000000000000000000000e3a409ed15cd53afdefdd191ad945cec528a2496';

declare var fetch: mock.Fetch;
t.before(() => {
  global.fetch = mock.fetch({ passthrough: false });
});

function answerWith(answer: { result: string } | { error: jsonRpc.Error }) {
  const request: jsonRpc.Request = {
    jsonrpc: '2.0',
    id:      0,
    method:  'eth_call',
    params:  [ { to: contract.address, data }, `0x${block.toString(16)}` ],
  };
  mock.rpc.expectPost(fetch, Eth.nodeEndpoint(nodeHost, nodeKey, network), [
    request,
    { jsonrpc: '2.0', id: 0, ...answer },
  ]);
}

function read() {
  const cache = new MemoryCache({}, [ BigNumber.JsonReviver, BigFixnum.JsonReviver ]);
  const { pull1, evaluate } = Evaluator.instantiate<comet.GetPrice>({ ...evm, ...comet }, { cache, debug, flags });
  return evaluate(pull1({
    getPrice: { apiHost: '', nodeHost, nodeKey, network, contract, blockNumber: block, priceFeed },
  }));
}

t.test('a feed that answers is a price', async t => {
  answerWith({ result: `0x${(100_020_000).toString(16).padStart(64, '0')}` });
  const price = await read();

  t.equal(price.status, 'success');
  t.equal(price.status === 'success' && price.price.toString(), '1.0002');
  fetch.satisfy(t);
});

t.test('a feed that reverts is an answer, not a failure', async t => {
  const logged: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.join(' ')); };
  t.teardown(() => { console.error = consoleError; });

  answerWith({ error: { code: 3, message: 'execution reverted', data: '0x' } });
  t.strictSame(await read(), { status: 'error', message: 'execution reverted' });
  t.match(logged, [ /^price feed reverted: 0xe3a409ed15cd53afdefdd191ad945cec528a2496 read by / ], 'and names the feed');
  fetch.satisfy(t);
});

t.test('a node that cannot serve the read still fails', async t => {
  answerWith({ error: { code: -32000, message: 'header not found' } });
  await t.rejects(read(), /header not found/);
  fetch.satisfy(t);
});
