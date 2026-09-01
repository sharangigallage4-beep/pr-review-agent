export type ReviewStatus = 'queued' | 'in_progress' | 'completed' | 'failed';

export interface ReviewStatusEntry {
  owner: string;
  repo: string;
  pullNumber: number;
  commitSha: string;
  status: ReviewStatus;
  updatedAt: string;
  /** A short, already-safe (never a raw error) detail message - e.g. the workflow outcome kind or a failure reason. */
  detail?: string;
}

/**
 * In-memory, process-local tracking of the most recent review attempt per PR. Two jobs:
 *
 * 1. Duplicate-by-commit-SHA prevention: a webhook redelivery, or a second event arriving before
 *    the first one finishes, for the SAME head SHA should not trigger a second full review run
 *    (a real Claude API call plus several GitHub API calls) - even though the finding-level
 *    fingerprint dedup inside reviewPullRequest() would still stop duplicate comments from ever
 *    actually being posted, that's a much more expensive way to arrive at "do nothing."
 * 2. Observability: exposes what happened for a given PR (`GET /webhooks/status`) without
 *    needing to dig through logs.
 *
 * Deliberately NOT persisted anywhere - this only needs to survive for the lifetime of one
 * running process; restarting the server "forgetting" in-flight state is an acceptable trade-off
 * for not adding a database to this project.
 */
export class ReviewStatusStore {
  private readonly entries = new Map<string, ReviewStatusEntry>();

  private key(owner: string, repo: string, pullNumber: number): string {
    return `${owner}/${repo}#${pullNumber}`;
  }

  /**
   * True when this exact commit SHA for this PR is already queued, in progress, or already
   * completed - the caller should skip starting another review run. A PREVIOUSLY FAILED attempt
   * for the same SHA is deliberately NOT treated as a duplicate, so a transient failure can never
   * permanently block a legitimate retry of that commit (e.g. via a later redelivery).
   */
  isDuplicate(owner: string, repo: string, pullNumber: number, commitSha: string): boolean {
    const existing = this.entries.get(this.key(owner, repo, pullNumber));
    if (!existing || existing.commitSha !== commitSha) return false;
    return existing.status === 'queued' || existing.status === 'in_progress' || existing.status === 'completed';
  }

  private set(owner: string, repo: string, pullNumber: number, commitSha: string, status: ReviewStatus, detail?: string): void {
    this.entries.set(this.key(owner, repo, pullNumber), {
      owner,
      repo,
      pullNumber,
      commitSha,
      status,
      detail,
      updatedAt: new Date().toISOString(),
    });
  }

  markQueued(owner: string, repo: string, pullNumber: number, commitSha: string): void {
    this.set(owner, repo, pullNumber, commitSha, 'queued');
  }

  markInProgress(owner: string, repo: string, pullNumber: number, commitSha: string): void {
    this.set(owner, repo, pullNumber, commitSha, 'in_progress');
  }

  markCompleted(owner: string, repo: string, pullNumber: number, commitSha: string, detail?: string): void {
    this.set(owner, repo, pullNumber, commitSha, 'completed', detail);
  }

  markFailed(owner: string, repo: string, pullNumber: number, commitSha: string, detail: string): void {
    this.set(owner, repo, pullNumber, commitSha, 'failed', detail);
  }

  getStatus(owner: string, repo: string, pullNumber: number): ReviewStatusEntry | undefined {
    return this.entries.get(this.key(owner, repo, pullNumber));
  }

  list(): ReviewStatusEntry[] {
    return Array.from(this.entries.values());
  }
}
