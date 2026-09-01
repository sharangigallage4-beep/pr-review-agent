import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatFinding } from './format.js';
import type { ReviewIssue } from '../review/types.js';

const issue: ReviewIssue = {
  severity: 'high',
  file: 'src/auth.ts',
  line: 45,
  title: 'Missing token expiry check',
  explanation: 'The token is accepted regardless of its exp claim.\nAn expired or stolen token stays valid forever.',
  suggestedFix: 'Check token.exp against the current time and reject if expired.',
};

describe('formatFinding', () => {
  test('renders the [SEVERITY] file:line header, uppercased', () => {
    const output = formatFinding(issue);
    assert.match(output, /^\[HIGH\] src\/auth\.ts:45/);
  });

  test('includes the title, the explanation, and the suggested fix', () => {
    const output = formatFinding(issue);
    assert.match(output, /Missing token expiry check/);
    assert.match(output, /The token is accepted regardless of its exp claim\./);
    assert.match(output, /An expired or stolen token stays valid forever\./);
    assert.match(output, /Suggested fix:.*Check token\.exp/);
  });

  test('appends an optional note in parentheses to the header', () => {
    const output = formatFinding(issue, 'summary only');
    assert.match(output, /^\[HIGH\] src\/auth\.ts:45 \(summary only\)/);
  });

  test('omits the parenthetical note when none is given', () => {
    const output = formatFinding(issue);
    assert.equal(output.split('\n')[0].includes('('), false);
  });
});
