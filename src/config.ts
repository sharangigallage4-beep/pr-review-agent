export interface AppConfig {
  /** GitHub token used to authenticate all Octokit calls. Read once, held only in memory. */
  githubToken: string;
  /** Default repository owner (user or org login) tool calls fall back to when not overridden. */
  githubOwner: string;
  /** Default repository name tool calls fall back to when not overridden. */
  githubRepo: string;
  /**
   * The bot's own GitHub login, if known ahead of time. Used to filter
   * get_existing_review_comments down to this bot's own prior comments for de-duplication.
   * Optional - see .env.example for why this can't always be auto-discovered.
   */
  botLogin?: string;
}

const REQUIRED_ENV_VARS = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'] as const;

/**
 * Loads config from process.env. Throws - listing every missing variable at once, rather than
 * failing on the first one found - if any required variable is absent, so the server fails fast
 * at startup instead of failing opaquely (or worse, silently defaulting) on the first tool call.
 *
 * Only call this where GITHUB_OWNER/GITHUB_REPO defaults are actually needed (resolveRepoRef()
 * below, and the MCP server's own startup check, since an MCP tool call can omit owner/repo and
 * fall back to these). A caller that only needs the token - like getOctokit() - should use
 * loadGithubToken() instead, so automated entrypoints that always pass owner/repo explicitly
 * (the webhook server, GitHub Actions, autoReview.ts) never need GITHUB_OWNER/GITHUB_REPO set.
 */
export function loadConfig(): AppConfig {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. See .env.example for what each one is for.`
    );
  }

  return {
    githubToken: process.env.GITHUB_TOKEN as string,
    githubOwner: process.env.GITHUB_OWNER as string,
    githubRepo: process.env.GITHUB_REPO as string,
    botLogin: process.env.PR_REVIEW_BOT_LOGIN || undefined,
  };
}

/** Validates and returns only GITHUB_TOKEN - see loadConfig()'s doc comment for when to use this instead. */
export function loadGithubToken(): string {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    throw new Error('Missing required environment variable: GITHUB_TOKEN. See .env.example for what it is for.');
  }
  return githubToken;
}

/**
 * Resolves an {owner, repo} pair for a single call: explicit overrides win when BOTH are given,
 * otherwise falls back to the configured GITHUB_OWNER/GITHUB_REPO defaults.
 *
 * Deliberately only calls loadConfig() (which throws if env vars are missing) when a fallback is
 * actually needed - callers that always pass both owner and repo explicitly (e.g. unit tests)
 * never require GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO to be set at all.
 */
export function resolveRepoRef(overrides: { owner?: string; repo?: string } = {}): { owner: string; repo: string } {
  if (overrides.owner && overrides.repo) {
    return { owner: overrides.owner, repo: overrides.repo };
  }
  const config = loadConfig();
  return {
    owner: overrides.owner ?? config.githubOwner,
    repo: overrides.repo ?? config.githubRepo,
  };
}
