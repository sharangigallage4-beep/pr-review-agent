import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { requestReview } from './claudeClient.js';
import type Anthropic from '@anthropic-ai/sdk';

// A fake shaped just enough like the Anthropic client for requestReview's own use of it -
// client.messages.create(...) - no network, no ANTHROPIC_API_KEY needed.
function fakeClient(create: (params: unknown) => Promise<unknown>): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

const baseParams = { systemPrompt: 'system', userMessage: 'user', model: 'claude-sonnet-5' };

describe('requestReview', () => {
  test('returns the submit_review tool call input on a normal response', async () => {
    const client = fakeClient(async () => ({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'submit_review', input: { summary: 'ok', issues: [] } }],
    }));

    const result = await requestReview(baseParams, client);
    assert.deepEqual(result, { summary: 'ok', issues: [] });
  });

  test('throws a specific, diagnosable error when the response was cut off by max_tokens - rather than a generic "no tool call" error', async () => {
    const client = fakeClient(async () => ({
      stop_reason: 'max_tokens',
      // A real truncated response often has no tool_use block at all, or an incomplete one -
      // either way, stop_reason alone must be enough to trigger the specific error.
      content: [],
    }));

    await assert.rejects(() => requestReview(baseParams, client), /cut off by the max_tokens limit/);
  });

  test('throws a generic error when no submit_review tool call is present for any other reason', async () => {
    const client = fakeClient(async () => ({ stop_reason: 'end_turn', content: [] }));

    await assert.rejects(() => requestReview(baseParams, client), /did not return a submit_review tool call/);
  });
});
