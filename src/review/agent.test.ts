import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_AGENT_LIMITS, runAgent, type AgentLimits } from './agent.js';

const reviewTool = { name: 'submit_review', description: 'x', input_schema: { type: 'object' as const, properties: {} } };
const result = { summary: 'done', issues: [] };

const submit = (input: unknown = result) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 's1', name: 'submit_review', input }] }) as unknown as Anthropic.Message;
const read = (id: string, path: string, extra: Record<string, unknown> = {}) =>
  ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'read_file', input: { path, ...extra } }] }) as unknown as Anthropic.Message;
const text = (t: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] }) as unknown as Anthropic.Message;

interface Call {
  messages: Anthropic.MessageParam[];
  tools: string[];
  choice: string;
}

/** A model that answers from a script, recording what it was sent. */
function scripted(...answers: Anthropic.Message[]) {
  const calls: Call[] = [];
  const send = async (messages: Anthropic.MessageParam[], tools: Anthropic.Tool[], toolChoice: Anthropic.ToolChoice) => {
    calls.push({ messages: structuredClone(messages), tools: tools.map((t) => t.name), choice: toolChoice.type });
    const next = answers[calls.length - 1];
    if (!next) throw new Error('the model was asked more often than the script allows');
    return next;
  };
  return { send, calls };
}

const lastToolResult = (call: Call): string => {
  const last = call.messages[call.messages.length - 1];
  const blocks = last?.content as Array<{ type: string; content: string }>;
  return blocks.map((b) => b.content).join('\n');
};

describe('runAgent', () => {
  test('answers a file request, then returns the review the model submits', async () => {
    const files = new Map([['src/util.ts', 'export const a = 1;\nexport const b = 2;']]);
    const { send, calls } = scripted(read('r1', 'src/util.ts'), submit());
    const out = await runAgent({ send, userMessage: 'review', reviewTool, reviewToolName: 'submit_review', readFile: async (p) => files.get(p) });
    assert.deepEqual(out, result);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.tools, ['read_file', 'submit_review']);
    assert.equal(calls[0]?.choice, 'auto');
    assert.match(lastToolResult(calls[1] as Call), /File src\/util\.ts \(lines 1-2 of 2\)\.\n1: export const a = 1;\n2: export const b = 2;/);
  });

  test('submits at once when the diff was enough: one request, nothing read', async () => {
    const { send, calls } = scripted(submit());
    let reads = 0;
    await runAgent({ send, userMessage: 'review', reviewTool, reviewToolName: 'submit_review', readFile: async () => (reads += 1, undefined) });
    assert.deepEqual([calls.length, reads], [1, 0]);
  });

  test('a file that does not exist, and one that cannot be read, are explained to the model instead of failing the review', async () => {
    const { send, calls } = scripted(read('r1', 'nope.ts'), read('r2', 'broken.ts'), submit());
    await runAgent({
      send, userMessage: 'review', reviewTool, reviewToolName: 'submit_review',
      readFile: async (p) => { if (p === 'broken.ts') throw new Error('boom'); return undefined; },
    });
    assert.match(lastToolResult(calls[1] as Call), /nope\.ts was not found/);
    assert.match(lastToolResult(calls[2] as Call), /broken\.ts was not found/);
  });

  test('a line window is honoured, and a long file is cut with a note saying where to continue', async () => {
    const body = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
    const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, maxCharsPerRead: 60 };
    const { send, calls } = scripted(read('r1', 'a.ts', { startLine: 10, endLine: 12 }), read('r2', 'a.ts'), submit());
    await runAgent({ send, userMessage: 'review', reviewTool, reviewToolName: 'submit_review', readFile: async () => body, limits });
    assert.match(lastToolResult(calls[1] as Call), /lines 10-12 of 50\)\.\n10: line 10\n11: line 11\n12: line 12/);
    assert.match(lastToolResult(calls[2] as Call), /Output was cut at line \d+; ask again with startLine \d+/);
  });

  test('the number of reads is limited: past it the model is told to submit', async () => {
    const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, maxReads: 1 };
    const { send, calls } = scripted(read('r1', 'a.ts'), read('r2', 'b.ts'), submit());
    let reads = 0;
    await runAgent({ send, userMessage: 'review', reviewTool, reviewToolName: 'submit_review', readFile: async () => (reads += 1, 'x'), limits });
    assert.equal(reads, 1);
    assert.match(lastToolResult(calls[2] as Call), /limit of 1 file reads is reached/);
  });

  test('on the last turn the model may only submit, and is forced to', async () => {
    const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, maxTurns: 3 };
    const { send, calls } = scripted(read('r1', 'a.ts'), read('r2', 'b.ts'), submit());
    await runAgent({ send, userMessage: 'review', reviewTool, reviewToolName: 'submit_review', readFile: async () => 'x', limits });
    assert.deepEqual(calls.map((c) => c.choice), ['auto', 'auto', 'tool']);
    assert.deepEqual(calls[2]?.tools, ['submit_review']);
  });

  test('a model that never submits fails clearly instead of looping', async () => {
    const limits: AgentLimits = { ...DEFAULT_AGENT_LIMITS, maxTurns: 2 };
    const { send, calls } = scripted(read('r1', 'a.ts'), read('r2', 'b.ts'));
    await assert.rejects(
      () => runAgent({ send, userMessage: 'review', reviewTool, reviewToolName: 'submit_review', readFile: async () => 'x', limits }),
      /did not return a submit_review tool call/
    );
    assert.equal(calls.length, 2);
  });

  test('plain text is asked once more for the structured result; a text-form tool call is accepted', async () => {
    const asked = scripted(text('I looked at it and it is fine.'), submit());
    assert.deepEqual(await runAgent({ send: asked.send, userMessage: 'r', reviewTool, reviewToolName: 'submit_review', readFile: async () => undefined }), result);
    assert.match(String((asked.calls[1]?.messages.at(-1)?.content)), /Call submit_review now/);

    const inText = scripted(text('{"name":"submit_review","arguments":{"summary":"s","issues":[]}}'));
    assert.deepEqual(await runAgent({ send: inText.send, userMessage: 'r', reviewTool, reviewToolName: 'submit_review', readFile: async () => undefined }), { summary: 's', issues: [] });
  });

  test('an unknown tool is answered with an error result, and the loop goes on', async () => {
    const bad = { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x1', name: 'run_shell', input: { cmd: 'rm -rf /' } }] } as unknown as Anthropic.Message;
    const { send, calls } = scripted(bad, submit());
    await runAgent({ send, userMessage: 'r', reviewTool, reviewToolName: 'submit_review', readFile: async () => undefined });
    assert.match(lastToolResult(calls[1] as Call), /Unknown tool "run_shell"/);
  });

  test('a response cut off by max_tokens is an error, not a silent empty review', async () => {
    const cut = { stop_reason: 'max_tokens', content: [] } as unknown as Anthropic.Message;
    await assert.rejects(() => runAgent({ send: scripted(cut).send, userMessage: 'r', reviewTool, reviewToolName: 'submit_review', readFile: async () => undefined }), /max_tokens/);
  });

  test('the progress of each read is reported', async () => {
    const lines: string[] = [];
    await runAgent({
      send: scripted(read('r1', '/src/a.ts'), submit()).send, userMessage: 'r', reviewTool, reviewToolName: 'submit_review',
      readFile: async () => 'x', log: (m) => lines.push(m),
    });
    assert.deepEqual(lines, ['The AI is reading src/a.ts']);
  });
});
