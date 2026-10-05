import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { requestReview, parseTextToolCall } from './claudeClient.js';
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

describe('requestReview with a text-form tool call (small local models)', () => {
  const text = (t: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });

  test('accepts {"name":"submit_review","arguments":{...}} emitted as plain text', async () => {
    const client = fakeClient(async () =>
      text('{"name":"submit_review","arguments":{"summary":"ok","issues":[]}}')
    );
    assert.deepEqual(await requestReview(baseParams, client), { summary: 'ok', issues: [] });
  });

  test('a real tool_use block still takes priority over text', async () => {
    const client = fakeClient(async () => ({
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: '{"name":"submit_review","arguments":{"summary":"from text"}}' },
        { type: 'tool_use', name: 'submit_review', input: { summary: 'from tool' } },
      ],
    }));
    assert.deepEqual(await requestReview(baseParams, client), { summary: 'from tool' });
  });

  test('still throws the generic error when the text is not a tool call', async () => {
    const client = fakeClient(async () => text('Looks good to me!'));
    await assert.rejects(() => requestReview(baseParams, client), /did not return a submit_review tool call/);
  });
});

describe('parseTextToolCall', () => {
  const blocks = (t: string) => [{ type: 'text', text: t }] as unknown as Anthropic.ContentBlock[];

  test('handles a ```json fence and surrounding prose', () => {
    const t = 'Here you go:\n```json\n{"name":"submit_review","arguments":{"summary":"x"}}\n```';
    assert.deepEqual(parseTextToolCall(blocks(t)), { summary: 'x' });
  });

  test('handles arguments given as a JSON string', () => {
    const t = '{"name":"submit_review","arguments":"{\\"summary\\":\\"x\\"}"}';
    assert.deepEqual(parseTextToolCall(blocks(t)), { summary: 'x' });
  });

  test('accepts a bare arguments object with no wrapper', () => {
    assert.deepEqual(parseTextToolCall(blocks('{"summary":"x","issues":[]}')), { summary: 'x', issues: [] });
  });

  test('returns undefined for invalid JSON, other tool names, and empty content', () => {
    assert.equal(parseTextToolCall(blocks('{not json}')), undefined);
    assert.equal(parseTextToolCall(blocks('{"name":"other_tool","arguments":{"a":1}}')), undefined);
    assert.equal(parseTextToolCall([]), undefined);
  });
});
