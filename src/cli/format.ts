import type { ReviewIssue } from '../review/types.js';

/**
 * Renders one finding for terminal display, e.g.:
 *
 *   [HIGH] src/auth.ts:45
 *     Missing token expiry check
 *     Explanation text here, possibly
 *     spanning multiple lines.
 *
 * `note` is appended to the header in parentheses - used to flag findings that could not be
 * safely mapped to a diff line and will only appear in the review summary, never as an inline
 * comment.
 */
export function formatFinding(issue: ReviewIssue, note?: string): string {
  const header = `[${issue.severity.toUpperCase()}] ${issue.file}:${issue.line}${note ? ` (${note})` : ''}`;
  const title = `  ${issue.title}`;
  const indent = (text: string) =>
    text
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
  const explanation = indent(issue.explanation);
  const suggestedFix = indent(`Suggested fix: ${issue.suggestedFix}`);
  return [header, title, explanation, suggestedFix].join('\n');
}
