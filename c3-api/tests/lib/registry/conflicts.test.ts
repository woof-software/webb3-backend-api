import t from 'tap';

import { readFileSync } from 'node:fs';

import { failureResponse } from '../../../src/http/errors.js';
import { conflict } from '../../../src/registry/errors.js';
import { asApiError } from '../../../src/registry/router.js';

import { sourceFiles } from '../../util/sources.js';

/*
 * A 409 of the registry names the conflict it met in `details.code`, which is
 * what a script matches: the message is for a person, and may change. API.md
 * lists the codes, and the runbook says what to do about each.
 */
t.test('a conflict is answered as CONFLICT, naming itself beside the details the route gives', async t => {
  const message = 'the overlay of market 1/usdc is no longer the one this was decided against; read it again';
  const thrown  = conflict('OVERLAY_CHANGED', message, { current: { 'market 1/usdc': null } });

  const response = failureResponse(asApiError(thrown), thrown, {
    requestId: 'request-1',
    pathname:  '/registry/v1/admin/versions/v/markets/1/usdc/overlay',
    debug:     { error: () => undefined, warn: () => undefined },
    label:     'registry route',
  });
  t.equal(response.status, 409);
  t.same(await response.json(), {
    error: {
      code:      'CONFLICT',
      message,
      requestId: 'request-1',
      details:   { code: 'OVERLAY_CHANGED', current: { 'market 1/usdc': null } },
    },
  }, 'in the envelope every error takes');
});

/*
 * That holds only while no route builds a 409 of its own: one that did would
 * leave a script nothing to match but the message.
 */
t.test('no route answers CONFLICT without naming the conflict', async t => {
  const sources = sourceFiles();
  t.ok(sources.length > 200, 'every source file is read');
  const building = sources.filter(path => /ApiError\(\s*'CONFLICT'/.test(readFileSync(path, 'utf8')));
  t.same(building, [ 'src/registry/errors.ts' ], 'only conflict() builds one');
});
