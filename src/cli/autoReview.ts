#!/usr/bin/env node
import { loadDotEnv } from '../loadEnv.js';
import { parseCliArgs } from './args.js';
import { describeOutcome } from './describeOutcome.js';
import { reviewPullRequest } from '../workflow/reviewPullRequestWorkflow.js';
import { connectMcpClient } from '../mcpClient/client.js';
import { buildMcpBackedGithubDeps } from '../mcpClient/githubViaMcp.js';

/**
 * Non-interactive entrypoint for automated triggers (GitHub Actions - see
 * .github/workflows/pr-review.yml; the webhook server has its own separate entrypoint in
 * src/webhook/server.ts and doesn't use this file). Same --owner=/--repo=/--pr= flags as the
 * interactive CLI (review.ts), but with NO confirmation prompt: confirmBeforePosting is left at
 * `reviewPullRequest`'s default (always true), so a valid review posts automatically.
 *
 * Every GitHub operation (fetch PR, fetch diff/files, fetch existing comments, post the review)
 * goes through a real MCP server: connectMcpClient() spawns src/mcp/server.ts as its own child
 * process and connects over stdio exactly as any other MCP client would, and
 * buildMcpBackedGithubDeps() turns that connection into the five functions
 * ReviewPullRequestDeps expects, each making a real `tools/call` request instead of an in-process
 * function call. Only the Claude review call itself (`runClaudeReview`) is left at its default -
 * the review engine has never gone through GitHub/MCP and isn't meant to.
 *
 * Exits non-zero ONLY when the review genuinely failed (`status: 'failed'`) - a CI step should
 * go red when something is actually broken (bad token, Claude/GitHub API failure), not when
 * there's simply nothing to review or every finding was already posted.
 */
async function main(): Promise<void> {
  loadDotEnv();

  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  const { owner, repo, pr } = parsed.args;
  console.log(`pr-review-agent (automated): reviewing ${owner}/${repo}#${pr}`);

  console.log('Connecting to the MCP GitHub server...');
  // The spawned MCP server validates GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO together at its own
  // startup (mcp/server.ts calls the full loadConfig(), not the narrower loadGithubToken() used
  // elsewhere - see config.ts's doc comment on why). Rather than requiring the outer environment
  // to separately set GITHUB_OWNER/GITHUB_REPO, pass the values this command was already given
  // via --owner=/--repo= - autoReview.ts already knows them, so the spawned server always boots
  // regardless of what else is or isn't configured outside it.
  const mcp = await connectMcpClient({ ...process.env, GITHUB_OWNER: owner, GITHUB_REPO: repo });
  console.log('Connected - GitHub operations for this run go through real MCP tool calls.');

  try {
    const outcome = await reviewPullRequest(owner, repo, pr, buildMcpBackedGithubDeps(mcp));
    describeOutcome(outcome);
  } finally {
    // Always shut the MCP server subprocess down, whether the review succeeded, failed, or threw
    // - never leave it running after this process exits.
    await mcp.close().catch(() => {});
  }
}

main().catch((err) => {
  // Same safety rule as every other entrypoint in this codebase: only ever print a plain message
  // off a caught error, never the error object itself, in case something unanticipated throws
  // with request/response internals (and therefore a token or API key) attached.
  const message = err instanceof Error ? err.message : 'Unknown error.';
  console.error(`\nUnexpected error: ${message}`);
  process.exitCode = 1;
});
