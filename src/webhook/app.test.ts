import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { buildWebhookApp } from './app.js';
import { ReviewStatusStore } from './reviewStatusStore.js';
import type { WorkflowLogger } from '../workflow/logger.js';

// Real HTTP tests against a live ephemeral server (app.listen(0)) using the platform's built-in
// fetch, rather than a request-mocking library - this is what actually exercises express.raw()
// capturing the true byte stream, header casing, etc. that a unit-level call into the route
// handler function would not.

const secret = 'test-webhook-secret';
const silentLogger: WorkflowLogger = { info: () => {}, warn: () => {}, error: () => {} };

function sign(body: string, withSecret: string = secret): string {
  return `sha256=${createHmac('sha256', withSecret).update(body).digest('hex')}`;
}

function pullRequestPayload(overrides: Partial<{ action: string; number: number; sha: string }> = {}) {
  return JSON.stringify({
    action: overrides.action ?? 'opened',
    pull_request: { number: overrides.number ?? 1, head: { sha: overrides.sha ?? 'sha1' } },
    repository: { name: 'widgets', owner: { login: 'acme' } },
  });
}

async function withServer<T>(
  options: Partial<Parameters<typeof buildWebhookApp>[0]> & { runReview?: Parameters<typeof buildWebhookApp>[0]['runReview'] },
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const app = buildWebhookApp({ webhookSecret: secret, logger: silentLogger, ...options });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('POST /webhooks/github - signature validation', () => {
  test('rejects a request with no signature header', async () => {
    await withServer({}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/webhooks/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request' },
        body: pullRequestPayload(),
      });
      assert.equal(res.status, 401);
    });
  });

  test('rejects a request signed with the wrong secret', async () => {
    await withServer({}, async (baseUrl) => {
      const body = pullRequestPayload();
      const res = await fetch(`${baseUrl}/webhooks/github`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'pull_request',
          'x-hub-signature-256': sign(body, 'a-different-secret'),
        },
        body,
      });
      assert.equal(res.status, 401);
    });
  });

  test('accepts a correctly signed request', async () => {
    await withServer({ runReview: async () => ({ status: 'posted', reviewId: 1, reviewUrl: '', newCommentCount: 0, summaryOnlyCount: 0, totalFindings: 0 }) }, async (baseUrl) => {
      const body = pullRequestPayload();
      const res = await fetch(`${baseUrl}/webhooks/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body) },
        body,
      });
      assert.equal(res.status, 202);
    });
  });
});

describe('POST /webhooks/github - event handling', () => {
  test('ignores a non-pull_request event with 200, without triggering a review', async () => {
    let called = false;
    await withServer(
      { runReview: async () => { called = true; return { status: 'posted', reviewId: 1, reviewUrl: '', newCommentCount: 0, summaryOnlyCount: 0, totalFindings: 0 }; } },
      async (baseUrl) => {
        const body = JSON.stringify({ zen: 'Keep it logically awesome.' });
        const res = await fetch(`${baseUrl}/webhooks/github`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) },
          body,
        });
        assert.equal(res.status, 200);
        const json = (await res.json()) as { ignored: boolean };
        assert.equal(json.ignored, true);
      }
    );
    assert.equal(called, false);
  });

  test('ignores a pull_request action outside opened/synchronize/reopened (e.g. closed)', async () => {
    let called = false;
    await withServer(
      { runReview: async () => { called = true; return { status: 'posted', reviewId: 1, reviewUrl: '', newCommentCount: 0, summaryOnlyCount: 0, totalFindings: 0 }; } },
      async (baseUrl) => {
        const body = pullRequestPayload({ action: 'closed' });
        const res = await fetch(`${baseUrl}/webhooks/github`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body) },
          body,
        });
        assert.equal(res.status, 200);
      }
    );
    assert.equal(called, false);
  });

  test('returns 202 immediately without waiting for the review to finish, then processes it asynchronously', async () => {
    let resolveReview: (() => void) | undefined;
    const reviewStarted = new Promise<void>((resolve) => {
      resolveReview = resolve;
    });
    const statusStore = new ReviewStatusStore();

    await withServer(
      {
        statusStore,
        runReview: async () => {
          resolveReview?.();
          await new Promise((r) => setTimeout(r, 50)); // simulate a slow Claude/GitHub round trip
          return { status: 'posted', reviewId: 1, reviewUrl: 'https://example.test/pr/1', newCommentCount: 1, summaryOnlyCount: 0, totalFindings: 1 };
        },
      },
      async (baseUrl) => {
        const body = pullRequestPayload();
        const start = Date.now();
        const res = await fetch(`${baseUrl}/webhooks/github`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body) },
          body,
        });
        const elapsedMs = Date.now() - start;

        assert.equal(res.status, 202);
        assert.ok(elapsedMs < 50, `expected the response before the 50ms review finished, took ${elapsedMs}ms`);

        await reviewStarted;
        await waitFor(() => statusStore.getStatus('acme', 'widgets', 1)?.status === 'completed');
        assert.equal(statusStore.getStatus('acme', 'widgets', 1)?.detail, 'posted');
      }
    );
  });
});

describe('GET /webhooks/status', () => {
  test('reflects a review that has already completed', async () => {
    const statusStore = new ReviewStatusStore();
    statusStore.markCompleted('acme', 'widgets', 1, 'sha1', 'posted');

    await withServer({ statusStore }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/webhooks/status`);
      assert.equal(res.status, 200);
      const json = (await res.json()) as { status: string; pullNumber: number }[];
      assert.equal(json.length, 1);
      assert.equal(json[0].status, 'completed');
      assert.equal(json[0].pullNumber, 1);
    });
  });
});

describe('duplicate commit SHA handling end to end', () => {
  test('a second webhook for the SAME commit SHA does not trigger a second review call', async () => {
    let callCount = 0;
    const statusStore = new ReviewStatusStore();

    await withServer(
      {
        statusStore,
        runReview: async () => {
          callCount += 1;
          await new Promise((r) => setTimeout(r, 20));
          return { status: 'posted', reviewId: 1, reviewUrl: '', newCommentCount: 0, summaryOnlyCount: 0, totalFindings: 0 };
        },
      },
      async (baseUrl) => {
        const body = pullRequestPayload({ sha: 'same-sha' });
        const headers = { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-hub-signature-256': sign(body) };

        await fetch(`${baseUrl}/webhooks/github`, { method: 'POST', headers, body });
        await waitFor(() => statusStore.getStatus('acme', 'widgets', 1)?.status === 'completed');

        // A second delivery of the exact same event (GitHub does redeliver) after completion.
        await fetch(`${baseUrl}/webhooks/github`, { method: 'POST', headers, body });
        await new Promise((r) => setTimeout(r, 30));

        assert.equal(callCount, 1);
      }
    );
  });
});
