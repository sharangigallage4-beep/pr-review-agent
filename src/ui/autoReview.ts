import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { JobManager } from './jobs.js';
import type { PullRequestSummary } from './app.js';

export interface AutoSettings {
  enabled: boolean;
  /** Post the review without waiting for the user. Off by default - reviews wait for Post/Discard. */
  autoPost: boolean;
  owner: string;
  repo: string;
}

export interface AutoStatus extends AutoSettings {
  lastCheck?: string;
  lastError?: string;
}

export interface AutoReviewerOptions {
  jobs: JobManager;
  listPullRequests: (owner: string, repo: string) => Promise<PullRequestSummary[]>;
  /** JSON file for the settings and the already-seen PR commits. Omit for memory only. */
  stateFile?: string;
  intervalMs?: number;
  /** A failed review is retried on later polls, up to this many times per commit. Default 3. */
  maxAttempts?: number;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

interface SavedState {
  settings?: AutoSettings;
  seen?: string[];
  initialized?: string[];
}

/**
 * Watches one repository from inside the UI process and starts a review for every new pull request
 * commit - the same job as `npm run watch`, with an on/off switch. The first time a repository is
 * watched its open PRs are only recorded, never reviewed, so turning this on does not trigger a
 * burst of reviews on old work. Each commit is reviewed once; a failed review is retried a limited
 * number of times.
 */
export class AutoReviewer {
  private settings: AutoSettings = { enabled: false, autoPost: false, owner: '', repo: '' };
  private seen = new Set<string>();
  private initialized = new Set<string>();
  private readonly attempts = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private lastCheck: string | undefined;
  private lastError: string | undefined;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly options: AutoReviewerOptions) {
    this.intervalMs = options.intervalMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.load();
    if (this.settings.enabled) this.schedule();
  }

  status(): AutoStatus {
    return { ...this.settings, lastCheck: this.lastCheck, lastError: this.lastError };
  }

  /** Validates and applies new settings; returns an error message when they are not acceptable. */
  configure(next: Partial<AutoSettings>): string | undefined {
    const merged: AutoSettings = { ...this.settings, ...next };
    if (typeof merged.enabled !== 'boolean' || typeof merged.autoPost !== 'boolean') {
      return 'enabled and autoPost must be true or false.';
    }
    if (merged.enabled && !(NAME_PATTERN.test(merged.owner) && NAME_PATTERN.test(merged.repo))) {
      return 'Choose an owner and repository (letters, digits, ".", "_" and "-") before turning auto-review on.';
    }
    this.settings = merged;
    this.save();
    if (merged.enabled) {
      this.schedule();
      void this.tick();
    } else {
      this.stop();
    }
    return undefined;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  /** One poll. Exposed so tests (and a settings change) can run it without waiting for the timer. */
  async tick(): Promise<void> {
    const { enabled, owner, repo, autoPost } = this.settings;
    if (!enabled) return;
    const repoKey = `${owner}/${repo}`;
    try {
      const prs = await this.options.listPullRequests(owner, repo);
      this.lastCheck = new Date().toISOString();
      this.lastError = undefined;

      if (!this.initialized.has(repoKey)) {
        for (const pr of prs) this.seen.add(`${repoKey}#${pr.number}@${pr.headSha}`);
        this.initialized.add(repoKey);
        this.save();
        return;
      }

      for (const pr of prs) {
        const key = `${repoKey}#${pr.number}@${pr.headSha}`;
        if (pr.draft) continue;

        if (this.seen.has(key)) {
          // Retry a review that failed (e.g. the model was not running), a few times at most.
          const latest = this.options.jobs.list().find((j) => j.owner === owner && j.repo === repo && j.pr === pr.number);
          if (latest?.status === 'failed' && (this.attempts.get(key) ?? 1) < this.maxAttempts) this.seen.delete(key);
          else continue;
        }
        if (this.options.jobs.activeFor(owner, repo, pr.number)) continue;

        this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
        this.seen.add(key);
        this.options.jobs.start(owner, repo, pr.number, autoPost, undefined, { headSha: pr.headSha });
      }
      this.save();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : 'Could not check for new pull requests.';
    }
  }

  private load(): void {
    const file = this.options.stateFile;
    if (!file || !existsSync(file)) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedState;
      if (saved.settings) this.settings = { ...this.settings, ...saved.settings };
      this.seen = new Set(saved.seen ?? []);
      this.initialized = new Set(saved.initialized ?? []);
    } catch {
      // Unreadable state: start fresh (auto-review off, nothing seen).
    }
  }

  private save(): void {
    const file = this.options.stateFile;
    if (!file) return;
    try {
      const state: SavedState = {
        settings: this.settings,
        seen: [...this.seen].slice(-500),
        initialized: [...this.initialized],
      };
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(state));
      renameSync(tmp, file);
    } catch {
      // best effort
    }
  }
}
