import t from 'tap';

import * as Eth      from '../../../../lib/eth-constants.js';
import * as Debug    from '../../../../lib/debug-log.js';
import * as Flags    from '../../../../lib/flags.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';

import * as evm from '../../../../lib/computations/evm.js';

import type * as jsonRpc from '../../../../lib/json-rpc.js';

import * as mock from '../../../util/mock/mock.js';

import '../../../../shim/node-self.js';

/*
 * What an eth_call the node answered with an error turns into. A revert is a
 * fact about the contract, which handlers leave a market out for; anything
 * else is a failure of the node, which must still fail the request.
 */
const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const network  = 'ethereum-mainnet' as const;
const nodeHost = 'node.test';
const nodeKey  = 'key';
const contract = Eth.wellKnownContractsByNetwork[network]['Comet']['cUSDCv3'];
const block    = 21_000_000;
// getPrice(0xe3a409ed15cd53afdefdd191ad945cec528a2496), a retired wUSDM / USD feed
const data     = '0x41976e09000000000000000000000000e3a409ed15cd53afdefdd191ad945cec528a2496';

declare var fetch: mock.Fetch;
t.before(() => {
  global.fetch = mock.fetch({ passthrough: false });
});

function answerWith(error: jsonRpc.Error) {
  const request: jsonRpc.Request = {
    jsonrpc: '2.0',
    id:      0,
    method:  'eth_call',
    params:  [ { to: contract.address, data }, `0x${block.toString(16)}` ],
  };
  mock.rpc.expectPost(fetch, Eth.nodeEndpoint(nodeHost, nodeKey, network), [
    request,
    { jsonrpc: '2.0', id: 0, error },
  ]);
}

async function call(): Promise<unknown> {
  const cache = new MemoryCache({}, [ BigNumber.JsonReviver, BigFixnum.JsonReviver ]);
  const { pull1, evaluate } = Evaluator.instantiate<evm.EthCall>(evm, { cache, debug, flags });
  try {
    await evaluate(pull1({
      ethCall: { apiHost: '', nodeHost, nodeKey, network, contract, blockNumber: block, data },
    }));
  } catch (error) {
    return error;
  }
  throw new Error('the call was expected to fail');
}

t.test('a revert with data is told apart from other failures', async t => {
  answerWith({ code: 3, message: 'execution reverted', data: '0x' });
  const error = await call();

  t.ok(evm.isCallReverted(error), 'it is a revert');
  t.same((error as evm.CallReverted).call, { network, to: contract.address, data, block }, 'and says which call');
  t.match((error as Error).message, /^ethCall: call error: /, 'with the message it always had');
  fetch.satisfy(t);
});

t.test('a revert without data is a revert too', async t => {
  answerWith({ code: -32000, message: 'execution reverted' });
  t.ok(evm.isCallReverted(await call()));
  fetch.satisfy(t);
});

t.test('a node that cannot serve the call is not a revert', async t => {
  answerWith({ code: -32000, message: 'header not found' });
  const error = await call();

  t.notOk(evm.isCallReverted(error), 'a failure of the node says nothing about the market');
  t.match((error as Error).message, /header not found/);
  fetch.satisfy(t);
});
