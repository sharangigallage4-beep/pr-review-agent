// Deliberately separate from ../config.ts (the GitHub config). The review engine must be usable
// - and testable - without any GITHUB_* environment variable ever being set, so it validates and
// loads only its own ANTHROPIC_* variables.

export interface ReviewConfig {
  anthropicApiKey: string;
  /** Defaults to a current Claude model; override with ANTHROPIC_MODEL if needed. */
  model: string;
}

const DEFAULT_MODEL = 'claude-sonnet-5';

/**
 * Loads and validates the review engine's own config from process.env. Throws if
 * ANTHROPIC_API_KEY is missing, so a misconfigured deployment fails fast rather than only
 * erroring opaquely on the first review request.
 */
export function loadReviewConfig(): ReviewConfig {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error(
      'Missing required environment variable: ANTHROPIC_API_KEY. See .env.example for what it is for.'
    );
  }

  return {
    anthropicApiKey,
    model: process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
  };
}
