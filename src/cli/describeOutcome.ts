import type { ReviewPullRequestOutcome } from '../workflow/reviewPullRequestWorkflow.js';

/**
 * Renders a `reviewPullRequest()` outcome as terminal output, shared by every CLI-style
 * entrypoint (the interactive `review.ts` and the non-interactive `autoReview.ts`) so both
 * report results identically. Sets `process.exitCode = 1` only on a genuine failure - `skipped`
 * and `cancelled` are legitimate terminal states, not failures, and must not turn a CI step red.
 */
export function describeOutcome(outcome: ReviewPullRequestOutcome): void {
  switch (outcome.status) {
    case 'posted':
      console.log(`\nPosted review: ${outcome.reviewUrl}`);
      console.log(
        `  ${outcome.newCommentCount} inline comment(s), ${outcome.summaryOnlyCount} summary-only finding(s), ${outcome.totalFindings} total finding(s) from Claude.`
      );
      return;
    case 'cancelled':
      console.log('\nCancelled - nothing was posted to GitHub.');
      return;
    case 'skipped':
      console.log(`\nNothing to review (${outcome.reason}).`);
      return;
    case 'failed':
      // outcome.reason has already been through toSafeLogFields() inside the workflow - it can
      // only ever be a plain status/message, never a raw error carrying request/response
      // internals (where a token or API key could live).
      console.error(`\nReview failed at the "${outcome.stage}" stage: ${outcome.reason}`);
      process.exitCode = 1;
      return;
  }
}
