import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { reviewPullRequest } from '../workflow/reviewPullRequestWorkflow.js';
import type { ReviewPreview, ReviewPullRequestOutcome } from '../workflow/reviewPullRequestWorkflow.js';
import { consoleLogger, toSafeLogFields } from '../workflow/logger.js';
import type { ReviewIssue } from '../review/types.js';
import type { ProviderId } from '../review/providers.js';
import { addUsage, type Usage } from './usage.js';
import type { ReviewPullRequestDeps } from '../workflow/reviewPullRequestWorkflow.js';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'awaiting_confirmation'
  | 'posted'
  | 'cancelled'
  | 'skipped'
  | 'done'
  | 'failed';

export interface JobLogLine {
  time: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface Job {
  id: string;
  /** 'local' = a review of folders/ZIPs on this machine (nothing to post); default 'pr'. */
  kind?: 'pr' | 'local';
  /** For a local review: what was reviewed, e.g. "customer-solution-new (vs old)". */
  label?: string;
  owner: string;
  repo: string;
  pr: number;
  /** When true the review is posted as soon as it is ready, without waiting for the user. */
  autoPost: boolean;
  /** The commit the pull request pointed at when this review started - the same commit is never reviewed twice unless asked. */
  headSha?: string;
  /** Which AI the review asked (fixed when the review was started, so a later switch does not change it). */
  provider?: ProviderId;
  /** Tokens the model used for this review (only counted for models that report them, i.e. Claude). */
  usage?: Usage;
  status: JobStatus;
  createdAt: string;
  log: JobLogLine[];
  /** Set while status is 'awaiting_confirmation' (and kept afterwards for display). */
  preview?: ReviewPreview;
  /** The final workflow outcome, once the job has finished. */
  outcome?: ReviewPullRequestOutcome;
  /** Plain-language failure reason - always already passed through toSafeLogFields(). */
  error?: string;
  /** The user's 👍/👎 on each finding, keyed by its position in inlineFindings + summaryOnlyFindings. */
  feedback?: Record<string, FeedbackVote>;
}

/** What a local review's work function may use besides its log. */
export interface LocalReviewContext {
  /**
   * The review function for the AI selected when this review started (counting its tokens), or undefined
   * to use the environment's. Only call it when the AI is really needed: it throws a message for the user
   * when that AI cannot be used (for example a missing Claude key or a reached monthly limit).
   */
  reviewer: () => NonNullable<ReviewPullRequestDeps['runClaudeReview']> | undefined;
}

export type LocalReviewWork = (log: (message: string) => void, context: LocalReviewContext) => Promise<LocalReviewResult>;

export interface LocalReviewResult {
  summary: string;
  findings: ReviewIssue[];
}

export type FeedbackVote = 'up' | 'down';

export interface FeedbackSummary {
  up: number;
  down: number;
  /** Share of 👍 among rated findings, 0-100, or null when nothing has been rated. */
  percentUp: number | null;
}

export interface JobManagerOptions {
  /** Injectable for tests - defaults to the real end-to-end review workflow. */
  runReview?: typeof reviewPullRequest;
  /** How long a finished preview waits for Post/Discard before being discarded. Default 12 hours. */
  confirmTimeoutMs?: number;
  /** Mirror every job log line here too (defaults to the console logger). */
  echo?: typeof consoleLogger;
  /** JSON file the review history is kept in, so it survives a restart. Omit for memory only. */
  historyFile?: string;
  /** The provider a new review uses (read when the review starts). Omit to use the environment, as before. */
  defaultProvider?: () => ProviderId;
  /**
   * Builds the review function for a provider; it may throw a message for the user (for example when
   * the Claude key is missing), which then fails that review with that message.
   */
  reviewerFor?: (provider: ProviderId, onUsage: (usage: { inputTokens: number; outputTokens: number }) => void) => ReviewPullRequestDeps['runClaudeReview'];
}

const MAX_LOG_LINES = 200;
const MAX_SAVED_JOBS = 100;

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
  private readonly historyFile: string | undefined;
  private readonly defaultProvider: (() => ProviderId) | undefined;
  private readonly reviewerFor: JobManagerOptions['reviewerFor'];

  constructor(options: JobManagerOptions = {}) {
    this.historyFile = options.historyFile;
    this.defaultProvider = options.defaultProvider;
    this.reviewerFor = options.reviewerFor;
    this.loadHistory();
    this.runReview = options.runReview ?? reviewPullRequest;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? 12 * 60 * 60_000;
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

  /**
   * A finished review of exactly this commit, if there is one. Reviewing the same commit again would cost
   * tokens for the same answer, so start() hands this back instead - unless a new review is asked for.
   */
  reusableFor(owner: string, repo: string, pr: number, headSha: string): Job | undefined {
    return this.list().find(
      (j) =>
        j.owner === owner &&
        j.repo === repo &&
        j.pr === pr &&
        j.headSha === headSha &&
        (j.status === 'posted' || j.status === 'done' || (j.status === 'cancelled' && j.preview !== undefined))
    );
  }

  start(owner: string, repo: string, pr: number, autoPost = false, provider?: ProviderId, options: { headSha?: string; force?: boolean } = {}): Job {
    const existing = this.activeFor(owner, repo, pr);
    if (existing) return existing;
    if (options.headSha && !options.force) {
      const already = this.reusableFor(owner, repo, pr, options.headSha);
      if (already) return already;
    }

    const job: Job = {
      id: randomUUID(),
      owner,
      repo,
      pr,
      autoPost,
      provider: provider ?? this.defaultProvider?.(),
      ...(options.headSha ? { headSha: options.headSha } : {}),
      status: 'queued',
      createdAt: new Date().toISOString(),
      log: [],
    };
    this.jobs.set(job.id, job);
    this.save();
    this.queue = this.queue.then(() => this.run(job)).catch(() => undefined);
    return job;
  }

  /**
   * Queues a review of local files (no GitHub involved). `work` does the reviewing and reports
   * progress through `log`; its findings are kept like a PR review's, but there is nothing to post -
   * the job simply ends as "done". It shares the queue with PR reviews: one model, one job at a time.
   */
  startLocal(label: string, work: LocalReviewWork): Job {
    const job: Job = {
      id: randomUUID(),
      kind: 'local',
      label,
      owner: 'local',
      repo: label,
      pr: 0,
      autoPost: false,
      ...(this.defaultProvider ? { provider: this.defaultProvider() } : {}),
      status: 'queued',
      createdAt: new Date().toISOString(),
      log: [],
    };
    this.jobs.set(job.id, job);
    this.save();
    this.queue = this.queue.then(() => this.runLocal(job, work)).catch(() => undefined);
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

  /** Records (or, with null, clears) a 👍/👎 for one finding. False if the job or finding doesn't exist. */
  setFeedback(id: string, index: number, vote: FeedbackVote | null): boolean {
    const job = this.jobs.get(id);
    const total = job?.preview ? job.preview.inlineFindings.length + job.preview.summaryOnlyFindings.length : 0;
    if (!job || !Number.isInteger(index) || index < 0 || index >= total) return false;
    job.feedback ??= {};
    if (vote === null) delete job.feedback[String(index)];
    else job.feedback[String(index)] = vote;
    this.save();
    return true;
  }

  feedbackSummary(): FeedbackSummary {
    let up = 0;
    let down = 0;
    for (const job of this.jobs.values()) {
      for (const vote of Object.values(job.feedback ?? {})) {
        if (vote === 'up') up += 1;
        else if (vote === 'down') down += 1;
      }
    }
    return { up, down, percentUp: up + down === 0 ? null : Math.round((up / (up + down)) * 100) };
  }

  private loadHistory(): void {
    if (!this.historyFile || !existsSync(this.historyFile)) return;
    try {
      const saved = JSON.parse(readFileSync(this.historyFile, 'utf8')) as Job[];
      for (const job of saved) {
        // A review that was still in flight when the server stopped can never finish (its
        // Post/Discard gate lived in memory), so show it as failed rather than forever "running".
        if (job.status === 'queued' || job.status === 'running' || job.status === 'awaiting_confirmation') {
          job.status = 'failed';
          job.error = 'The server was restarted while this review was in progress. Start it again.';
        }
        this.jobs.set(job.id, job);
      }
    } catch {
      // An unreadable history file is not worth failing startup over - start with an empty list.
    }
  }

  private save(): void {
    if (!this.historyFile) return;
    try {
      const newest = this.list().slice(0, MAX_SAVED_JOBS);
      const tmp = `${this.historyFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(newest));
      renameSync(tmp, this.historyFile);
    } catch {
      // Saving history is best effort - never break a review because the disk write failed.
    }
  }

  private addLog(job: Job, level: JobLogLine['level'], message: string): void {
    job.log.push({ time: new Date().toISOString(), level, message });
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
  }

  private async runLocal(job: Job, work: LocalReviewWork): Promise<void> {
    job.status = 'running';
    try {
      const result = await work(
        (message) => {
          this.addLog(job, 'info', message);
          this.echo.info(message);
        },
        {
          reviewer: () =>
            job.provider && this.reviewerFor
              ? this.reviewerFor(job.provider, (used) => {
                  job.usage = addUsage(job.usage, used);
                })
              : undefined,
        }
      );
      job.preview = { owner: 'local', repo: job.label ?? '', pullRequestNumber: 0, summary: result.summary, inlineFindings: result.findings, summaryOnlyFindings: [] };
      job.status = 'done';
    } catch (err) {
      job.status = 'failed';
      job.error = toSafeLogFields(err).message;
    }
    this.save();
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
      // The provider is looked up here, inside the try block, so a missing key fails this review with a clear message.
      const runClaudeReview = job.provider && this.reviewerFor ? this.reviewerFor(job.provider, (used) => { job.usage = addUsage(job.usage, used); }) : undefined;
      const outcome = await this.runReview(job.owner, job.repo, job.pr, {
        logger,
        ...(runClaudeReview ? { runClaudeReview } : {}),
        confirmBeforePosting: (preview) => {
          job.preview = preview;
          if (job.autoPost) return true;
          job.status = 'awaiting_confirmation';
          this.save();
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
    this.save();
  }
}
