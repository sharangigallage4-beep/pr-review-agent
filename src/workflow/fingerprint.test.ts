import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractFingerprint, fingerprintIssue, formatIssueCommentBody } from './fingerprint.js';
import type { RepositoryPullRequestRef } from './fingerprint.js';
import type { ReviewIssue } from '../review/types.js';

const ref: RepositoryPullRequestRef = { repository: 'acme/widgets', pullNumber: 42 };

const sampleIssue: ReviewIssue = {
  severity: 'high',
  file: 'src/checkout.ts',
  line: 42,
  title: 'Unsynchronized inventory read-modify-write',
  explanation: 'Two concurrent checkouts can both read the same stock count before either writes back.',
  suggestedFix: 'Wrap the read-modify-write in the existing InventoryLock.',
};

describe('fingerprintIssue', () => {
  test('is deterministic for the same repository/PR/file/line/title', () => {
    const a = fingerprintIssue(ref, 'src/a.ts', 10, 'Null check missing');
    const b = fingerprintIssue(ref, 'src/a.ts', 10, 'Null check missing');
    assert.equal(a, b);
  });

  test('is case- and whitespace-insensitive on the title', () => {
    const a = fingerprintIssue(ref, 'src/a.ts', 10, 'Null check missing');
    const b = fingerprintIssue(ref, 'src/a.ts', 10, '  NULL CHECK   missing ');
    assert.equal(a, b);
  });

  test('differs when file, line, or title differs', () => {
    const base = fingerprintIssue(ref, 'src/a.ts', 10, 'Null check missing');
    assert.notEqual(fingerprintIssue(ref, 'src/b.ts', 10, 'Null check missing'), base);
    assert.notEqual(fingerprintIssue(ref, 'src/a.ts', 11, 'Null check missing'), base);
    assert.notEqual(fingerprintIssue(ref, 'src/a.ts', 10, 'Different issue'), base);
  });

  test('differs when repository or pull request number differs, even with the same file/line/title', () => {
    const base = fingerprintIssue(ref, 'src/a.ts', 10, 'Null check missing');
    assert.notEqual(fingerprintIssue({ repository: 'acme/other-repo', pullNumber: 42 }, 'src/a.ts', 10, 'Null check missing'), base);
    assert.notEqual(fingerprintIssue({ repository: 'acme/widgets', pullNumber: 43 }, 'src/a.ts', 10, 'Null check missing'), base);
  });
});

describe('formatIssueCommentBody / extractFingerprint round-trip', () => {
  test('extracts the same fingerprint that was embedded', () => {
    const body = formatIssueCommentBody(ref, sampleIssue);
    const expected = fingerprintIssue(ref, sampleIssue.file, sampleIssue.line, sampleIssue.title);
    assert.equal(extractFingerprint(body), expected);
  });

  test('the rendered body includes severity, title, explanation, and suggested fix', () => {
    const body = formatIssueCommentBody(ref, sampleIssue);
    assert.match(body, /HIGH/);
    assert.match(body, /Unsynchronized inventory read-modify-write/);
    assert.match(body, /Two concurrent checkouts/);
    assert.match(body, /Wrap the read-modify-write in the existing InventoryLock/);
  });

  test('returns null for a comment with no fingerprint marker (e.g. a human comment)', () => {
    assert.equal(extractFingerprint('Looks good to me!'), null);
  });

  // Regression test for the exact posting format requested: "[SEVERITY] Title" as a header,
  // then explicit "Explanation:" and "Suggested fix:" labeled sections.
  test('matches the required [SEVERITY] Title / Explanation: / Suggested fix: format', () => {
    const body = formatIssueCommentBody(ref, sampleIssue);
    assert.match(body, /^\*\*\[HIGH\] Unsynchronized inventory read-modify-write\*\*/);
    assert.match(
      body,
      /\*\*Explanation:\*\*\nTwo concurrent checkouts can both read the same stock count before either writes back\./
    );
    assert.match(
      body,
      /\*\*Suggested fix:\*\*\nWrap the read-modify-write in the existing InventoryLock\./
    );
    // Explanation must come before Suggested fix, matching the requested ordering.
    assert.ok(body.indexOf('**Explanation:**') < body.indexOf('**Suggested fix:**'));
  });
});
