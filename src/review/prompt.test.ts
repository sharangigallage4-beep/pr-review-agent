import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildUserMessage } from './prompt.js';
import type { ReviewInput } from './types.js';

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
  changedFiles: [
    { filename: 'src/checkout.ts', status: 'modified', additions: 5, deletions: 2, patch: '@@ -1,3 +1,3 @@' },
  ],
};

describe('buildSystemPrompt', () => {
  test('lists every required review category', () => {
    const prompt = buildSystemPrompt();
    for (const category of [
      'Bugs and incorrect logic',
      'Security vulnerabilities',
      'Runtime errors',
      'Breaking changes',
      'Incorrect API usage',
      'Performance problems',
      'Race conditions',
      'Bad/missing error handling',
      'Validation issues',
      'Authentication/authorization problems',
      'Database problems',
      'Important maintainability problems',
      'Potential edge cases',
    ]) {
      assert.ok(prompt.includes(category), `expected system prompt to mention "${category}"`);
    }
  });

  test('states the no-style-nits, no-duplicates, and no-unrelated-issues rules', () => {
    const prompt = buildSystemPrompt();
    assert.match(prompt, /personal style/i);
    assert.match(prompt, /duplicate/i);
    assert.match(prompt, /submit_review/);
    assert.match(prompt, /unrelated to the changed code/i);
    assert.match(prompt, /subjective suggestions/i);
  });

  test('requires findings to be actionable and reasonably confident, not speculative', () => {
    const prompt = buildSystemPrompt();
    assert.match(prompt, /actionable/i);
    assert.match(prompt, /reasonable level of confidence|confidence/i);
  });

  test('instructs analyzing only the changed code', () => {
    const prompt = buildSystemPrompt();
    assert.match(prompt, /only the changed code/i);
  });

  // Regression test: live testing found Claude reliably omitting the top-level "summary" field
  // (and occasionally stringifying "issues") despite both being marked required in the tool's
  // JSON schema alone - the schema's "required" wasn't being followed reliably in practice, so
  // the fix is an explicit instruction here. See also the "REQUIRED" field descriptions added to
  // buildReviewTool() in claudeClient.ts - this is deliberately reinforced in two places.
  test('explicitly requires both summary and issues to always be present', () => {
    const prompt = buildSystemPrompt();
    assert.match(prompt, /summary.{0,40}REQUIRED|REQUIRED.{0,40}summary/is);
    assert.match(prompt, /never omit/i);
  });

  // Security regression test: PR title/description/diff/code content is untrusted, attacker-
  // reachable input (any contributor, including anonymous forks) - the system prompt must tell
  // Claude to treat it strictly as data to review, never as instructions to follow.
  test('warns that PR content is untrusted and must never be treated as instructions', () => {
    const prompt = buildSystemPrompt();
    assert.match(prompt, /untrusted/i);
    assert.match(prompt, /ignore previous instructions/i);
    assert.match(prompt, /never as instructions|not as instructions/i);
  });
});

describe('buildUserMessage', () => {
  test('includes PR metadata, changed files, and the diff', () => {
    const message = buildUserMessage(sampleInput);
    assert.match(message, /acme\/widgets/);
    assert.match(message, /PR #42/);
    assert.match(message, /Fix checkout race condition/);
    assert.match(message, /alice/);
    assert.match(message, /main/);
    assert.match(message, /fix\/checkout-race/);
    assert.match(message, /src\/checkout\.ts/);
    assert.match(message, /-old\n\+new/);
  });

  test('falls back to a placeholder when the description is empty', () => {
    const message = buildUserMessage({ ...sampleInput, pullRequest: { ...sampleInput.pullRequest, description: '' } });
    assert.match(message, /no description provided/);
  });

  test('omits the file-contents section when none are given', () => {
    const message = buildUserMessage(sampleInput);
    assert.equal(message.includes('Relevant file contents'), false);
  });

  test('includes a file-contents section when provided', () => {
    const message = buildUserMessage({
      ...sampleInput,
      fileContents: [{ path: 'src/checkout.ts', content: 'export function checkout() {}' }],
    });
    assert.match(message, /Relevant file contents/);
    assert.match(message, /export function checkout/);
  });

  test('marks the PR title and description as untrusted content', () => {
    const message = buildUserMessage(sampleInput);
    assert.match(message, /title \(untrusted\)/i);
    assert.match(message, /Description \(untrusted/i);
  });
});
