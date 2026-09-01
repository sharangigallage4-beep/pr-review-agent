import { Octokit } from '@octokit/rest';
import { loadGithubToken } from '../config.js';

let octokit: Octokit | undefined;

/**
 * Lazily-created singleton Octokit instance. The token lives only inside Octokit's own auth
 * strategy internals - it is never read back out, logged, or included in any tool response.
 * Call this from inside a tool handler (not at module load time) so a missing GITHUB_TOKEN
 * surfaces as a normal tool error rather than crashing module import.
 *
 * Uses loadGithubToken() (validates only GITHUB_TOKEN), not the full loadConfig() - this client
 * has no use for GITHUB_OWNER/GITHUB_REPO, so it must not require them to be set. Every caller
 * that always passes its own owner/repo explicitly (the webhook server, GitHub Actions,
 * autoReview.ts) depends on that: with the full loadConfig() here, those callers would have
 * needed GITHUB_OWNER/GITHUB_REPO configured too, even though nothing would ever read them.
 */
export function getOctokit(): Octokit {
  if (!octokit) {
    octokit = new Octokit({
      auth: loadGithubToken(),
      userAgent: 'pr-review-agent-mcp-server',
    });
  }
  return octokit;
}
