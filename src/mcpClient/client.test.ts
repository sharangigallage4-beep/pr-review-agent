import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractText, sanitizeEnv, toMcpCallError } from './client.js';

// Unit tests for the pure logic in client.ts - parsing/sanitization that doesn't require a real
// subprocess. The actual spawn-and-connect behavior (connectMcpClient) was verified live: running
// `node --import tsx src/cli/autoReview.ts` shows the real MCP server subprocess starting,
// real "[mcp] -> tool_name" invocation logs, and a real Octokit HTTP request - a fake transport
// couldn't meaningfully re-prove any of that, so it's exercised for real instead of mocked here.

describe('extractText', () => {
  test('returns the text of the first text-type content block', () => {
    const result = { content: [{ type: 'text', text: '{"ok":true}' }] };
    assert.equal(extractText(result), '{"ok":true}');
  });

  test('returns an empty string when there is no content array', () => {
    assert.equal(extractText({}), '');
  });

  test('returns an empty string when no block has type "text"', () => {
    assert.equal(extractText({ content: [{ type: 'image', data: 'abc' }] }), '');
  });
});

describe('sanitizeEnv', () => {
  test('keeps string values and drops undefined ones', () => {
    const result = sanitizeEnv({ GITHUB_TOKEN: 'abc', UNSET: undefined, PORT: '4300' });
    assert.deepEqual(result, { GITHUB_TOKEN: 'abc', PORT: '4300' });
  });
});

describe('toMcpCallError', () => {
  test('extracts message and status from a well-formed tool error payload', () => {
    const err = toMcpCallError('get_pull_request', JSON.stringify({ error: true, message: 'Not Found', status: 404 }));
    assert.equal(err.message, 'Not Found');
    assert.equal(err.status, 404);
  });

  test('falls back to a generic message when the payload has no message field', () => {
    const err = toMcpCallError('get_pull_request', JSON.stringify({ status: 500 }));
    assert.match(err.message, /get_pull_request/);
    assert.equal(err.status, 500);
  });

  test('falls back to the raw text when the payload is not JSON', () => {
    const err = toMcpCallError('get_pull_request', 'plain text failure');
    assert.equal(err.message, 'plain text failure');
    assert.equal(err.status, undefined);
  });

  test('never surfaces anything beyond status/message, even if the payload had more', () => {
    const err = toMcpCallError(
      'get_pull_request',
      JSON.stringify({ message: 'Bad credentials', status: 401, documentation_url: 'https://docs.github.com', details: ['x'] })
    );
    const ownKeys = Object.getOwnPropertyNames(err);
    assert.equal(ownKeys.includes('documentation_url'), false);
    assert.equal(ownKeys.includes('details'), false);
  });
});
