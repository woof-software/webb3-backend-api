import t from 'tap';

import { RegistryError, RegistryErrorCode, isTransportFailure } from '../../../src/registry/errors.js';
import { ERROR_STATUS } from '../../../src/registry/router.js';

/*
 * Which failures a root's five attempts are spent on.
 *
 * The line is whether the failure says anything about the root. A source or a
 * provider that did not answer, and a Worker that ran out of what it is
 * given, say nothing: the same work was interrupted. A document that does not
 * parse, or a contract that is not deployed, will say the same thing next
 * time and is worth an attempt.
 */
t.test('a carrier that did not answer is not the root being wrong', async t => {
  for (const code of [ 'CHAIN_REQUEST_FAILED', 'SOURCE_REQUEST_FAILED' ] as const) {
    t.equal(isTransportFailure(new RegistryError(code, 'did not answer')), true, `${code} is the carrier`);
  }

  for (const message of [
    'Too many subrequests.',
    'Worker exceeded CPU time limit.',
    'network connection lost',
    'fetch failed',
    'The request timed out',
  ]) {
    t.equal(isTransportFailure(new Error(message)), true, `"${message}" is the carrier`);
  }
});

t.test('what the source or the chain said about the root is the root', async t => {
  for (const code of [
    'ROOT_DOCUMENT_INVALID',
    'ROOT_NETWORK_UNSUPPORTED',
    'ROOT_DUPLICATE',
    'CHAIN_CONTRACT_MISSING',
    'CHAIN_CALL_REVERTED',
    'CHAIN_RESPONSE_INVALID',
    'SOURCE_CONTENT_TOO_LARGE',
    'SOURCE_COMMIT_UNREACHABLE',
  ] as const) {
    t.equal(isTransportFailure(new RegistryError(code, 'about the root')), false, `${code} is worth an attempt`);
  }

  t.equal(isTransportFailure(new Error('no such column: markets.slug')), false,
    'and so is a programming error, which must not look like a hiccup');
  t.equal(isTransportFailure('not an error at all'), false);
});

/*
 * A carrier failure gives the root its attempt back, so a code that joins
 * the set, or a new code, has to be decided here: ERROR_STATUS names every
 * code there is.
 */
t.test('only the source and the node provider not answering are the carrier', async t => {
  const carriers = Object.keys(ERROR_STATUS)
    .filter(code => isTransportFailure(new RegistryError(code as RegistryErrorCode, 'x')))
    .sort();
  t.same(carriers, [ 'CHAIN_REQUEST_FAILED', 'SOURCE_REQUEST_FAILED' ]);
});
