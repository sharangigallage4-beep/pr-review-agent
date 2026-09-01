import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { detectDuplicateFindings } from './duplicateDetectionService.js';
import { fingerprintIssue } from './fingerprint.js';
import type { RepositoryPullRequestRef } from './fingerprint.js';

const ref: RepositoryPullRequestRef = { repository: 'acme/widgets', pullNumber: 42 };

function finding(file: string, line: number, title: string) {
  return { issue: { file, line, title, severity: 'high' as const, explanation: 'explanation', suggestedFix: 'fix' } };
}

function existingCommentFor(r: RepositoryPullRequestRef, file: string, line: number, title: string) {
  const fp = fingerprintIssue(r, file, line, title);
  return { body: `some rendered text <!-- pr-review-agent:fingerprint=${fp} -->` };
}

describe('detectDuplicateFindings', () => {
  test('a finding with no matching existing comment is classified as new', () => {
    const result = detectDuplicateFindings([finding('src/a.ts', 10, 'Null check missing')], [], ref);
    assert.equal(result.newFindings.length, 1);
    assert.equal(result.duplicateFindings.length, 0);
  });

  test('a finding whose fingerprint matches an existing comment is classified as a duplicate and skipped', () => {
    const f = finding('src/a.ts', 10, 'Null check missing');
    const existing = [existingCommentFor(ref, 'src/a.ts', 10, 'Null check missing')];
    const result = detectDuplicateFindings([f], existing, ref);
    assert.deepEqual(result.newFindings, []);
    assert.deepEqual(result.duplicateFindings, [f]);
  });

  test('the same issue reported again on a later run is still recognized (requirement: skip if it still exists)', () => {
    // Simulates run 1 (nothing existing yet) then run 2 (the same finding comes back from Claude,
    // and the comment posted in run 1 is now "existing").
    const run1Finding = finding('src/checkout.ts', 20, 'Race condition on stock count');
    const run1 = detectDuplicateFindings([run1Finding], [], ref);
    assert.equal(run1.newFindings.length, 1);

    const postedComment = existingCommentFor(ref, 'src/checkout.ts', 20, 'Race condition on stock count');
    const run2Finding = finding('src/checkout.ts', 20, 'Race condition on stock count');
    const run2 = detectDuplicateFindings([run2Finding], [postedComment], ref);
    assert.deepEqual(run2.newFindings, []);
    assert.deepEqual(run2.duplicateFindings, [run2Finding]);
  });

  test('a fixed issue (no longer reported by Claude) simply never appears - no special handling needed', () => {
    // Run 2's candidate list just doesn't include the fixed issue at all; detectDuplicateFindings
    // never needs to know it existed before.
    const stillOpenFinding = finding('src/b.ts', 5, 'Still-open issue');
    const previouslyFixedComment = existingCommentFor(ref, 'src/checkout.ts', 20, 'Race condition on stock count');
    const result = detectDuplicateFindings([stillOpenFinding], [previouslyFixedComment], ref);
    assert.deepEqual(result.newFindings, [stillOpenFinding]);
    assert.deepEqual(result.duplicateFindings, []);
  });

  test('a genuinely new issue alongside an already-posted one: only the new one comes back', () => {
    const alreadyPosted = finding('src/a.ts', 10, 'Null check missing');
    const brandNew = finding('src/c.ts', 30, 'SQL injection via string concatenation');
    const existing = [existingCommentFor(ref, 'src/a.ts', 10, 'Null check missing')];

    const result = detectDuplicateFindings([alreadyPosted, brandNew], existing, ref);
    assert.deepEqual(result.newFindings, [brandNew]);
    assert.deepEqual(result.duplicateFindings, [alreadyPosted]);
  });

  test('does not match a fingerprint scoped to a different repository or PR number', () => {
    const f = finding('src/a.ts', 10, 'Null check missing');
    const otherRepoComment = existingCommentFor({ repository: 'acme/other-repo', pullNumber: 42 }, 'src/a.ts', 10, 'Null check missing');
    const otherPrComment = existingCommentFor({ repository: 'acme/widgets', pullNumber: 99 }, 'src/a.ts', 10, 'Null check missing');

    const result = detectDuplicateFindings([f], [otherRepoComment, otherPrComment], ref);
    assert.deepEqual(result.newFindings, [f]);
    assert.deepEqual(result.duplicateFindings, []);
  });

  test('ignores existing comments with no embedded fingerprint (e.g. human comments)', () => {
    const f = finding('src/a.ts', 10, 'Null check missing');
    const result = detectDuplicateFindings([f], [{ body: 'Looks good to me!' }], ref);
    assert.deepEqual(result.newFindings, [f]);
  });

  test('does not use the full comment body for matching - only the embedded fingerprint', () => {
    // Even though this existing comment's rendered text is about a totally different topic, if
    // it happens to carry the matching fingerprint marker it must still be recognized - and,
    // conversely, similar-looking prose with no marker at all must NOT match.
    const f = finding('src/a.ts', 10, 'Null check missing');
    const fp = fingerprintIssue(ref, 'src/a.ts', 10, 'Null check missing');
    const unrelatedTextSameFingerprint = { body: `Totally different wording here. <!-- pr-review-agent:fingerprint=${fp} -->` };
    const result = detectDuplicateFindings([f], [unrelatedTextSameFingerprint], ref);
    assert.deepEqual(result.newFindings, []);
    assert.deepEqual(result.duplicateFindings, [f]);
  });
});
