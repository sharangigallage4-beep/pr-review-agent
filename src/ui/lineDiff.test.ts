import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { unifiedDiff } from './lineDiff.js';
import { parsePatchLines } from '../workflow/ifsCheck.js';

/** Applies a unified diff to `oldText` - if the diff is right, this reproduces the new text. */
function applyPatch(oldText: string, patch: string): string {
  const old = oldText === '' ? [] : oldText.replace(/\r/g, '').split('\n');
  if (old[old.length - 1] === '') old.pop();
  const result: string[] = [];
  let cursor = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
    if (hunk) {
      const start = Number(hunk[2]) === 0 ? Number(hunk[1]) : Number(hunk[1]) - 1;
      while (cursor < start) result.push(old[cursor++]);
      inHunk = true;
    } else if (inHunk) {
      if (line[0] === '+') result.push(line.slice(1));
      else if (line[0] === '-') cursor += 1;
      else {
        result.push(old[cursor]);
        cursor += 1;
      }
    }
  }
  while (cursor < old.length) result.push(old[cursor++]);
  return result.join('\n') + (result.length ? '\n' : '');
}

const normalize = (text: string) => (text === '' ? '' : text.replace(/\r/g, '').replace(/\n?$/, '\n'));

describe('unifiedDiff', () => {
  test('identical text, including a line-ending-only change, gives no diff', () => {
    assert.equal(unifiedDiff('a\nb\nc\n', 'a\nb\nc\n'), '');
    assert.equal(unifiedDiff('a\nb\nc\n', 'a\r\nb\r\nc\r\n'), '');
    assert.equal(unifiedDiff('a\nb', 'a\nb\n'), '');
    assert.equal(unifiedDiff('', ''), '');
  });

  test('a new file is one all-added hunk starting at line 1', () => {
    assert.equal(unifiedDiff('', 'x\ny\n'), '@@ -0,0 +1,2 @@\n+x\n+y');
  });

  test('a one-line change keeps three lines of context and numbers the hunk correctly', () => {
    const old = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const next = old.replace('line10', 'LINE10');
    const patch = unifiedDiff(old, next);
    assert.equal(patch.split('\n')[0], '@@ -7,7 +7,7 @@');
    assert.ok(patch.includes('-line10\n+LINE10'));
    assert.equal(applyPatch(old, patch), next);
  });

  test('distant changes become separate hunks; close ones share a hunk', () => {
    const old = Array.from({ length: 40 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
    const far = old.replace('l3\n', 'X3\n').replace('l38\n', 'X38\n');
    assert.equal((unifiedDiff(old, far).match(/^@@/gm) ?? []).length, 2);
    const near = old.replace('l10\n', 'X10\n').replace('l13\n', 'X13\n');
    assert.equal((unifiedDiff(old, near).match(/^@@/gm) ?? []).length, 1);
  });

  test('deletions, insertions and mixed edits all reproduce the new text', () => {
    const cases: Array<[string, string]> = [
      ['a\nb\nc\nd\ne\n', 'a\nc\ne\n'],
      ['a\nc\ne\n', 'a\nb\nc\nd\ne\n'],
      ['one\ntwo\nthree\n', 'uno\ntwo\ntres\nextra\n'],
      ['x\n', 'y\n'],
      ['a\nb\n', ''],
      ['', 'a\nb\n'],
      ['same\nsame\nsame\n', 'same\nchanged\nsame\nsame\n'],
    ];
    for (const [old, next] of cases) assert.equal(applyPatch(old, unifiedDiff(old, next)), normalize(next), JSON.stringify([old, next]));
  });

  test('works on pseudo-random edits of a larger file', () => {
    let seed = 12345;
    const rand = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
    const old = Array.from({ length: 300 }, (_, i) => `row ${i} ${rand(5)}`);
    const next = [...old];
    for (let k = 0; k < 40; k += 1) {
      const at = rand(next.length);
      const action = rand(3);
      if (action === 0) next.splice(at, 1);
      else if (action === 1) next.splice(at, 0, `new ${k}`);
      else next[at] = `changed ${k}`;
    }
    const oldText = old.join('\n') + '\n';
    const newText = next.join('\n') + '\n';
    assert.equal(applyPatch(oldText, unifiedDiff(oldText, newText)), newText);
  });

  test('a huge difference falls back to replacing the changed middle instead of hanging', () => {
    const old = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n') + '\n';
    const next = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n') + '\n';
    const patch = unifiedDiff(old, next);
    assert.equal(applyPatch(old, patch), next);
    assert.equal(patch.split('\n').filter((l) => l.startsWith('-')).length, 3000);
  });

  test('the output is readable by the same patch parser the PR pipeline uses', () => {
    const patch = unifiedDiff('a\nb\nc\n', 'a\nB\nc\nd\n');
    const added = parsePatchLines(patch).filter((l) => l.added);
    assert.deepEqual(added.map((l) => [l.n, l.text]), [[2, 'B'], [4, 'd']]);
  });
});
