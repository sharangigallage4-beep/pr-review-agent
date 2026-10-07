import { randomUUID } from 'node:crypto';
import { reviewPullRequest } from '../workflow/reviewPullRequestWorkflow.js';
import type { ReviewPreview, ReviewPullRequestOutcome } from '../workflow/reviewPullRequestWorkflow.js';
import { consoleLogger, toSafeLogFields } from '../workflow/logger.js';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'awaiting_confirmation'
  | 'posted'
  | 'cancelled'
  | 'skipped'
  | 'failed';

export interface JobLogLine {
  time: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface Job {
  id: string;
  owner: string;
  repo: string;
  pr: number;
  /** When true the review is posted as soon as it is ready, without waiting for the user. */
  autoPost: boolean;
  status: JobStatus;
  createdAt: string;
  log: JobLogLine[];
  /** Set while status is 'awaiting_confirmation' (and kept afterwards for display). */
  preview?: ReviewPreview;
  /** The final workflow outcome, once the job has finished. */
  outcome?: ReviewPullRequestOutcome;
  /** Plain-language failure reason - always already passed through toSafeLogFields(). */
  error?: string;
}

export interface JobManagerOptions {
  /** Injectable for tests - defaults to the real end-to-end review workflow. */
  runReview?: typeof reviewPullRequest;
  /** How long a finished preview waits for Post/Discard before being discarded. Default 30 min. */
  confirmTimeoutMs?: number;
  /** Mirror every job log line here too (defaults to the console logger). */
  echo?: typeof consoleLogger;
}

const MAX_LOG_LINES = 200;

/**
 * Runs PR reviews one at a time (a single local model can only do one job well) and keeps their
 * state in memory for the web UI to poll. The "Post to GitHub" step is the workflow's own
 * `confirmBeforePosting` gate: it returns a promise that the UI resolves, so exactly the findings
 * the user looked at are the ones posted - the review is never re-run to post it.
 */
export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly pending = new Map<string, (post: boolean) => void>();
  private queue: Promise<void> = Promise.resolve();
  private readonly runReview: typeof reviewPullRequest;
  private readonly confirmTimeoutMs: number;
  private readonly echo: typeof consoleLogger;

  constructor(options: JobManagerOptions = {}) {
    this.runReview = options.runReview ?? reviewPullRequest;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 30 * 60_000;
    this.echo = options.echo ?? consoleLogger;
  }

  /** Newest first. */
  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** The newest job for a PR that has not finished yet, if any (used to stop double-clicks). */
  activeFor(owner: string, repo: string, pr: number): Job | undefined {
    return this.list().find(
      (j) =>
        j.owner === owner &&
        j.repo === repo &&
        j.pr === pr &&
        (j.status === 'queued' || j.status === 'running' || j.status === 'awaiting_confirmation')
    );
  }

  start(owner: string, repo: string, pr: number, autoPost = false): Job {
    const existing = this.activeFor(owner, repo, pr);
    if (existing) return existing;

    const job: Job = {
      id: randomUUID(),
      owner,
      repo,
      pr,
      autoPost,
      status: 'queued',
      createdAt: new Date().toISOString(),
      log: [],
    };
    this.jobs.set(job.id, job);
    this.queue = this.queue.then(() => this.run(job)).catch(() => undefined);
    return job;
  }

  /** Resolves the Post/Discard decision for a job waiting on the user. False if none is waiting. */
  confirm(id: string, post: boolean): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    resolve(post);
    return true;
  }

  private addLog(job: Job, level: JobLogLine['level'], message: string): void {
    job.log.push({ time: new Date().toISOString(), level, message });
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
  }

  private async run(job: Job): Promise<void> {
    job.status = 'running';
    const logger = {
      info: (message: string, meta?: Record<string, unknown>) => {
        this.addLog(job, 'info', message);
        this.echo.info(message, meta);
      },
      warn: (message: string, meta?: Record<string, unknown>) => {
        this.addLog(job, 'warn', message);
        this.echo.warn(message, meta);
      },
      error: (message: string, meta?: Record<string, unknown>) => {
        this.addLog(job, 'error', message);
        this.echo.error(message, meta);
      },
    };

    try {
      const outcome = await this.runReview(job.owner, job.repo, job.pr, {
        logger,
        confirmBeforePosting: (preview) => {
          job.preview = preview;
          if (job.autoPost) return true;
          job.status = 'awaiting_confirmation';
          return new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              this.pending.delete(job.id);
              this.addLog(job, 'warn', 'No decision was made in time - the review was discarded.');
              resolve(false);
            }, this.confirmTimeoutMs);
            timer.unref?.();
            this.pending.set(job.id, (post) => {
              clearTimeout(timer);
              job.status = 'running';
              resolve(post);
            });
          });
        },
      });

      job.outcome = outcome;
      switch (outcome.status) {
        case 'posted':
          job.status = 'posted';
          break;
        case 'cancelled':
          job.status = 'cancelled';
          break;
        case 'skipped':
          job.status = 'skipped';
          break;
        case 'failed':
          job.status = 'failed';
          job.error = `The "${outcome.stage}" step failed: ${outcome.reason}`;
          break;
      }
    } catch (err) {
      job.status = 'failed';
      job.error = toSafeLogFields(err).message;
    }
  }
}
