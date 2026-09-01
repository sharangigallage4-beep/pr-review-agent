export interface RetryOptions {
  /** Number of retries AFTER the first attempt. Default 2 (3 attempts total). */
  retries?: number;
  /** Base delay before the first retry, in ms. Doubles each subsequent retry. Default 500. */
  delayMs?: number;
  /** Called before each retry (not before the first attempt) with the 1-based retry number. */
  onRetry?: (attempt: number, err: unknown) => void;
}

/**
 * Retries an async operation with exponential backoff, throwing the last error if every attempt
 * fails. A generic, reusable utility with no knowledge of what it's retrying - the caller decides
 * what counts as a retryable failure by what it throws.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const retries = options.retries ?? 2;
  const delayMs = options.delayMs ?? 500;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      options.onRetry?.(attempt + 1, err);
      await sleep(delayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
