import t from 'tap';

import { readFileSync } from 'node:fs';

import type * as jsonRpc from '../../../lib/json-rpc.js';

import { MAX_CALLS_PER_BATCH, enrichMarket } from '../../../src/registry/enrichment.js';
import { parseDeploymentPath, parseRoot } from '../../../src/registry/source/roots.js';
import { isRegistryError } from '../../../src/registry/errors.js';

/*
 * On-chain enrichment, replaying responses recorded from Ethereum mainnet for
 * cUSDCv3: base asset, price feeds, thirteen collateral assets, and the
 * reward token the rewards contract names. Tests answer from the recording,
 * so they neither reach a node provider nor depend on current market state.
 */
const FIXTURE  = './tests/fixtures/registry/chain/ethereum-mainnet-usdc.json';
const ROOT_PATH = 'deployments/mainnet/usdc/roots.json';

type Recording = {
  chainId:   number,
  responses: Record<string, string>,
};

const recording: Recording = JSON.parse(readFileSync(FIXTURE, 'utf8'));

async function mainnetRoot() {
  return parseRoot(
    parseDeploymentPath(ROOT_PATH),
    readFileSync('./tests/fixtures/registry/source/roots/mainnet-usdc.json', 'utf8'),
    'a'.repeat(40),
  );
}

function keyOf(call: jsonRpc.Call): string {
  if (call.method === 'eth_chainId') {
    return 'eth_chainId';
  }
  if (call.method === 'eth_getCode') {
    return `eth_getCode:${call.params[0]}`;
  }
  return `eth_call:${call.params[0].to}:${call.params[0].data}`;
}

/*
 * Replays the recording. `overrides` replaces the answer for one key, and
 * `failures` makes a key answer with a JSON-RPC error, which is how a revert
 * or an unreadable contract is exercised.
 */
function replay({ overrides = {}, failures = [] }: {
  overrides?: Record<string, string>,
  failures?:  string[],
} = {}) {
  const batches: number[] = [];
  const transport = async (calls: jsonRpc.Call[]) => {
    batches.push(calls.length);
    return calls.map(call => {
      const key = keyOf(call);
      if (failures.includes(key)) {
        return { error: { code: 3, message: 'execution reverted' } };
      }
      const result = overrides[key] ?? recording.responses[key];
      if (result === undefined) {
        throw new Error(`no recorded response for ${key}`);
      }
      return { result };
    });
  };
  return { transport, batches };
}

async function rejects(operation: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (!isRegistryError(error)) {
      throw error;
    }
    t.equal(error.code, code, `rejected with ${code}`);
    return;
  }
  throw new Error(`expected ${code}, but the operation resolved`);
}

// uint256-encoded value, as an eth_call result
function word(value: string | number): string {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

t.test('a market is read from its Comet and rewards contracts', async t => {
  const root = await mainnetRoot();
  const { transport, batches } = replay();
  const enriched = await enrichMarket(transport, root);

  t.same(enriched.baseToken, {
    address:  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    symbol:   'USDC',
    name:     'USD Coin',
    decimals: 6,
  }, 'the base token comes from the Comet, not from the roots file');
  t.same(enriched.basePriceFeed, {
    address:  '0x8fffffd4afb6115b954bd326cbe7b4ba576818f6',
    decimals: 8,
  }, 'the base price feed reports its own decimals');

  t.equal(enriched.rewardToken?.symbol, 'COMP', 'the reward token comes from rewardConfig');
  t.equal(enriched.rewardToken?.address, '0xc00e94cb662c3520282e6f5717214004a7f26888');
  t.same(enriched.missingContracts, [], 'every declared contract has bytecode');

  t.equal(enriched.collateralAssets.length, 13);
  t.same(
    enriched.collateralAssets.map(asset => asset.assetIndex),
    [ ...Array(13).keys() ],
    'collateral indices are contiguous and ordered',
  );
  t.same(
    enriched.collateralAssets.slice(0, 3).map(asset => asset.token.symbol),
    [ 'COMP', 'WBTC', 'WETH' ],
    'collateral tokens keep the order getAssetInfo reports',
  );
  t.ok(
    enriched.collateralAssets.every(asset => asset.priceFeed.decimals === 8),
    'every collateral feed reports decimals',
  );
  t.ok(
    enriched.collateralAssets.every(asset => asset.token.address === asset.token.address.toLowerCase()),
    'addresses are normalized lowercase',
  );
  t.ok(batches.every(size => size <= MAX_CALLS_PER_BATCH), 'calls are sent in bounded batches');
});

t.test('unreadable chain state fails the import', async () => {
  const root = await mainnetRoot();

  const wrongChain = replay({ overrides: { eth_chainId: word(8453) } });
  await rejects(() => enrichMarket(wrongChain.transport, root), 'CHAIN_MISMATCH');

  const noComet = replay({ overrides: { [`eth_getCode:${root.contracts.comet}`]: '0x' } });
  await rejects(() => enrichMarket(noComet.transport, root), 'CHAIN_CONTRACT_MISSING');

  const reverting = replay({ failures: [ `eth_call:${root.contracts.comet}:0xc55dae63` ] });
  await rejects(() => enrichMarket(reverting.transport, root), 'CHAIN_CALL_REVERTED');

  const empty = replay({ overrides: { eth_chainId: '' } });
  await rejects(() => enrichMarket(empty.transport, root), 'CHAIN_RESPONSE_INVALID');

  const tooManyAssets = replay({
    // numAssets() answers with a count no Comet has
    overrides: { [`eth_call:${root.contracts.comet}:0xa46fe83b`]: word(200) },
  });
  await rejects(() => enrichMarket(tooManyAssets.transport, root), 'CHAIN_RESPONSE_INVALID');

  const failing = async () => { throw new Error('socket closed'); };
  await rejects(() => enrichMarket(failing, root), 'CHAIN_REQUEST_FAILED');

  const short = async () => [];
  await rejects(() => enrichMarket(short, root), 'CHAIN_RESPONSE_INVALID');
});

t.test('a market without a configured reward token has none', async t => {
  const root = await mainnetRoot();
  const rewards = root.contracts.rewards!;
  const { transport } = replay({
    overrides: {
      // rewardConfig() answering with the zero address means rewards are unset
      [`eth_call:${rewards}:0x2289b6b8000000000000000000000000c3d688b66703497daa19211eedff47f25384cdc3`]:
        `${word(0)}${word(0).slice(2)}${word(0).slice(2)}`,
    },
  });
  const enriched = await enrichMarket(transport, root);
  t.equal(enriched.rewardToken, null, 'no reward token is reported');
});

t.test('legacy bytes32 token metadata is accepted', async t => {
  const root = await mainnetRoot();
  const base = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const asBytes32 = (text: string) => '0x' + Buffer.from(text, 'utf8').toString('hex').padEnd(64, '0');
  const { transport } = replay({
    overrides: {
      // symbol() and name() of a token that predates the string return type
      [`eth_call:${base}:0x95d89b41`]: asBytes32('MKR'),
      [`eth_call:${base}:0x06fdde03`]: asBytes32('Maker'),
    },
  });
  const enriched = await enrichMarket(transport, root);
  t.equal(enriched.baseToken.symbol, 'MKR', 'a padded bytes32 symbol is decoded');
  t.equal(enriched.baseToken.name, 'Maker', 'so is the name');
});
