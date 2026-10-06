import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConventions } from './conventions.js';
import { buildSystemPrompt } from './prompt.js';

function withDir(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'conv-'));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadConventions', () => {
  test('returns an empty string when the folder does not exist', () => {
    assert.equal(loadConventions(path.join(tmpdir(), 'definitely-not-here-xyz')), '');
  });

  test('joins only the .md files, in name order', () => {
    withDir({ 'b.md': 'second', 'a.md': 'first', 'notes.txt': 'ignored' }, (dir) => {
      const result = loadConventions(dir);
      assert.match(result, /first[\s\S]*second/);
      assert.equal(result.includes('ignored'), false);
    });
  });

  test('truncates output to PR_REVIEW_MAX_CONTEXT_CHARS', () => {
    withDir({ 'a.md': 'x'.repeat(500) }, (dir) => {
      process.env.PR_REVIEW_MAX_CONTEXT_CHARS = '100';
      try {
        const result = loadConventions(dir);
        assert.match(result, /conventions truncated/);
        assert.ok(result.length < 200);
      } finally {
        delete process.env.PR_REVIEW_MAX_CONTEXT_CHARS;
      }
    });
  });
});

describe('buildSystemPrompt with conventions', () => {
  test('is unchanged when there are no conventions', () => {
    assert.equal(buildSystemPrompt(''), buildSystemPrompt());
    assert.equal(buildSystemPrompt('   ').includes('TEAM CODING CONVENTIONS'), false);
  });

  test('appends the conventions and says they override the style-nitpick rule', () => {
    const prompt = buildSystemPrompt('- N1. Use camelCase.');
    assert.match(prompt, /TEAM CODING CONVENTIONS/);
    assert.match(prompt, /N1\. Use camelCase/);
    assert.match(prompt, /OVERRIDE/);
    assert.match(prompt, /cite the rule number/);
  });
});
