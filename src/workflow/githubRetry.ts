import { withRetry } from '../webhook/retry.js';
import type { WorkflowLogger } from './logger.js';

/** Failures where the request never reached GitHub, so repeating even a write cannot post twice. */
const NEVER_SENT = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/i;
/** Network trouble in general - the request may or may not have arrived. */
const NETWORK = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE)\b|socket hang up|fetch failed|network error|request timed out/i;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

function messageOf(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { message?: unknown; code?: unknown; cause?: unknown };
    const own = [typeof e.code === 'string' ? e.code : '', typeof e.message === 'string' ? e.message : ''].join(' ');
    return e.cause ? `${own} ${messageOf(e.cause)}` : own;
  }
  return String(err);
}

/** True when the failure happened before the request reached GitHub (no DNS, connection refused...). */
export function isNeverSent(err: unknown): boolean {
  return NEVER_SENT.test(messageOf(err));
}

/** True for failures worth repeating on a READ: network errors and GitHub's own temporary errors. */
export function isTransientRead(err: unknown): boolean {
  if (NETWORK.test(messageOf(err))) return true;
  const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  return typeof status === 'number' && TRANSIENT_STATUSES.has(status);
}

export interface GithubRetry {
  /** For calls that only read from GitHub: retried on network errors and 429/502/503/504. */
  read<T>(fn: () => Promise<T>): Promise<T>;
  /** For calls that write: retried ONLY when the request never left this computer, so nothing is posted twice. */
  write<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Retry wrappers for the GitHub calls of the review workflow. They exist because the model call
 * before them can take many minutes: a brief internet outage afterwards used to throw all of that
 * work away. The waits (1 s, 2 s, 4 s, 8 s, 16 s by default) ride out a short outage and still give
 * up with the real error if it lasts.
 */
export function createGithubRetry(log: WorkflowLogger, options: { retries?: number; delayMs?: number } = {}): GithubRetry {
  const retries = options.retries ?? 5;
  const delayMs = options.delayMs ?? 1000;
  const run = <T>(fn: () => Promise<T>, shouldRetry: (err: unknown) => boolean): Promise<T> =>
    withRetry(fn, {
      retries,
      delayMs,
      shouldRetry,
      onRetry: (attempt, err) => log.warn(`GitHub request failed - retrying (${attempt} of ${retries})`, { reason: messageOf(err).slice(0, 160) }),
    });
  return {
    read: (fn) => run(fn, isTransientRead),
    write: (fn) => run(fn, isNeverSent),
  };
}
