import type { McpClientHandle } from './client.js';
import type {
  ChangedFilesResult,
  ExistingReviewCommentsResult,
  PullRequestDiffResult,
  PullRequestMetadata,
  RepoOverride,
  ReviewCommentInput,
  ReviewEvent,
  ReviewResult,
} from '../github/types.js';

export interface McpBackedGithubDeps {
  getPullRequest(params: RepoOverride & { pullNumber: number }): Promise<PullRequestMetadata>;
  getChangedFiles(params: RepoOverride & { pullNumber: number; page?: number; perPage?: number }): Promise<ChangedFilesResult>;
  getPullRequestDiff(params: RepoOverride & { pullNumber: number; maxBytes?: number }): Promise<PullRequestDiffResult>;
  getExistingReviewComments(
    params: RepoOverride & {
      pullNumber: number;
      author?: string;
      includeAllAuthors?: boolean;
      page?: number;
      perPage?: number;
      knownBotLogin?: string;
    }
  ): Promise<ExistingReviewCommentsResult>;
  createPullRequestReview(
    params: RepoOverride & { pullNumber: number; event: ReviewEvent; body?: string; commitId?: string; comments?: ReviewCommentInput[] }
  ): Promise<ReviewResult>;
}

/**
 * MCP-backed implementations of the exact same five GitHub operations `github/prService.ts`
 * exposes - same parameter shapes, same return types - except each one goes through a REAL
 * `tools/call` request to the MCP server (see `mcpClient/client.ts`) instead of calling Octokit
 * in-process. The shapes match exactly because every MCP tool in `src/mcp/tools/*.ts` is a thin
 * wrapper that calls the identical `prService.ts` function and returns its JSON-serialized
 * result verbatim - so parsing that JSON back reconstructs the exact same type.
 *
 * `reviewPullRequestWorkflow.ts`'s `ReviewPullRequestDeps` expects exactly these five function
 * signatures, so passing `buildMcpBackedGithubDeps(mcp)` as `overrides` is a true drop-in swap:
 * no changes to the workflow itself, only where its GitHub calls actually go.
 */
export function buildMcpBackedGithubDeps(mcp: McpClientHandle): McpBackedGithubDeps {
  return {
    getPullRequest: (params) =>
      mcp.callTool('get_pull_request', {
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pullNumber,
      }),

    getChangedFiles: (params) =>
      mcp.callTool('get_changed_files', {
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pullNumber,
        page: params.page,
        per_page: params.perPage,
      }),

    getPullRequestDiff: (params) =>
      mcp.callTool('get_pull_request_diff', {
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pullNumber,
        max_bytes: params.maxBytes,
      }),

    getExistingReviewComments: (params) =>
      mcp.callTool('get_existing_review_comments', {
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pullNumber,
        // `knownBotLogin` isn't an MCP tool parameter (see schemas.ts - the tool has no such
        // field): the real get_existing_review_comments tool resolves the bot's own login from
        // its OWN process's PR_REVIEW_BOT_LOGIN env var internally. Since connectMcpClient()
        // spawns the MCP server inheriting this same process's environment, that resolves to
        // the identical value - just via the spawned server's own config instead of a forwarded
        // parameter. Only forward `author` if the caller explicitly asked to filter by one.
        author: params.author,
        include_all_authors: params.includeAllAuthors,
        page: params.page,
        per_page: params.perPage,
      }),

    createPullRequestReview: (params) =>
      mcp.callTool('create_pull_request_review', {
        owner: params.owner,
        repo: params.repo,
        pull_number: params.pullNumber,
        event: params.event,
        body: params.body,
        commit_id: params.commitId,
        comments: params.comments,
      }),
  };
}
