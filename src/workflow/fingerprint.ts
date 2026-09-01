import { createHash } from 'node:crypto';
import type { ReviewIssue } from '../review/types.js';

// De-duplication strategy: every comment this workflow posts embeds an invisible fingerprint
// marker (an HTML comment, so it renders as nothing on GitHub) derived from repository + pull
// request + file + line + normalized title - never the full comment body, which can legitimately
// reword itself between runs while still describing the same underlying problem. On the next
// run, existing comments are scanned for this marker; the actual set-comparison logic that
// decides new vs. duplicate lives in duplicateDetectionService.ts, not here - this module only
// computes and embeds/extracts the fingerprint itself.
//
// This is necessarily best-effort - if Claude rewords a finding's title on a rerun, it will look
// like a new issue - but titles are short, category-like labels that tend to be stable for the
// same underlying problem, and this avoids needing any persistent storage between runs.

export interface RepositoryPullRequestRef {
  repository: string;
  pullNumber: number;
}

const FINGERPRINT_MARKER_RE = /<!--\s*pr-review-agent:fingerprint=([0-9a-f]{40})\s*-->/;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function fingerprintIssue(ref: RepositoryPullRequestRef, file: string, line: number, title: string): string {
  return createHash('sha1')
    .update(`${ref.repository}::${ref.pullNumber}::${file}::${line}::${normalize(title)}`)
    .digest('hex');
}

/** Extracts a previously-embedded fingerprint from an existing comment's body, if present. */
export function extractFingerprint(commentBody: string): string | null {
  const match = FINGERPRINT_MARKER_RE.exec(commentBody);
  return match ? match[1] : null;
}

/**
 * Renders the Markdown body actually posted to GitHub for one finding, marker included. Format:
 *
 *   [HIGH] Possible null reference
 *   Explanation:
 *   ...
 *   Suggested fix:
 *   ...
 */
export function formatIssueCommentBody(ref: RepositoryPullRequestRef, issue: ReviewIssue): string {
  const fingerprint = fingerprintIssue(ref, issue.file, issue.line, issue.title);
  return (
    `**[${issue.severity.toUpperCase()}] ${issue.title}**\n\n` +
    `**Explanation:**\n${issue.explanation}\n\n` +
    `**Suggested fix:**\n${issue.suggestedFix}\n\n` +
    `<!-- pr-review-agent:fingerprint=${fingerprint} -->`
  );
}
