const REQUIRED_ENV_VARS = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO'];
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
export function loadConfig() {
    const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variable(s): ${missing.join(', ')}. See .env.example for what each one is for.`);
    
    return {
        githubToken: process.env.GITHUB_TOKEN,
        githubOwner: process.env.GITHUB_OWNER,
        githubRepo: process.env.GITHUB_REPO,
        botLogin: process.env.PR_REVIEW_BOT_LOGIN || undefined,
    };
}
/** Validates and returns only GITHUB_TOKEN - see loadConfig()'s doc comment for when to use this instead. */
export function loadGithubToken() {
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
export function resolveRepoRef(overrides = {}) {
    if (overrides.owner && overrides.repo) {
        return { owner: overrides.owner, repo: overrides.repo };
    }
    const config = loadConfig();
    return {
        owner: overrides.owner ?? config.githubOwner,
        repo: overrides.repo ?? config.githubRepo,
    };
}
//# sourceMappingURL=config.js.map
