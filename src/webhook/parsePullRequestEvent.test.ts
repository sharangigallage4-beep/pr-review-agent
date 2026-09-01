import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePullRequestEvent } from './parsePullRequestEvent.js';

function payload(overrides: Partial<{ action: string; number: number; sha: string; owner: string; repo: string }> = {}) {
  return {
    action: overrides.action ?? 'opened',
    pull_request: { number: overrides.number ?? 42, head: { sha: overrides.sha ?? 'abc123' } },
    repository: { name: overrides.repo ?? 'widgets', owner: { login: overrides.owner ?? 'acme' } },
  };
}

describe('parsePullRequestEvent', () => {
  for (const action of ['opened', 'synchronize', 'reopened'] as const) {
    test(`handles pull_request.${action}`, () => {
      const result = parsePullRequestEvent('pull_request', payload({ action }));
      assert.deepEqual(result, {
        handled: true,
        event: { owner: 'acme', repo: 'widgets', pullNumber: 42, commitSha: 'abc123', action },
      });
    });
  }

  test('ignores an unrelated event type', () => {
    const result = parsePullRequestEvent('push', payload());
    assert.equal(result.handled, false);
    if (!result.handled) assert.match(result.reason, /push/);
  });

  test('ignores a pull_request action outside the handled set (e.g. closed)', () => {
    const result = parsePullRequestEvent('pull_request', payload({ action: 'closed' }));
    assert.equal(result.handled, false);
    if (!result.handled) assert.match(result.reason, /closed/);
  });

  test('ignores a missing event name', () => {
    const result = parsePullRequestEvent(undefined, payload());
    assert.equal(result.handled, false);
  });

  test('handles a non-object payload without throwing', () => {
    for (const bad of [null, undefined, 'a string', 42, []]) {
      const result = parsePullRequestEvent('pull_request', bad);
      assert.equal(result.handled, false);
    }
  });

  test('reports missing required fields instead of throwing', () => {
    const result = parsePullRequestEvent('pull_request', { action: 'opened' });
    assert.equal(result.handled, false);
    if (!result.handled) assert.match(result.reason, /missing/);
  });
});
