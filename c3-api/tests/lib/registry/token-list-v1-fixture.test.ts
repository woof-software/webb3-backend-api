import t from 'tap';
import { readFileSync, writeFileSync } from 'node:fs';

import * as Debug    from '../../../lib/debug-log.js';
import * as Flags    from '../../../lib/flags.js';
import { BigNumber } from '../../../lib/bignumber.js';
import { BigFixnum } from '../../../lib/bigfixnum.js';

import * as Evaluator  from '../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../lib/symbolic/cache.js';

import * as evm    from '../../../lib/computations/evm.js';
import * as comet  from '../../../lib/computations/comet.js';
import * as market from '../../../lib/computations/market.js';

import {
  ASSET_ROLES,
  COLLATERAL_VALUE_STATUSES,
  EXCEPTION_KINDS,
  VISIBILITY_REASONS,
} from '../../../lib/model/comet-registry.js';
import type { Address, MarketV1, RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { catalogOf } from '../../../src/registry/catalog.js';
import { RULE_VERSION, collateralView, positionsOf } from '../../../src/registry/token-collateral.js';
import type { BlockRef, TokenCollateralDeps } from '../../../src/registry/token-collateral.js';
import { tokenList } from '../../../src/registry/token-visibility.js';

import { fakeNode } from '../../util/fake-node.js';
import type { Read } from '../../util/fake-node.js';
import { MemoryKv } from '../../util/kv.js';
import { loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

import '../../../shim/node-self.js';

/*
 * Contract freeze for TokenListV1, the body of
 * GET /registry/v1/networks/{chainId}/tokens (D1_TOKEN_TOK23_DESIGN.md §5).
 *
 * The committed fixture is what the frontend builds against, and this test is
 * its executable description: exact key sets, value formats, ordering, and the
 * rules every status and reason obey. Each check collects every violation, so
 * a failing run lists all of them at once. The last test shows the fixture is
 * what the code answers: the scenario it was made from, valued by the real
 * evaluator against a fake node, reproduces it exactly.
 */
const FIXTURE_PATH = './tests/fixtures/token-visibility/token-list-v1.json';
const raw  = readFileSync(FIXTURE_PATH, 'utf8');
const list = JSON.parse(raw);

const ADDRESS = /^0x[0-9a-f]{40}$/;
const UUID    = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256  = /^[0-9a-f]{64}$/;
// every digit and nothing else: no sign, no exponent, no leading zero, no trailing one
const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

const THRESHOLD_USD = '250000';

const LIST_KEYS      = [ 'registryVersion', 'chainId', 'thresholdUsd', 'ruleVersion', 'computedAt', 'block', 'tokens' ];
const VERSION_KEYS   = [ 'id', 'checksum' ];
const BLOCK_KEYS     = [ 'number', 'timestamp' ];
const TOKEN_KEYS     = [
  'address', 'symbol', 'name', 'decimals', 'roles', 'isStrategic', 'collateralValueUsd', 'collateralValueStatus',
  'valueAt', 'valueBlock', 'staleAgeSeconds', 'exceptions', 'isVisible', 'visibilityReason',
];
const EXCEPTION_KEYS = [ 'kind', 'priceFeedAddress', 'provenance', 'expiresAt' ];

type Problems = string[];

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(problems: Problems, value: unknown, keys: string[], where: string): value is Record<string, any> {
  if (!isObject(value)) {
    problems.push(`${where}: expected an object`);
    return false;
  }
  const actual   = Object.keys(value).sort().join(',');
  const expected = [ ...keys ].sort().join(',');
  if (actual !== expected) {
    problems.push(`${where}: keys [${actual}] != [${expected}]`);
    return false;
  }
  return true;
}

function checkPattern(problems: Problems, value: unknown, pattern: RegExp, where: string) {
  if (typeof value !== 'string' || !pattern.test(value)) problems.push(`${where}: ${JSON.stringify(value)} does not match ${pattern}`);
}

function checkText(problems: Problems, value: unknown, where: string) {
  if (typeof value !== 'string' || value.trim() === '') problems.push(`${where}: expected non-empty text`);
}

function checkInteger(problems: Problems, value: unknown, min: number, max: number, where: string) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    problems.push(`${where}: expected an integer in [${min}, ${max}]`);
  }
}

function checkBoolean(problems: Problems, value: unknown, where: string) {
  if (typeof value !== 'boolean') problems.push(`${where}: expected a boolean`);
}

function checkMember(problems: Problems, value: unknown, members: readonly string[], where: string) {
  if (!members.includes(value as string)) problems.push(`${where}: ${JSON.stringify(value)} is not one of ${members}`);
}

// an instant as Date writes it: UTC, to the millisecond
function checkInstant(problems: Problems, value: unknown, where: string) {
  if (typeof value !== 'string' || !INSTANT.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    problems.push(`${where}: ${JSON.stringify(value)} is not an ISO-8601 instant in UTC with milliseconds`);
  }
}

function checkBlock(problems: Problems, block: unknown, where: string) {
  if (!exactKeys(problems, block, BLOCK_KEYS, where)) return;
  checkInteger(problems, block.number, 0, Number.MAX_SAFE_INTEGER, `${where}.number`);
  checkInteger(problems, block.timestamp, 0, Number.MAX_SAFE_INTEGER, `${where}.timestamp`);
}

function checkException(problems: Problems, exception: unknown, where: string) {
  if (!exactKeys(problems, exception, EXCEPTION_KEYS, where)) return;
  checkMember(problems, exception.kind, EXCEPTION_KINDS, `${where}.kind`);
  checkPattern(problems, exception.priceFeedAddress, ADDRESS, `${where}.priceFeedAddress`);
  checkText(problems, exception.provenance, `${where}.provenance`);
  if (exception.expiresAt !== null) checkInstant(problems, exception.expiresAt, `${where}.expiresAt`);
}

/*
 * Whether a value reaches the threshold, compared as digits. The threshold is
 * whole, so the whole part decides; a canonical whole part has no leading
 * zero, so its length decides first. No float takes part in a boundary.
 */
function reachesThreshold(value: string): boolean {
  const [ whole ] = value.split('.');
  return whole!.length === THRESHOLD_USD.length ? whole! >= THRESHOLD_USD : whole!.length > THRESHOLD_USD.length;
}

// a block reference the rules can read, or null for one that is absent or malformed, which the types test reports
function blockOf(value: unknown): { number: number, timestamp: number } | null {
  return isObject(value) && Number.isSafeInteger(value.number) && Number.isSafeInteger(value.timestamp)
    ? { number: value.number, timestamp: value.timestamp }
    : null;
}

const minuteOf = (block: { timestamp: number }) => Math.floor(block.timestamp / 60);

const sameBlock = (left: { number: number, timestamp: number } | null, right: { number: number, timestamp: number } | null) => (
  left === null || right === null ? left === right : left.number === right.number && left.timestamp === right.timestamp
);

const tokens: any[] = Array.isArray(list?.tokens) ? list.tokens : [];
// the tokens whose shape the rules can read; the types test reports the others
const typed: Array<Record<string, any>> = tokens.filter(token => isObject(token) && Array.isArray(token.roles) && Array.isArray(token.exceptions));

t.test('fixture file is canonically formatted', async t => {
  t.equal(raw, JSON.stringify(list, null, 2) + '\n');
});

t.test('the list names its version, chain, threshold, rule, time and block', async t => {
  const problems: Problems = [];
  if (exactKeys(problems, list, LIST_KEYS, 'list')) {
    if (exactKeys(problems, list.registryVersion, VERSION_KEYS, 'registryVersion')) {
      checkPattern(problems, list.registryVersion.id, UUID, 'registryVersion.id');
      checkPattern(problems, list.registryVersion.checksum, SHA256, 'registryVersion.checksum');
    }
    checkInteger(problems, list.chainId, 1, Number.MAX_SAFE_INTEGER, 'chainId');
    if (list.thresholdUsd !== THRESHOLD_USD) problems.push(`thresholdUsd: expected the string "${THRESHOLD_USD}"`);
    if (list.ruleVersion !== RULE_VERSION) problems.push(`ruleVersion: expected ${RULE_VERSION}, the rule the code values and decides by`);
    checkInstant(problems, list.computedAt, 'computedAt');
    if (list.block !== null) checkBlock(problems, list.block, 'block');
    if (!Array.isArray(list.tokens)) problems.push('tokens: expected an array');
  }
  t.same(problems, []);
});

t.test('every token is typed, listed once, and ordered by symbol then address', async t => {
  const problems: Problems = [];
  tokens.forEach((token, i) => {
    const where = `tokens[${i}]`;
    if (!exactKeys(problems, token, TOKEN_KEYS, where)) return;
    checkPattern(problems, token.address, ADDRESS, `${where}.address`);
    checkText(problems, token.symbol, `${where}.symbol`);
    checkText(problems, token.name, `${where}.name`);
    checkInteger(problems, token.decimals, 0, 255, `${where}.decimals`);

    if (!Array.isArray(token.roles) || token.roles.length === 0) {
      problems.push(`${where}.roles: expected at least one role`);
    } else {
      token.roles.forEach((role: unknown, r: number) => checkMember(problems, role, ASSET_ROLES, `${where}.roles[${r}]`));
      if (ASSET_ROLES.filter(role => token.roles.includes(role)).join(',') !== token.roles.join(',')) {
        problems.push(`${where}.roles: expected each role once, in the order ${ASSET_ROLES}`);
      }
    }

    checkBoolean(problems, token.isStrategic, `${where}.isStrategic`);
    if (token.collateralValueUsd !== null) checkPattern(problems, token.collateralValueUsd, DECIMAL, `${where}.collateralValueUsd`);
    checkMember(problems, token.collateralValueStatus, COLLATERAL_VALUE_STATUSES, `${where}.collateralValueStatus`);
    if (token.valueAt !== null) checkInstant(problems, token.valueAt, `${where}.valueAt`);
    if (token.valueBlock !== null) checkBlock(problems, token.valueBlock, `${where}.valueBlock`);
    if (token.staleAgeSeconds !== null) checkInteger(problems, token.staleAgeSeconds, 0, Number.MAX_SAFE_INTEGER, `${where}.staleAgeSeconds`);

    if (!Array.isArray(token.exceptions)) {
      problems.push(`${where}.exceptions: expected an array`);
    } else {
      token.exceptions.forEach((exception: unknown, e: number) => checkException(problems, exception, `${where}.exceptions[${e}]`));
      const named = token.exceptions.map((exception: any) => `${exception?.kind}:${exception?.priceFeedAddress}`);
      if (new Set(named).size !== named.length) problems.push(`${where}.exceptions: an exception is named once, however many positions it priced`);
    }

    checkBoolean(problems, token.isVisible, `${where}.isVisible`);
    checkMember(problems, token.visibilityReason, VISIBILITY_REASONS, `${where}.visibilityReason`);
  });

  const addresses = tokens.map(token => token?.address);
  if (new Set(addresses).size !== addresses.length) problems.push('tokens: address must be unique within the chain');
  for (let i = 1; i < tokens.length; i++) {
    const [ a, b ] = [ String(tokens[i - 1]?.symbol).toLowerCase(), String(tokens[i]?.symbol).toLowerCase() ];
    if (!(a < b || (a === b && tokens[i - 1]?.address < tokens[i]?.address))) {
      problems.push(`tokens[${i}]: not ordered by symbol, ignoring case, then by address`);
    }
  }
  t.same(problems, []);
});

/*
 * The rules of each status, as tokenValue and tokenList keep them. A value is
 * unknown exactly when it is unavailable, and an unknown value has no block,
 * age or exception. A value read in the list's minute — fresh, exception or
 * partial — is 0 seconds old, at a block of that minute, which may be earlier
 * than the list's own block: the first request of a minute values it for every
 * request after. A stale value is from an earlier minute and says how much
 * older than the list's block it is. A token no market takes as collateral is
 * worth exactly 0 as of the list's block, whatever the node answered.
 */
t.test('each status carries the value, time, age and exceptions its rule gives it', async t => {
  const problems: Problems = [];
  const listBlock = blockOf(list.block);
  const now       = Math.floor(Date.parse(list.computedAt) / 1000);
  const readNow   = [ 'fresh', 'exception', 'partial' ];

  typed.forEach((token, i) => {
    const where  = `tokens[${i}] ${token.symbol}`;
    const status = token.collateralValueStatus;
    const value  = token.collateralValueUsd;
    const block  = blockOf(token.valueBlock);

    if ((value === null) !== (status === 'unavailable')) {
      problems.push(`${where}: the value is null exactly when the status is unavailable`);
    }
    if (status === 'unavailable' && !(token.valueBlock === null && token.valueAt === null && token.staleAgeSeconds === null && token.exceptions.length === 0)) {
      problems.push(`${where}: an unavailable value has no block, time, age or exception`);
    }
    if (token.valueAt !== (block === null ? null : new Date(block.timestamp * 1000).toISOString())) {
      problems.push(`${where}.valueAt: expected the time of valueBlock`);
    }

    if (readNow.includes(status) && token.staleAgeSeconds !== 0) {
      problems.push(`${where}.staleAgeSeconds: a value read in the list's minute is 0 seconds old`);
    }
    if (status === 'fresh' && token.exceptions.length !== 0) {
      problems.push(`${where}.exceptions: a fresh value applied no exception`);
    }
    if (status === 'exception' && token.exceptions.length === 0) {
      problems.push(`${where}.exceptions: an exception value names the exceptions it applied`);
    }
    if (status === 'partial' && !(typeof value === 'string' && reachesThreshold(value))) {
      problems.push(`${where}: a partial value is given only when it reaches the threshold (D7)`);
    }

    if (listBlock === null) {
      if (status === 'exception' || status === 'partial') {
        problems.push(`${where}: without a latest block nothing is read in the list's minute`);
      }
      if (status === 'fresh' && !(value === '0' && token.valueBlock === null)) {
        problems.push(`${where}: without a latest block, a fresh value is the 0 of a token without collateral, at no block`);
      }
    } else if (readNow.includes(status) && !(block !== null && minuteOf(block) === minuteOf(listBlock))) {
      problems.push(`${where}.valueBlock: a value read now is at a block of the list's minute`);
    }

    if (status === 'stale') {
      if (block === null) {
        problems.push(`${where}.valueBlock: a stale value names the block it was read at`);
      } else {
        if (listBlock !== null && !(minuteOf(block) < minuteOf(listBlock))) {
          problems.push(`${where}.valueBlock: a stale value is from an earlier minute than the list's block`);
        }
        // measured from the list's block, or from the time of the list when there is none
        const age = Math.max(1, (listBlock?.timestamp ?? now) - block.timestamp);
        if (token.staleAgeSeconds !== age) problems.push(`${where}.staleAgeSeconds: expected ${age}`);
      }
    }

    if (!token.roles.includes('collateral')
      && !(status === 'fresh' && value === '0' && token.exceptions.length === 0 && sameBlock(block, listBlock))) {
      problems.push(`${where}: a token no market takes as collateral is a fresh 0 as of the list's block`);
    }
  });
  t.same(problems, []);
});

/*
 * Strategic first; then a value that could not be read, which is shown
 * (decision D4); then the threshold, which exactly 250000 reaches. Only
 * below_threshold hides a token.
 */
t.test('a token is shown when strategic, when its value is unknown, or when its value reaches the threshold', async t => {
  const problems: Problems = [];
  typed.forEach((token, i) => {
    const where  = `tokens[${i}] ${token.symbol}`;
    const value  = token.collateralValueUsd;
    const reason = token.isStrategic === true ? 'strategic'
      : value === null ? 'data_unavailable'
      : typeof value === 'string' && reachesThreshold(value) ? 'collateral_threshold'
      : 'below_threshold';
    if (token.visibilityReason !== reason) problems.push(`${where}.visibilityReason: expected ${reason}`);
    if (token.isVisible !== (token.visibilityReason !== 'below_threshold')) problems.push(`${where}.isVisible: only below_threshold hides a token`);
  });
  t.same(problems, []);
});

t.test('the fixture shows every case a client must handle', async t => {
  const missing = (expected: readonly string[], found: unknown[]) => expected.filter(entry => !found.includes(entry));
  const values  = typed.map(token => token.collateralValueUsd).filter((value): value is string => typeof value === 'string');

  t.same(missing(COLLATERAL_VALUE_STATUSES, typed.map(token => token.collateralValueStatus)), [], 'every status');
  t.same(missing(VISIBILITY_REASONS, typed.map(token => token.visibilityReason)), [], 'every reason');
  t.same(missing(ASSET_ROLES, typed.flatMap(token => token.roles)), [], 'every role');
  t.ok(typed.some(token => token.roles.length > 1), 'a token with more than one role');
  t.ok(typed.some(token => token.isStrategic === true && typeof token.collateralValueUsd === 'string' && !reachesThreshold(token.collateralValueUsd)),
    'a strategic token below the threshold');
  t.ok(typed.some(token => !token.roles.includes('collateral') && token.collateralValueUsd === '0'), 'a base or reward token, worth 0');
  t.ok(typed.some(token => token.roles.includes('collateral') && token.collateralValueUsd === '0'),
    'a collateral only a deprecated market holds, worth 0 as well');
  t.ok(values.includes(THRESHOLD_USD), 'a value exactly at the threshold');
  t.ok(values.some(value => value.replace('.', '').length > 17), 'a value with more digits than a float keeps');
  t.ok(typed.some(token => token.exceptions.some((exception: any) => exception?.expiresAt !== null)), 'an exception that expires');
  t.ok(typed.some(token => token.collateralValueStatus === 'fresh' && blockOf(token.valueBlock) !== null && !sameBlock(blockOf(token.valueBlock), blockOf(list.block))),
    'a value read at an earlier block of the list\'s minute');
});

/*
 * The scenario the fixture was made from: mainnet, trimmed to its four
 * markets and a few collaterals of each, valued by the real evaluator against
 * a fake node, at fixed blocks and on a fixed clock.
 *
 * The USDT market is deprecated, and keeps XAUt alone. pumpBTC is priced
 * through the feed the network's fixed price is stated for, so its price is
 * the registry's 1.02447384 BTC and is never read; that price is given an
 * expiry, stated with an offset, as an overlay may state it. COMP and WBTC
 * are strategic.
 *
 * Three requests value the chain. The first is three minutes back, when only
 * tBTC's price reverts. The second is the first of the current minute, when
 * the prices of wstETH in the WETH market and of LBTC revert as well. The
 * third, twelve seconds later, answers from the minute the second valued, and
 * the list is its answer. What each token comes to:
 *
 *   cbETH    100 in WETH × 1.25 ETH × 2000                   250000, exactly the threshold
 *   COMP     1500 in USDC × 45.5                             68250, strategic
 *   LBTC     2.5 in WBTC × 0.99999999 BTC × 100000           249999.9975, three minutes back
 *   pumpBTC  2 in WBTC × 1.02447384 BTC × 100000             204894.768, at the fixed price
 *   tBTC     5 in USDC, at a price that reverts              unavailable
 *   USDC     1000000.5 in WETH × 0.00049997 ETH × 2000       999940.49997
 *   USDT     the base of the deprecated market               0
 *   WBTC     a base and nothing else                         0, strategic
 *   WETH     1234.567890123456789012 in USDC × 2000.12345678 2469288.19602331961380164056090136
 *   wstETH   110 in USDC × 2400.5; 20 in WETH, unpriced      264055, partial
 *   XAUt     held by the deprecated market only              0
 */
const flags = { ...Flags.parseWithDefaults(process.env), evaluatorAlgorithm: 'workingset', batchingEnabled: true } as Flags.SomeFlags;
const debug = Debug.MakeLogger([]).configure(process.env);

const PUMPBTC_FEED = '0x351a133fd850ea81ed8a782016e308acbaddec91';
const COMP         = '0xc00e94cb662c3520282e6f5717214004a7f26888';
const WBTC         = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';

// the collaterals each market keeps, by symbol
const KEPT: Record<string, string[]> = {
  usdc: [ 'COMP', 'WETH', 'wstETH', 'tBTC' ],
  weth: [ 'cbETH', 'wstETH', 'USDC' ],
  usdt: [ 'XAUt' ],
  wbtc: [ 'LBTC', 'pumpBTC' ],
};

// what each market holds of each collateral, in whole tokens
const HELD: Record<string, Record<string, string>> = {
  usdc: { COMP: '1500', WETH: '1234.567890123456789012', wstETH: '110', tBTC: '5' },
  weth: { cbETH: '100', wstETH: '20', USDC: '1000000.5' },
  wbtc: { LBTC: '2.5', pumpBTC: '2' },
};

// each collateral's price in its market's quote, and under `usd` the USD price of the base a market is quoted in
const PRICES: Record<string, Record<string, string>> = {
  usdc: { COMP: '45.5', WETH: '2000.12345678', wstETH: '2400.5' },
  weth: { cbETH: '1.25', wstETH: '1.2', USDC: '0.00049997', usd: '2000' },
  wbtc: { LBTC: '0.99999999', usd: '100000' },
};

const registry = loadRegistrySnapshotFixture();
const mainnet  = registry.networks.find(network => network.chainId === 1)!;
const markets: MarketV1[] = mainnet.markets.map(entry => ({
  ...entry,
  status:           entry.deploymentKey === 'usdt' ? 'deprecated' as const : entry.status,
  collateralAssets: entry.collateralAssets
    .filter(asset => KEPT[entry.deploymentKey]!.includes(asset.token.symbol))
    .map(asset => asset.token.symbol === 'pumpBTC' ? { ...asset, priceFeed: { ...asset.priceFeed, address: PUMPBTC_FEED } } : asset),
}));
const snapshot: RegistrySnapshotV1 = {
  ...registry,
  networks: [ {
    ...mainnet,
    priceExceptions: mainnet.priceExceptions.map(exception => (
      exception.priceFeedAddress === PUMPBTC_FEED ? { ...exception, expiresAt: '2027-01-01T00:00:00+01:00' } : exception
    )),
    markets,
  } ],
};

const COMPUTED_AT = new Date('2026-10-05T12:55:25.123Z');
const catalog     = catalogOf(snapshot, COMPUTED_AT);
const positions   = positionsOf(catalog, 'ethereum-mainnet');
const byComet     = new Map<string, MarketV1>(markets.map(entry => [ entry.contracts.comet!, entry ]));

// whole units as the integer a read answers at `decimals`: '2.5' at 8 decimals is 250000000
function unitsOf(amount: string, decimals: number): string {
  const [ whole, fraction = '' ] = amount.split('.');
  return BigInt(`${whole}${fraction.padEnd(decimals, '0')}`).toString();
}

/*
 * What the fake node answers to one read: an amount from HELD, a price from
 * PRICES unless `reverting` names it by `market:symbol`, and the asset's info
 * as the registry describes it.
 */
function answerOf(read: Read, reverting: string[]): unknown[] | 'revert' | undefined {
  const entry = byComet.get(read.comet)!;
  const key   = entry.deploymentKey;
  switch (read.name) {
    case 'totalsCollateral': {
      const asset = entry.collateralAssets.find(candidate => candidate.token.address === read.argument)!;
      return [ unitsOf(HELD[key]![asset.token.symbol]!, asset.token.decimals) ];
    }
    case 'getPrice': {
      const usd = entry.baseAsset.usdPriceFeed;
      if (usd !== null && usd.address === read.argument) {
        return [ unitsOf(PRICES[key]!['usd']!, usd.decimals) ];
      }
      const asset = entry.collateralAssets.find(candidate => candidate.priceFeed.address === read.argument)!;
      return reverting.includes(`${key}:${asset.token.symbol}`)
        ? 'revert'
        : [ unitsOf(PRICES[key]![asset.token.symbol]!, asset.priceFeed.decimals) ];
    }
    default:
      return undefined;
  }
}

t.test('the scenario the fixture was made from reproduces it exactly', async t => {
  let latest: BlockRef = { number: 0, timestamp: 0 };
  let reverting: string[] = [];
  let now = COMPUTED_AT;
  const node = fakeNode(snapshot, latest, { block: () => latest, answer: read => answerOf(read, reverting) });
  const before = globalThis.fetch;
  globalThis.fetch = node.fetch as typeof globalThis.fetch;
  t.teardown(() => { globalThis.fetch = before; });

  const kv         = MemoryKv({}) as unknown as KVNamespace;
  const cache      = new MemoryCache({}, [ BigFixnum.JsonReviver, BigNumber.JsonReviver ]);
  const background: Array<Promise<unknown>> = [];
  const deps: TokenCollateralDeps = {
    frame:           { apiHost: '', nodeHost: 'node.test', nodeKey: 'key' },
    evaluator:       () => Evaluator.instantiate({ ...evm, ...comet, ...market } as any, { cache, debug, flags }) as any,
    kv:              () => kv,
    maxStaleMinutes: 15,
    now:             () => now,
    debug:           { error: () => {} },
    waitUntil:       work => { background.push(work); },
    // a slow machine must not time a value out of the fixture
    deadlineMs:      60_000,
  };

  // one request: the clock reads `at`, and the node answers with `block` and reverts the prices `failing` names
  const request = async (at: string, block: BlockRef, failing: string[]) => {
    now       = new Date(at);
    latest    = block;
    reverting = failing;
    const view = await collateralView(deps, { chainId: 1, network: 'ethereum-mainnet', positions, versionId: snapshot.registryVersion.id });
    // what the request left to waitUntil, the minute's KV write among it, is done before the next one
    await Promise.all(background);
    return view;
  };

  await request('2026-10-05T12:52:12.000Z', { number: 23_500_107, timestamp: 1_791_204_731 }, [ 'usdc:tBTC' ]);
  await request('2026-10-05T12:55:12.000Z', { number: 23_500_122, timestamp: 1_791_204_911 }, [ 'usdc:tBTC', 'weth:wstETH', 'wbtc:LBTC' ]);
  const view = await request(COMPUTED_AT.toISOString(), { number: 23_500_123, timestamp: 1_791_204_923 }, [ 'usdc:tBTC', 'weth:wstETH', 'wbtc:LBTC' ]);

  const answered = tokenList({
    registryVersion: { id: catalog.versionId, checksum: catalog.checksum },
    chainId:         1,
    catalog,
    network:         'ethereum-mainnet',
    positions,
    view,
    strategic:       new Set<Address>([ COMP, WBTC ]),
    now,
  });
  /*
   * After a deliberate change of the contract, the fixture is written again
   * from the scenario — `npm run build && WRITE_TOKEN_LIST_FIXTURE=1 node
   * dist/tests/lib/registry/token-list-v1-fixture.test.js` — and its diff is
   * reviewed with the frontend developer before it is committed.
   */
  if (process.env.WRITE_TOKEN_LIST_FIXTURE === '1') {
    writeFileSync(FIXTURE_PATH, JSON.stringify(answered, null, 2) + '\n');
  }
  // strictly: t.same would take a number for the string that writes it, and a value's type is part of the contract
  t.strictSame(JSON.parse(JSON.stringify(answered)), list, 'the list the code answers is the fixture, value for value');
});
