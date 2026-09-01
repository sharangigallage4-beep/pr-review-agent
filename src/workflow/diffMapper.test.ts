import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFileDiff, mapLineToDiffPosition } from './diffMapper.js';

// @@ -10,4 +10,6 @@                position  old  new
//  context line A                     2       10   10
// +added line one                     3        -   11
// +added line two                     4        -   12
//  context line B                     5       11   13
// -removed line                       6       12    -
//  context line C                     7       13   14
//
// Position 1 is the "@@ ... @@" header line itself (not pushed as an entry) - every body line's
// position is one more than its plain top-to-bottom order for that reason.
const samplePatch = [
  '@@ -10,4 +10,6 @@',
  ' context line A',
  '+added line one',
  '+added line two',
  ' context line B',
  '-removed line',
  ' context line C',
].join('\n');

describe('parseFileDiff', () => {
  test('returns an empty map for a null/undefined/empty patch', () => {
    for (const patch of [null, undefined, '']) {
      const result = parseFileDiff(patch);
      assert.deepEqual(result.entries, []);
      assert.equal(result.byNewLine.size, 0);
      assert.equal(result.byOldLine.size, 0);
    }
  });

  test('assigns correct old/new line numbers to context, added, and removed lines', () => {
    const diff = parseFileDiff(samplePatch);

    assert.equal(diff.byNewLine.get(10)?.type, 'context');
    assert.equal(diff.byOldLine.get(10)?.type, 'context');

    // An added line exists only on the new side - it has no old-file line number at all.
    assert.equal(diff.byNewLine.get(11)?.type, 'add');
    assert.equal(diff.byNewLine.get(11)?.oldLine, null);

    assert.equal(diff.byNewLine.get(12)?.type, 'add');
    assert.equal(diff.byNewLine.get(12)?.oldLine, null);

    // "context line B" is old line 11, new line 13 (shifted down by the two additions above it).
    assert.equal(diff.byOldLine.get(11)?.type, 'context');
    assert.equal(diff.byNewLine.get(13)?.type, 'context');

    // A removed line exists only on the old side - it has no new-file line number at all.
    assert.equal(diff.byOldLine.get(12)?.type, 'del');
    assert.equal(diff.byOldLine.get(12)?.newLine, null);

    assert.equal(diff.byNewLine.get(14)?.type, 'context');
  });

  test('assigns sequential 1-based diff positions, with the hunk header itself occupying position 1', () => {
    const diff = parseFileDiff(samplePatch);
    assert.equal(diff.entries[0].position, 2); // context line A
    assert.equal(diff.entries[1].position, 3); // added line one
    assert.equal(diff.entries[2].position, 4); // added line two
    assert.equal(diff.entries[3].position, 5); // context line B
    assert.equal(diff.entries[4].position, 6); // removed line
    assert.equal(diff.entries[5].position, 7); // context line C
  });

  test('handles multiple hunks, continuing position numbering across them', () => {
    const twoHunkPatch = ['@@ -1,1 +1,1 @@', '-old', '+new', '@@ -20,1 +20,2 @@', ' context', '+another added'].join('\n');
    const diff = parseFileDiff(twoHunkPatch);
    assert.equal(diff.byNewLine.get(1)?.type, 'add');
    assert.equal(diff.byNewLine.get(21)?.type, 'add');
    // positions: 1="@@ -1,1..", 2="-old", 3="+new", 4="@@ -20,1..", 5=" context", 6="+another added"
    assert.equal(diff.byNewLine.get(21)?.position, 6);
  });

  test('ignores a "\\ No newline at end of file" marker without corrupting line numbers', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-old', '+new', '\\ No newline at end of file'].join('\n');
    const diff = parseFileDiff(patch);
    assert.equal(diff.byNewLine.get(1)?.type, 'add');
    assert.equal(diff.entries.length, 2); // the "\" line isn't a real diff line
  });
});

describe('mapLineToDiffPosition', () => {
  test('maps an added line to its diff position', () => {
    const result = mapLineToDiffPosition(samplePatch, 11);
    assert.deepEqual(result, { mapped: true, side: 'RIGHT', line: 11, position: 3 });
  });

  test('refuses a context line even though it exists in the new file - it was never changed', () => {
    const result = mapLineToDiffPosition(samplePatch, 10);
    assert.deepEqual(result, { mapped: false, reason: 'line_not_changed' });
  });

  test('refuses a line number the diff never shows at all', () => {
    const result = mapLineToDiffPosition(samplePatch, 9999);
    assert.deepEqual(result, { mapped: false, reason: 'line_not_in_diff' });
  });

  test('refuses when there is no patch at all', () => {
    assert.deepEqual(mapLineToDiffPosition(null, 11), { mapped: false, reason: 'no_diff' });
    assert.deepEqual(mapLineToDiffPosition(undefined, 11), { mapped: false, reason: 'no_diff' });
  });
});
