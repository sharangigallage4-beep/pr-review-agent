import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubServiceError, toGitHubServiceError } from './errors.js';

describe('GitHubServiceError', () => {
  test('never carries the original caught error as `cause`', () => {
    // Security regression test: `cause` (via the ES2022 Error constructor option) is an
    // enumerable own property, so it would survive a naive JSON.stringify(err)/console.log(err)
    // even though nothing normally reads it - a future accidental log of the raw error could
    // then surface whatever the original error was carrying. GitHubServiceError must never
    // attach one, for any input.
    const original = new Error('boom') as Error & { request?: unknown };
    original.request = { headers: { Authorization: 'token super-secret-value' } };

    const wrapped = toGitHubServiceError(original);

    assert.equal('cause' in wrapped, false);
    assert.equal(JSON.stringify(wrapped).includes('super-secret-value'), false);
    assert.equal(JSON.stringify({ ...wrapped, message: wrapped.message }).includes('super-secret-value'), false);
  });

  test('a directly-constructed GitHubServiceError also never accepts a cause option', () => {
    const err = new GitHubServiceError('some message', { status: 404 });
    assert.equal('cause' in err, false);
  });

  test('toGitHubServiceError only ever produces status/message/documentationUrl/details - nothing else', () => {
    const original = new Error('boom') as Error & { headers?: unknown };
    original.headers = { Authorization: 'token super-secret-value' };

    const wrapped = toGitHubServiceError(original);
    const ownKeys = Object.getOwnPropertyNames(wrapped).sort();

    // Error instances always carry `message`/`stack`/`name` besides whatever this class adds -
    // the point is that `headers`/`request`/`response` (or anything else off the original) are
    // never copied onto the safe wrapper.
    for (const forbidden of ['headers', 'request', 'response', 'cause']) {
      assert.equal(ownKeys.includes(forbidden), false, `GitHubServiceError must never have a "${forbidden}" property`);
    }
  });
});
