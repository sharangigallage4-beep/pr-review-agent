import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ReviewStatusStore } from './reviewStatusStore.js';

describe('ReviewStatusStore', () => {
  test('a PR with no entries is never a duplicate', () => {
    const store = new ReviewStatusStore();
    assert.equal(store.isDuplicate('acme', 'widgets', 1, 'sha1'), false);
  });

  test('queued/in_progress/completed for the SAME commit SHA counts as a duplicate', () => {
    for (const mark of ['markQueued', 'markInProgress'] as const) {
      const store = new ReviewStatusStore();
      store[mark]('acme', 'widgets', 1, 'sha1');
      assert.equal(store.isDuplicate('acme', 'widgets', 1, 'sha1'), true);
    }

    const completedStore = new ReviewStatusStore();
    completedStore.markCompleted('acme', 'widgets', 1, 'sha1', 'posted');
    assert.equal(completedStore.isDuplicate('acme', 'widgets', 1, 'sha1'), true);
  });

  test('a DIFFERENT commit SHA for the same PR is never a duplicate', () => {
    const store = new ReviewStatusStore();
    store.markCompleted('acme', 'widgets', 1, 'sha1', 'posted');
    assert.equal(store.isDuplicate('acme', 'widgets', 1, 'sha2'), false);
  });

  test('a FAILED attempt for the same SHA is not treated as a duplicate - allows a retry', () => {
    const store = new ReviewStatusStore();
    store.markFailed('acme', 'widgets', 1, 'sha1', 'network error');
    assert.equal(store.isDuplicate('acme', 'widgets', 1, 'sha1'), false);
  });

  test('a different repository or PR number is never a duplicate, even with the same SHA', () => {
    const store = new ReviewStatusStore();
    store.markCompleted('acme', 'widgets', 1, 'sha1', 'posted');
    assert.equal(store.isDuplicate('acme', 'other-repo', 1, 'sha1'), false);
    assert.equal(store.isDuplicate('acme', 'widgets', 2, 'sha1'), false);
  });

  test('getStatus reflects the most recent transition, with an updatedAt timestamp', () => {
    const store = new ReviewStatusStore();
    store.markQueued('acme', 'widgets', 1, 'sha1');
    store.markInProgress('acme', 'widgets', 1, 'sha1');
    store.markCompleted('acme', 'widgets', 1, 'sha1', 'posted');

    const status = store.getStatus('acme', 'widgets', 1);
    assert.equal(status?.status, 'completed');
    assert.equal(status?.detail, 'posted');
    assert.equal(status?.commitSha, 'sha1');
    assert.equal(typeof status?.updatedAt, 'string');
    assert.ok(!Number.isNaN(Date.parse(status!.updatedAt)));
  });

  test('list() returns every tracked PR', () => {
    const store = new ReviewStatusStore();
    store.markQueued('acme', 'widgets', 1, 'sha1');
    store.markQueued('acme', 'widgets', 2, 'sha2');
    const all = store.list();
    assert.equal(all.length, 2);
    assert.deepEqual(
      all.map((e) => e.pullNumber).sort(),
      [1, 2]
    );
  });

  test('a new event for the same PR with a NEW commit SHA overwrites the old entry', () => {
    const store = new ReviewStatusStore();
    store.markCompleted('acme', 'widgets', 1, 'sha1', 'posted');
    store.markQueued('acme', 'widgets', 1, 'sha2');

    assert.equal(store.getStatus('acme', 'widgets', 1)?.commitSha, 'sha2');
    assert.equal(store.getStatus('acme', 'widgets', 1)?.status, 'queued');
    // and the old SHA is no longer tracked as anything - a stale duplicate check for it is moot.
    assert.equal(store.isDuplicate('acme', 'widgets', 1, 'sha1'), false);
  });
});
