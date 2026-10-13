import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConventionError, MAX_CONVENTION_CHARS, deleteConventionDoc, listConventionDocs, saveConventionDoc } from './conventionsStore.js';

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'conv-store-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('conventionsStore', () => {
  test('lists documents with their scope and rule count, ignoring non-markdown files', () =>
    withDir((dir) => {
      writeFileSync(path.join(dir, 'b.md'), '<!-- applies-to: .projection, .client -->\n# B\n- NM1. First.\n- NM2. Second.\n');
      writeFileSync(path.join(dir, 'a.md'), '# A\nno rules here');
      writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
      const docs = listConventionDocs(dir);
      assert.deepEqual(docs.map((d) => d.name), ['a.md', 'b.md']);
      assert.deepEqual(docs[1].appliesTo, ['.projection', '.client']);
      assert.equal(docs[1].ruleCount, 2);
      assert.equal(docs[0].appliesTo, null);
    }));

  test('a missing folder is an empty list', () => {
    assert.deepEqual(listConventionDocs(path.join(tmpdir(), 'nope-nope-nope')), []);
  });

  test('saves a new document and overwrites an existing one, without leaving temp files', () =>
    withDir((dir) => {
      saveConventionDoc(dir, 'rules.md', '# one\n- X1. a');
      const saved = saveConventionDoc(dir, 'rules.md', '# two\n- X1. a\n- X2. b');
      assert.equal(saved.ruleCount, 2);
      assert.equal(readFileSync(path.join(dir, 'rules.md'), 'utf8'), '# two\n- X1. a\n- X2. b');
      assert.deepEqual(readdirSync(dir), ['rules.md']);
    }));

  test('rejects names that could escape the folder or are not markdown', () =>
    withDir((dir) => {
      for (const bad of ['../evil.md', 'a/b.md', '..\\evil.md', 'rules.txt', '.hidden.md', '', 'a b.md', `${'x'.repeat(80)}.md`]) {
        assert.throws(() => saveConventionDoc(dir, bad, 'content'), ConventionError, JSON.stringify(bad));
        assert.throws(() => deleteConventionDoc(dir, bad), ConventionError, JSON.stringify(bad));
      }
      assert.deepEqual(readdirSync(dir), []);
    }));

  test('rejects empty and oversized documents', () =>
    withDir((dir) => {
      assert.throws(() => saveConventionDoc(dir, 'a.md', '   \n'), /empty/);
      assert.throws(() => saveConventionDoc(dir, 'a.md', 'x'.repeat(MAX_CONVENTION_CHARS + 1)), /too long/);
    }));

  test('deletes a document, and reports a missing one', () =>
    withDir((dir) => {
      saveConventionDoc(dir, 'gone.md', 'x');
      assert.equal(deleteConventionDoc(dir, 'gone.md'), true);
      assert.equal(existsSync(path.join(dir, 'gone.md')), false);
      assert.equal(deleteConventionDoc(dir, 'gone.md'), false);
    }));
});

describe('the documents shipped in docs/conventions', () => {
  const shipped = listConventionDocs(path.join(import.meta.dirname, '..', '..', 'docs', 'conventions'));

  test('every document has numbered rules, and no rule number is used twice across documents', () => {
    assert.ok(shipped.length >= 1, 'the shipped documents were found');
    const seen = new Map<string, string>();
    for (const doc of shipped) {
      assert.ok(doc.ruleCount > 0, `${doc.name} has numbered rules`);
      for (const match of doc.content.matchAll(/^\s*-\s+([A-Z]{1,3}\d+)\./gm)) {
        const id = match[1];
        assert.equal(seen.get(id), undefined, `${id} appears in both ${seen.get(id)} and ${doc.name}`);
        seen.set(id, doc.name);
      }
    }
  });

  test('each document is scoped to file types, so one stack never loads another stack rules', () => {
    for (const doc of shipped) assert.ok(doc.appliesTo && doc.appliesTo.length > 0, `${doc.name} needs an applies-to line`);
  });
});

