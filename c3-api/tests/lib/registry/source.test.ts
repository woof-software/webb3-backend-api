import t from 'tap';

import { readFileSync } from 'node:fs';

import {
  assertReachableFromRef,
  gitBlobSha,
  listRootPaths,
  normalizeRepository,
  readRoot,
  resolveRef,
} from '../../../src/registry/source/github.js';
import {
  parseDeploymentPath,
  parseRoot,
  sourceChecksum,
} from '../../../src/registry/source/roots.js';
import { isRegistryError } from '../../../src/registry/errors.js';

/*
 * The pinned source adapter and roots parser, against fixtures captured from
 * Compound-Foundation/comet at commit a34d9b5: four real roots.json documents
 * and the tree entries that list them, including their git object ids.
 *
 * No test reaches the network: every request is answered by a stub, which is
 * also how a failing or hostile upstream response is exercised.
 */
const FIXTURES   = './tests/fixtures/registry/source';
const COMMIT_SHA = 'a34d9b571c833b5d77f052ab8e2dbdbe10df726d';
const REPOSITORY = 'Compound-Foundation/comet';

type TreeFixture = {
  tree: Array<{ path: string, type: string, sha: string, size: number }>,
};

const tree: TreeFixture = JSON.parse(readFileSync(`${FIXTURES}/tree.json`, 'utf8'));

function rootContent(deployment: string): string {
  return readFileSync(`${FIXTURES}/roots/${deployment}.json`, 'utf8');
}

function treeEntry(rootPath: string) {
  const entry = tree.tree.find(candidate => candidate.path === rootPath);
  if (entry === undefined) {
    throw new Error(`fixture tree has no entry for ${rootPath}`);
  }
  return entry;
}

function pathOf(rootPath: string) {
  return { ...parseDeploymentPath(rootPath), sourceBlobSha: treeEntry(rootPath).sha };
}

/*
 * A fetch stub. Each entry answers one URL; a request to any other URL fails
 * the test, so an adapter that calls an unexpected endpoint cannot pass.
 */
type Answer = { status?: number, body: string, headers?: Record<string, string> };

function stubFetch(answers: Record<string, Answer | (() => Answer)>) {
  const requested: string[] = [];
  const fetch = async (url: string) => {
    requested.push(url);
    const answer = answers[url];
    if (answer === undefined) {
      throw new Error(`unexpected request: ${url}`);
    }
    const { status = 200, body, headers } = typeof(answer) === 'function' ? answer() : answer;
    return new Response(body, headers === undefined ? { status } : { status, headers });
  };
  return { fetch, requested };
}

function config(answers: Record<string, Answer | (() => Answer)>, overrides: { ref?: string, token?: string } = {}) {
  const { fetch, requested } = stubFetch(answers);
  return {
    config: { repository: REPOSITORY, ref: overrides.ref ?? 'main', ...overrides, fetch },
    requested,
  };
}

const commitsUrl = (ref: string) => `https://api.github.com/repos/compound-foundation/comet/commits/${encodeURIComponent(ref)}`;
const compareUrl = (sha: string, ref: string) => `https://api.github.com/repos/compound-foundation/comet/compare/${sha}...${encodeURIComponent(ref)}`;
const treeUrl    = (sha: string) => `https://api.github.com/repos/compound-foundation/comet/git/trees/${sha}?recursive=1`;
const rawUrl     = (sha: string, path: string) => `https://raw.githubusercontent.com/compound-foundation/comet/${sha}/${path}`;

async function rejects(operation: () => Promise<unknown>, code: string): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    if (!isRegistryError(error)) {
      throw error;
    }
    t.equal(error.code, code, `rejected with ${code}`);
    return error;
  }
  throw new Error(`expected ${code}, but the operation resolved`);
}

t.test('repository identity is case-insensitive and validated', async t => {
  t.equal(normalizeRepository('Compound-Foundation/comet'), 'compound-foundation/comet');
  t.equal(normalizeRepository('COMPOUND-FOUNDATION/COMET'), 'compound-foundation/comet');
  for (const invalid of [ 'comet', 'owner/', '/comet', 'owner/repo/extra', 'owner/repo name', '' ]) {
    await rejects(async () => normalizeRepository(invalid), 'SOURCE_CONFIGURATION_INVALID');
  }
});

t.test('a ref resolves to the commit it points at', async t => {
  const { config: source, requested } = config({ [commitsUrl('main')]: { body: `${COMMIT_SHA}\n` } });
  t.equal(await resolveRef(source), COMMIT_SHA, 'the resolved commit is returned');
  t.equal(requested.length, 1, 'one request resolves the ref');

  const missing = config({ [commitsUrl('nope')]: { status: 422, body: '{}' } }, { ref: 'nope' });
  await rejects(() => resolveRef(missing.config), 'SOURCE_REF_UNRESOLVED');

  const unavailable = config({ [commitsUrl('main')]: { status: 502, body: '{}' } });
  await rejects(() => resolveRef(unavailable.config), 'SOURCE_REQUEST_FAILED');

  const garbage = config({ [commitsUrl('main')]: { body: 'not-a-sha' } });
  await rejects(() => resolveRef(garbage.config), 'SOURCE_REF_UNRESOLVED');

  for (const ref of [ 'refs/heads/../evil', '', 'a'.repeat(200) ]) {
    const invalid = config({}, { ref });
    await rejects(() => resolveRef(invalid.config), 'SOURCE_CONFIGURATION_INVALID');
  }
});

t.test('an explicit commit must be reachable from the tracked ref', async t => {
  const other = 'b'.repeat(40);
  const ahead = config({ [compareUrl(COMMIT_SHA, 'main')]: { body: JSON.stringify({ status: 'ahead' }) } });
  await t.resolves(() => assertReachableFromRef(ahead.config, COMMIT_SHA), 'an ancestor commit is accepted');

  const identical = config({ [compareUrl(COMMIT_SHA, 'main')]: { body: JSON.stringify({ status: 'identical' }) } });
  await t.resolves(() => assertReachableFromRef(identical.config, COMMIT_SHA), 'the ref commit itself is accepted');

  // a commit of another fork of the network is readable, but not reachable
  for (const status of [ 'diverged', 'behind' ]) {
    const unreachable = config({ [compareUrl(other, 'main')]: { body: JSON.stringify({ status }) } });
    await rejects(() => assertReachableFromRef(unreachable.config, other), 'SOURCE_COMMIT_UNREACHABLE');
  }

  const unknown = config({ [compareUrl(other, 'main')]: { status: 404, body: '{}' } });
  await rejects(() => assertReachableFromRef(unknown.config, other), 'SOURCE_COMMIT_UNREACHABLE');

  const malformed = config({});
  await rejects(() => assertReachableFromRef(malformed.config, 'not-a-sha'), 'SOURCE_CONFIGURATION_INVALID');
});

t.test('the deployment tree lists supported roots only', async t => {
  const answers = { [treeUrl(COMMIT_SHA)]: { body: JSON.stringify(tree) } };
  const listed  = await listRootPaths(config(answers).config, COMMIT_SHA);
  t.same(listed.map(root => root.rootPath), [
    'deployments/arbitrum/usdc.e/roots.json',
    'deployments/base/usdc/roots.json',
    'deployments/mainnet/institutional_usdc/roots.json',
    'deployments/mainnet/usdc/roots.json',
  ], 'roots are returned in path order');
  t.same(
    listed.map(root => root.deploymentKey),
    [ 'usdc.e', 'usdc', 'institutional_usdc', 'usdc' ],
    'deployment keys keep the dots and underscores upstream uses',
  );
  t.equal(listed[0]!.sourceBlobSha, treeEntry(listed[0]!.rootPath).sha, 'each root carries its git object id');

  const withNoise = {
    sha:  COMMIT_SHA,
    tree: [
      ...tree.tree,
      // unsupported and test networks are skipped rather than failing the import
      { path: 'deployments/sepolia/usdc/roots.json', type: 'blob', sha: 'c'.repeat(40), size: 100 },
      { path: 'deployments/hardhat/usdc/roots.json', type: 'blob', sha: 'd'.repeat(40), size: 100 },
      // so is everything that is not a deployment root
      { path: 'deployments/mainnet/usdc/configuration.json', type: 'blob', sha: 'e'.repeat(40), size: 100 },
      { path: 'contracts/Comet.sol', type: 'blob', sha: 'f'.repeat(40), size: 100 },
      { path: 'deployments/mainnet/usdc', type: 'tree', sha: '0'.repeat(40), size: 0 },
    ],
  };
  const filtered = await listRootPaths(config({ [treeUrl(COMMIT_SHA)]: { body: JSON.stringify(withNoise) } }).config, COMMIT_SHA);
  t.equal(filtered.length, 4, 'unsupported networks and other files are skipped');

  const truncated = { [treeUrl(COMMIT_SHA)]: { body: JSON.stringify({ ...tree, truncated: true }) } };
  await rejects(() => listRootPaths(config(truncated).config, COMMIT_SHA), 'SOURCE_TREE_TRUNCATED');

  const empty = { [treeUrl(COMMIT_SHA)]: { body: JSON.stringify({ tree: [] }) } };
  await rejects(() => listRootPaths(config(empty).config, COMMIT_SHA), 'SOURCE_RESPONSE_INVALID');

  const notJson = { [treeUrl(COMMIT_SHA)]: { body: 'nope' } };
  await rejects(() => listRootPaths(config(notJson).config, COMMIT_SHA), 'SOURCE_RESPONSE_INVALID');

  const oversized = {
    [treeUrl(COMMIT_SHA)]: { body: JSON.stringify(tree), headers: { 'content-length': String(64 * 1024 * 1024) } },
  };
  await rejects(() => listRootPaths(config(oversized).config, COMMIT_SHA), 'SOURCE_CONTENT_TOO_LARGE');

  const malformedPath = {
    [treeUrl(COMMIT_SHA)]: {
      body: JSON.stringify({ tree: [ { path: 'deployments/mainnet/UPPER/roots.json', type: 'blob', sha: 'a'.repeat(40) } ] }),
    },
  };
  await rejects(() => listRootPaths(config(malformedPath).config, COMMIT_SHA), 'ROOT_PATH_INVALID');
});

t.test('a root is parsed only when it matches the pinned object id', async t => {
  const rootPath = 'deployments/mainnet/usdc/roots.json';
  const content  = rootContent('mainnet-usdc');
  const answers  = { [rawUrl(COMMIT_SHA, rootPath)]: { body: content } };

  const root = await readRoot(config(answers).config, COMMIT_SHA, pathOf(rootPath));
  t.equal(root.network, 'ethereum-mainnet', 'the upstream directory maps to a canonical network');
  t.equal(root.chainId, 1, 'the chain id comes from the well-known networks');
  t.equal(root.contracts.comet, '0xc3d688b66703497daa19211eedff47f25384cdc3', 'addresses are normalized lowercase');
  t.equal(root.contracts.bridge_receiver, undefined, 'an L1 market has no bridge receiver');
  t.ok(Object.keys(root.otherRoots).length > 10, 'bridge roots are kept out of the contract roles');
  t.equal(await gitBlobSha(content), treeEntry(rootPath).sha, 'the fixture hashes to its git object id');

  const tampered = { [rawUrl(COMMIT_SHA, rootPath)]: { body: content.replace('0xc3d688B66703497DAA19211EEdff47f25384cdc3', '0x' + 'a'.repeat(40)) } };
  await rejects(() => readRoot(config(tampered).config, COMMIT_SHA, pathOf(rootPath)), 'SOURCE_BLOB_MISMATCH');

  const arbitrum = await readRoot(
    config({ [rawUrl(COMMIT_SHA, 'deployments/arbitrum/usdc.e/roots.json')]: { body: rootContent('arbitrum-usdc.e') } }).config,
    COMMIT_SHA,
    pathOf('deployments/arbitrum/usdc.e/roots.json'),
  );
  t.equal(arbitrum.chainId, 42161);
  t.equal(arbitrum.deploymentKey, 'usdc.e', 'a dotted deployment key survives parsing');
  t.equal(arbitrum.contracts.bridge_receiver, '0x42480c37b249e33aabaf4c22b20235656bd38068', 'an L2 market keeps its bridge receiver');

  // ciUSDCv3 declares four roles and is governed by a multisig, not a timelock
  const institutional = await readRoot(
    config({ [rawUrl(COMMIT_SHA, 'deployments/mainnet/institutional_usdc/roots.json')]: { body: rootContent('mainnet-institutional_usdc') } }).config,
    COMMIT_SHA,
    pathOf('deployments/mainnet/institutional_usdc/roots.json'),
  );
  t.same(Object.keys(institutional.contracts).sort(), [ 'bulker', 'comet', 'configurator', 'rewards' ]);
  t.same(institutional.otherRoots, {}, 'it declares nothing beyond its four roles');
});

t.test('malformed deployment paths and roots are rejected', async t => {
  for (const rootPath of [
    'deployments/mainnet/usdc/roots.json/extra',
    'deployments/mainnet/roots.json',
    'deployments//usdc/roots.json',
    'deployments/mainnet/US DC/roots.json',
    'other/mainnet/usdc/roots.json',
    'deployments/mainnet/usdc/configuration.json',
  ]) {
    await rejects(async () => parseDeploymentPath(rootPath), 'ROOT_PATH_INVALID');
  }
  await rejects(async () => parseDeploymentPath('deployments/sepolia/usdc/roots.json'), 'ROOT_NETWORK_UNSUPPORTED');

  const path = parseDeploymentPath('deployments/mainnet/usdc/roots.json');
  const blob = 'a'.repeat(40);
  for (const [ name, content ] of [
    [ 'not JSON',            '{' ],
    [ 'an array',            '[]' ],
    [ 'null',                'null' ],
    [ 'empty',               '{}' ],
    [ 'a non-string value',  '{"comet":1}' ],
    [ 'a malformed address', '{"comet":"0x1234"}' ],
    [ 'an unanchored address', '{"comet":"see 0xc3d688B66703497DAA19211EEdff47f25384cdc3 for details"}' ],
    [ 'a malformed key',     '{"comet":"0xc3d688B66703497DAA19211EEdff47f25384cdc3","2bad":"0xc3d688B66703497DAA19211EEdff47f25384cdc3"}' ],
    [ 'no comet',            '{"configurator":"0xc3d688B66703497DAA19211EEdff47f25384cdc3"}' ],
  ] as const) {
    await rejects(() => parseRoot(path, content, blob), 'ROOT_DOCUMENT_INVALID');
    t.pass(`${name} is rejected`);
  }

  const oversized = JSON.stringify(
    Object.fromEntries([ ...Array(300).keys() ].map(index => [ `key${index}`, '0x' + index.toString(16).padStart(40, '0') ]))
  );
  await rejects(() => parseRoot(path, oversized, blob), 'ROOT_DOCUMENT_INVALID');
});

t.test('the source checksum depends on content, not on order', async t => {
  const paths = [
    'deployments/mainnet/usdc/roots.json',
    'deployments/arbitrum/usdc.e/roots.json',
    'deployments/base/usdc/roots.json',
  ];
  const fixtures = [ 'mainnet-usdc', 'arbitrum-usdc.e', 'base-usdc' ];
  const roots = await Promise.all(paths.map((rootPath, index) => parseRoot(
    parseDeploymentPath(rootPath),
    rootContent(fixtures[index]!),
    treeEntry(rootPath).sha,
  )));

  const checksum = await sourceChecksum(roots);
  t.match(checksum, /^[0-9a-f]{64}$/, 'the checksum is a sha-256 digest');
  t.equal(await sourceChecksum([ ...roots ].reverse()), checksum, 'response order does not change it');
  t.equal(await sourceChecksum(roots), checksum, 'it is stable across calls');

  /*
   * The source checksum is taken over paths and git object ids, which are
   * content hashes: a changed roots.json upstream arrives with a different
   * object id, and readRoot refuses content that does not hash to it.
   */
  t.not(
    await sourceChecksum([ { ...roots[0]!, sourceBlobSha: 'b'.repeat(40) }, ...roots.slice(1) ]),
    checksum,
    'a changed roots file changes the checksum',
  );

  // the per-root checksum covers the document itself, including keys the
  // registry does not store, and is what each checkpoint records
  const renamed = await parseRoot(
    parseDeploymentPath(paths[0]!),
    rootContent('mainnet-usdc').replace('"bulker"', '"bulkerV2"'),
    treeEntry(paths[0]!).sha,
  );
  t.not(renamed.checksum, roots[0]!.checksum, 'renaming a root key changes that root\'s checksum');

  await rejects(() => sourceChecksum([ roots[0]!, roots[0]! ]), 'ROOT_DUPLICATE');
});
