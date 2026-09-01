import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { processReviewEvent } from './processReviewEvent.js';
import { ReviewStatusStore } from './reviewStatusStore.js';
import type { ParsedPullRequestEvent } from './parsePullRequestEvent.js';
import type { WorkflowLogger } from '../workflow/logger.js';

const silentLogger: WorkflowLogger = { info: () => {}, warn: () => {}, error: () => {} };

const event: ParsedPullRequestEvent = { owner: 'acme', repo: 'widgets', pullNumber: 1, commitSha: 'sha1', action: 'opened' };

describe('processReviewEvent', () => {
  test('skips calling runReview when the commit SHA is already a duplicate', async () => {
    const statusStore = new ReviewStatusStore();
    statusStore.markCompleted('acme', 'widgets', 1, 'sha1', 'posted');

    let called = false;
    await processReviewEvent(event, {
      runReview: async () => {
        called = true;
        return { status: 'posted', reviewId: 1, reviewUrl: '', newCommentCount: 0, summaryOnlyCount: 0, totalFindings: 0 };
      },
      statusStore,
      logger: silentLogger,
    });

    assert.equal(called, false);
  });

  test('marks queued -> in_progress -> completed on a successful run, with the outcome status as detail', async () => {
    const statusStore = new ReviewStatusStore();
    await processReviewEvent(event, {
      runReview: async () => ({
        status: 'posted',
        reviewId: 1,
        reviewUrl: 'https://example.test/pr/1',
        newCommentCount: 2,
        summaryOnlyCount: 0,
        totalFindings: 2,
      }),
      statusStore,
      logger: silentLogger,
    });

    const status = statusStore.getStatus('acme', 'widgets', 1);
    assert.equal(status?.status, 'completed');
    assert.equal(status?.detail, 'posted');
    assert.equal(status?.commitSha, 'sha1');
  });

  test('retries a failed run and eventually marks completed if a later attempt succeeds', async () => {
    const statusStore = new ReviewStatusStore();
    let calls = 0;
    await processReviewEvent(event, {
      runReview: async () => {
        calls += 1;
        if (calls < 2) return { status: 'failed', stage: 'fetch', reason: 'transient network error' };
        return { status: 'posted', reviewId: 1, reviewUrl: '', newCommentCount: 0, summaryOnlyCount: 0, totalFindings: 0 };
      },
      statusStore,
      logger: silentLogger,
      retries: 2,
      retryDelayMs: 1,
    });

    assert.equal(calls, 2);
    assert.equal(statusStore.getStatus('acme', 'widgets', 1)?.status, 'completed');
  });

  test('marks failed with the original reason after every retry is exhausted, without leaking error internals', async () => {
    const statusStore = new ReviewStatusStore();
    let calls = 0;
    await processReviewEvent(event, {
      runReview: async () => {
        calls += 1;
        return { status: 'failed', stage: 'post', reason: 'GitHub API request failed.' };
      },
      statusStore,
      logger: silentLogger,
      retries: 1,
      retryDelayMs: 1,
    });

    assert.equal(calls, 2); // 1 initial attempt + 1 retry
    const status = statusStore.getStatus('acme', 'widgets', 1);
    assert.equal(status?.status, 'failed');
    assert.equal(status?.detail, 'GitHub API request failed.');
  });

  test('a thrown (non-outcome) error from runReview is also retried and safely captured', async () => {
    const statusStore = new ReviewStatusStore();
    await processReviewEvent(event, {
      runReview: async () => {
        const err = new Error('boom') as Error & { request?: unknown };
        err.request = { headers: { Authorization: 'token super-secret' } };
        throw err;
      },
      statusStore,
      logger: silentLogger,
      retries: 0,
      retryDelayMs: 1,
    });

    const status = statusStore.getStatus('acme', 'widgets', 1);
    assert.equal(status?.status, 'failed');
    assert.equal(status?.detail, 'boom');
    assert.equal(JSON.stringify(status).includes('super-secret'), false);
  });
});
