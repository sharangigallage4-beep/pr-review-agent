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

describe('requestReview with a model that rejects a forced tool call', () => {
  const rejection = () =>
    Object.assign(
      new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}'),
      { status: 400 }
    );
  const toolUse = (input: unknown) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_review', input }] });

  test('retries with automatic tool choice and returns the tool call', async () => {
    const choices: string[] = [];
    const client = fakeClient(async (params) => {
      const choice = (params as { tool_choice: { type: string } }).tool_choice.type;
      choices.push(choice);
      if (choice === 'tool') throw rejection();
      return toolUse({ summary: 'ok', issues: [] });
    });
    const result = await requestReview({ ...baseParams, model: 'thinking-model-a' }, client);
    assert.deepEqual(result, { summary: 'ok', issues: [] });
    assert.deepEqual(choices, ['tool', 'auto']);
  });

  test('remembers the model, so later requests go straight to automatic tool choice', async () => {
    const choices: string[] = [];
    const client = fakeClient(async (params) => {
      const choice = (params as { tool_choice: { type: string } }).tool_choice.type;
      choices.push(choice);
      if (choice === 'tool') throw rejection();
      return toolUse({ summary: 'ok', issues: [] });
    });
    await requestReview({ ...baseParams, model: 'thinking-model-b' }, client);
    await requestReview({ ...baseParams, model: 'thinking-model-b' }, client);
    assert.deepEqual(choices, ['tool', 'auto', 'auto']);
  });

  test('a model that allows forced tool choice keeps getting it', async () => {
    const choices: string[] = [];
    const client = fakeClient(async (params) => {
      choices.push((params as { tool_choice: { type: string } }).tool_choice.type);
      return toolUse({ summary: 'ok', issues: [] });
    });
    await requestReview({ ...baseParams, model: 'plain-model' }, client);
    await requestReview({ ...baseParams, model: 'plain-model' }, client);
    assert.deepEqual(choices, ['tool', 'tool']);
  });

  test('other API errors are not swallowed by the fallback', async () => {
    let calls = 0;
    const client = fakeClient(async () => {
      calls += 1;
      throw Object.assign(new Error('401 {"error":{"type":"authentication_error","message":"invalid x-api-key"}}'), { status: 401 });
    });
    await assert.rejects(() => requestReview({ ...baseParams, model: 'model-c' }, client), /invalid x-api-key/);
    assert.equal(calls, 1);

    const overloaded = fakeClient(async () => {
      throw Object.assign(new Error('400 {"error":{"message":"max_tokens: too large"}}'), { status: 400 });
    });
    await assert.rejects(() => requestReview({ ...baseParams, model: 'model-d' }, overloaded), /max_tokens/);
  });

  test('automatic choice may answer in text: that shape is still accepted', async () => {
    const client = fakeClient(async (params) => {
      if ((params as { tool_choice: { type: string } }).tool_choice.type === 'tool') throw rejection();
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"name":"submit_review","arguments":{"summary":"s","issues":[]}}' }] };
    });
    assert.deepEqual(await requestReview({ ...baseParams, model: 'thinking-model-e' }, client), { summary: 's', issues: [] });
  });
});

describe('requestReview with an explicit provider', () => {
  const toolUse = (input: unknown) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_review', input }] });

  test('asks the provider\'s model, not the one from the environment', async () => {
    let model: unknown;
    const client = fakeClient(async (params) => {
      model = (params as { model: string }).model;
      return toolUse({ summary: 'ok', issues: [] });
    });
    await requestReview({ ...baseParams, model: 'from-env', provider: { id: 'claude', apiKey: 'k', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' } }, client);
    assert.equal(model, 'claude-sonnet-5-5');
  });
});

describe('requestReview usage reporting', () => {
  const ok = { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'submit_review', input: { summary: 'ok', issues: [] } }] };

  test('reports the tokens a response used, cache tokens included', async () => {
    const seen: unknown[] = [];
    const client = fakeClient(async () => ({ ...ok, usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 5, output_tokens: 40 } }));
    await requestReview({ ...baseParams, onUsage: (u) => seen.push(u) }, client);
    assert.deepEqual(seen, [{ inputTokens: 125, outputTokens: 40, model: 'claude-sonnet-5' }]);
  });

  test('a response cut off by max_tokens is still counted, since it was paid for', async () => {
    const seen: unknown[] = [];
    const client = fakeClient(async () => ({ stop_reason: 'max_tokens', content: [], usage: { input_tokens: 10, output_tokens: 16000 } }));
    await assert.rejects(() => requestReview({ ...baseParams, onUsage: (u) => seen.push(u) }, client), /max_tokens/);
    assert.equal(seen.length, 1);
  });

  test('a response without usage numbers (a local model) simply reports nothing', async () => {
    const seen: unknown[] = [];
    await requestReview({ ...baseParams, onUsage: (u) => seen.push(u) }, fakeClient(async () => ok));
    assert.deepEqual(seen, []);
  });
});
