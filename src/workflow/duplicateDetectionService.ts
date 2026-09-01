import { extractFingerprint, fingerprintIssue } from './fingerprint.js';
import type { RepositoryPullRequestRef } from './fingerprint.js';

// The duplicate-review-detection service. This is the ONLY place that decides "have we already
// posted this" - reviewPullRequestWorkflow.ts never inspects a fingerprint or an existing
// comment's body itself, it just hands this service the candidate findings plus the PR's
// existing bot comments and posts whatever comes back as new.
//
// The comparison is a pure set-membership check on stable fingerprints (repository + pull
// request + file + line + normalized title - see fingerprint.ts), never the full comment body:
// Claude's explanation text can legitimately vary run to run for the same underlying problem, so
// comparing bodies would either under-detect (any reword looks new) or, if done fuzzily, risk
// false positives. This also gives the two behaviors asked of it for free, with no extra state:
//   - the SAME issue reported again on a later run has the same fingerprint -> already in the
//     existing-comments set -> classified as a duplicate and skipped.
//   - an issue that no longer exists because the underlying code was fixed simply never appears
//     among the new findings on a later run in the first place - there is nothing to compare or
//     suppress, it's just absent.

export interface FindingLike {
  file: string;
  line: number;
  title: string;
}

export interface ExistingCommentLike {
  body: string;
}

export interface DuplicateDetectionResult<T> {
  /** No existing comment has a matching fingerprint - safe to post. */
  newFindings: T[];
  /** An existing comment already carries this exact fingerprint - must be skipped. */
  duplicateFindings: T[];
}

/**
 * Splits `findings` into new vs. already-posted duplicates, given the PR's existing review
 * comments and the repository/PR identity the fingerprint is scoped to.
 *
 * Generic over `T extends { issue: FindingLike }` rather than any concrete "mapped finding" type
 * from the orchestrator, so this service has no dependency on it - it only needs whatever shape
 * wraps a file/line/title.
 */
export function detectDuplicateFindings<T extends { issue: FindingLike }>(
  findings: T[],
  existingComments: ExistingCommentLike[],
  ref: RepositoryPullRequestRef
): DuplicateDetectionResult<T> {
  const existingFingerprints = new Set(
    existingComments.map((comment) => extractFingerprint(comment.body)).filter((fp): fp is string => fp !== null)
  );

  const newFindings: T[] = [];
  const duplicateFindings: T[] = [];

  for (const finding of findings) {
    const fingerprint = fingerprintIssue(ref, finding.issue.file, finding.issue.line, finding.issue.title);
    if (existingFingerprints.has(fingerprint)) {
      duplicateFindings.push(finding);
    } else {
      newFindings.push(finding);
    }
  }

  return { newFindings, duplicateFindings };
}
