import { reviewPullRequest } from '../workflow/reviewPullRequestWorkflow.js';
import type { ReviewPullRequestOutcome } from '../workflow/reviewPullRequestWorkflow.js';
import { toSafeLogFields } from '../workflow/logger.js';
import type { WorkflowLogger } from '../workflow/logger.js';
import { withRetry } from './retry.js';
import { ReviewStatusStore } from './reviewStatusStore.js';
import type { ParsedPullRequestEvent } from './parsePullRequestEvent.js';

/**
 * reviewPullRequest() never throws - a failure comes back as `{ status: 'failed', ... }` - but
 * withRetry() is exception-based (generic, reusable, knows nothing about this workflow's return
 * shape). This wraps a 'failed' outcome in a real Error so withRetry can retry it, while keeping
 * the original safe outcome attached so the catch block can report the same reason it would have
 * without going through retry at all.
 */
class RetryableReviewFailure extends Error {
  constructor(readonly outcome: Extract<ReviewPullRequestOutcome, { status: 'failed' }>) {
    super(outcome.reason);
    this.name = 'RetryableReviewFailure';
  }
}

export interface ProcessReviewEventDeps {
  runReview: typeof reviewPullRequest;
  statusStore: ReviewStatusStore;
  logger: WorkflowLogger;
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Runs one full review for a parsed pull_request webhook event: checks the status store for a
 * same-commit-SHA duplicate, tracks queued -> in_progress -> completed/failed, and retries a
 * failed attempt a bounded number of times with backoff before giving up.
 *
 * This is the function the webhook route fires off WITHOUT awaiting (the HTTP response has
 * already been sent by the time this runs) - every branch here handles its own errors, since
 * nothing can propagate back to a client that's no longer waiting.
 */
export async function processReviewEvent(event: ParsedPullRequestEvent, deps: ProcessReviewEventDeps): Promise<void> {
  const { owner, repo, pullNumber, commitSha, action } = event;
  const { runReview, statusStore, logger: log } = deps;

  if (statusStore.isDuplicate(owner, repo, pullNumber, commitSha)) {
    log.info('Skipping duplicate review - this commit SHA is already queued, in progress, or completed', {
      owner,
      repo,
      pullNumber,
      commitSha,
    });
    return;
  }

  statusStore.markQueued(owner, repo, pullNumber, commitSha);
  log.info('Queued review from webhook event', { owner, repo, pullNumber, commitSha, action });

  try {
    statusStore.markInProgress(owner, repo, pullNumber, commitSha);

    const outcome = await withRetry(
      async () => {
        const result = await runReview(owner, repo, pullNumber);
        if (result.status === 'failed') throw new RetryableReviewFailure(result);
        return result;
      },
      {
        retries: deps.retries ?? 2,
        delayMs: deps.retryDelayMs ?? 500,
        onRetry: (attempt, err) => {
          const safe = err instanceof RetryableReviewFailure ? { message: err.outcome.reason } : toSafeLogFields(err);
          log.warn(`Review attempt ${attempt} failed, retrying`, { owner, repo, pullNumber, commitSha, ...safe });
        },
      }
    );

    statusStore.markCompleted(owner, repo, pullNumber, commitSha, outcome.status);
    log.info('Review processing finished', { owner, repo, pullNumber, commitSha, outcome: outcome.status });
  } catch (err) {
    const reason = err instanceof RetryableReviewFailure ? err.outcome.reason : toSafeLogFields(err).message;
    statusStore.markFailed(owner, repo, pullNumber, commitSha, reason);
    log.error('Review failed after all retry attempts', { owner, repo, pullNumber, commitSha, reason });
  }
}
