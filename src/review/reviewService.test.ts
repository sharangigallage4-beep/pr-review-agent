import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPullRequest } from './reviewService.js';
import type { ReviewInput } from './types.js';

// No ANTHROPIC_API_KEY, no network, no GitHub - every test injects a fake requestReview and
// passes plain literal ReviewInput objects, proving the review engine is fully independent of
// both the Claude API transport and the GitHub/MCP layers.

const sampleInput: ReviewInput = {
  pullRequest: {
    repository: 'acme/widgets',
    number: 42,
    title: 'Fix checkout race condition',
    description: 'Adds a lock around the checkout critical section.',
    author: 'alice',
    baseRef: 'main',
    headRef: 'fix/checkout-race',
  },
  diff: '--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1,3 +1,3 @@\n-old\n+new\n',
  changedFiles: [{ filename: 'src/checkout.ts', status: 'modified', additions: 5, deletions: 2 }],
};

describe('reviewPullRequest', () => {
  test('returns validated findings when Claude responds with a well-formed result', async () => {
    const result = await reviewPullRequest(sampleInput, {
      requestReview: async () => ({
        summary: 'One race condition found in the checkout flow.',
        issues: [
          {
            severity: 'high',
            file: 'src/checkout.ts',
            line: 12,
            title: 'Unsynchronized read-modify-write on inventory count',
            explanation:
              'Two concurrent checkouts can both read the same stock count before either writes back, overselling by one unit.',
            suggestedFix: 'Wrap the read-modify-write in the existing InventoryLock.',
          },
        ],
      }),
    });

    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].severity, 'high');
    assert.equal(result.issues[0].file, 'src/checkout.ts');
  });

  test('returns an empty issues array when Claude finds nothing worth flagging', async () => {
    const result = await reviewPullRequest(sampleInput, {
      requestReview: async () => ({ summary: 'No problems found.', issues: [] }),
    });
    assert.deepEqual(result.issues, []);
  });

  test('passes the built system prompt and user message through to requestReview', async () => {
    let capturedSystemPrompt = '';
    let capturedUserMessage = '';

    await reviewPullRequest(sampleInput, {
      requestReview: async ({ systemPrompt, userMessage }) => {
        capturedSystemPrompt = systemPrompt;
        capturedUserMessage = userMessage;
        return { summary: 'ok', issues: [] };
      },
    });

    assert.match(capturedSystemPrompt, /senior software engineer/i);
    assert.match(capturedUserMessage, /acme\/widgets/);
    assert.match(capturedUserMessage, /Fix checkout race condition/);
  });

  test('rejects a result missing required fields instead of silently passing it through', async () => {
    await assert.rejects(
      () =>
        reviewPullRequest(sampleInput, {
          requestReview: async () => ({
            summary: 'Missing issue fields',
            issues: [{ severity: 'high', file: 'src/checkout.ts' /* missing line, title, explanation, suggestedFix */ }],
          }),
        }),
      /did not match the expected schema/
    );
  });

  test('rejects an invalid severity value', async () => {
    await assert.rejects(
      () =>
        reviewPullRequest(sampleInput, {
          requestReview: async () => ({
            summary: 'Bad severity',
            issues: [{ severity: 'urgent', file: 'a.ts', line: 1, title: 't', explanation: 'e', suggestedFix: 'f' }],
          }),
        }),
      /did not match the expected schema/
    );
  });

  test('rejects a non-object response (e.g. plain text Claude might return without tool forcing)', async () => {
    await assert.rejects(
      () => reviewPullRequest(sampleInput, { requestReview: async () => 'not json' }),
      /did not match the expected schema/
    );
  });
});
