import type { Octokit } from '@octokit/rest';
import { getOctokit } from './client.js';
import { resolveRepoRef } from '../config.js';
import { GitHubServiceError, toGitHubServiceError } from './errors.js';
import type {
  ChangedFilesResult,
  ExistingReviewCommentsResult,
  FileContentResult,
  PullRequestDiffResult,
  PullRequestMetadata,
  RepoOverride,
  ReviewCommentInput,
  ReviewCommentResult,
  ReviewCommentSide,
  ReviewEvent,
  ReviewResult,
} from './types.js';

// This module is the ONLY place that calls the Octokit REST API - src/mcp/tools/*.ts never
// touches Octokit directly. Every exported function here:
//   - accepts an optional `octokit` parameter (defaulting to the shared getOctokit() singleton)
//     purely so tests can inject a fake client instead of hitting the network;
//   - resolves owner/repo via resolveRepoRef(), so a caller can either pass its own owner/repo
//     or rely on the GITHUB_OWNER/GITHUB_REPO defaults;
//   - normalizes every thrown error through toGitHubServiceError(), so nothing here ever lets a
//     raw Octokit RequestError (which carries the Authorization header) escape upward.
// Authentication is handled entirely by the Octokit instance's `auth` option (see client.ts) -
// every request here is authenticated, which is also what makes private repositories work; there
// is no separate code path for public vs. private.

const DEFAULT_DIFF_MAX_BYTES = 300_000;
const MAX_INLINE_FILE_BYTES = 500_000;

// --- get_pull_request ---

export async function getPullRequest(
  params: RepoOverride & { pullNumber: number },
  octokit: Octokit = getOctokit()
): Promise<PullRequestMetadata> {
  const { owner, repo } = resolveRepoRef(params);
  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: params.pullNumber });
    return {
      repository: `${owner}/${repo}`,
      number: pr.number,
      title: pr.title,
      description: pr.body ?? '',
      author: pr.user?.login ?? null,
      state: pr.state,
      draft: pr.draft ?? false,
      base: { ref: pr.base.ref, sha: pr.base.sha },
      head: { ref: pr.head.ref, sha: pr.head.sha },
      url: pr.html_url,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
    };
  } catch (err) {
    throw toGitHubServiceError(err);
  }
}

// --- get_pull_request_diff ---

export async function getPullRequestDiff(
  params: RepoOverride & { pullNumber: number; maxBytes?: number },
  octokit: Octokit = getOctokit()
): Promise<PullRequestDiffResult> {
  const { owner, repo } = resolveRepoRef(params);
  try {
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: params.pullNumber,
      mediaType: { format: 'diff' },
    });

    // With mediaType.format: 'diff', Octokit's runtime response body is the raw diff text, even
    // though its TS types still describe the default (JSON) PR shape.
    const fullDiff = data as unknown as string;
    const limit = params.maxBytes ?? DEFAULT_DIFF_MAX_BYTES;
    const truncated = fullDiff.length > limit;

    return {
      repository: `${owner}/${repo}`,
      number: params.pullNumber,
      truncated,
      total_bytes: fullDiff.length,
      diff: truncated ? fullDiff.slice(0, limit) : fullDiff,
    };
  } catch (err) {
    throw toGitHubServiceError(err);
  }
}

// --- get_changed_files ---

export async function getChangedFiles(
  params: RepoOverride & { pullNumber: number; page?: number; perPage?: number },
  octokit: Octokit = getOctokit()
): Promise<ChangedFilesResult> {
  const { owner, repo } = resolveRepoRef(params);
  const page = params.page ?? 1;
  const perPage = params.perPage ?? 30;

  try {
    const [{ data: files }, { data: pr }] = await Promise.all([
      octokit.rest.pulls.listFiles({ owner, repo, pull_number: params.pullNumber, page, per_page: perPage }),
      octokit.rest.pulls.get({ owner, repo, pull_number: params.pullNumber }),
    ]);

    return {
      repository: `${owner}/${repo}`,
      number: params.pullNumber,
      total_count: pr.changed_files,
      page,
      per_page: perPage,
      files: files.map((f) => ({
        filename: f.filename,
        previous_filename: f.previous_filename ?? null,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        // Absent for binary files, or files GitHub doesn't generate a patch for (e.g. very large
        // diffs) - always check for null before reading it.
        patch: f.patch ?? null,
      })),
    };
  } catch (err) {
    throw toGitHubServiceError(err);
  }
}

// --- get_file_content ---

export async function getFileContent(
  params: RepoOverride & { path: string; ref: string },
  octokit: Octokit = getOctokit()
): Promise<FileContentResult> {
  const { owner, repo } = resolveRepoRef(params);
  const { path, ref } = params;

  let data;
  try {
    ({ data } = await octokit.rest.repos.getContent({ owner, repo, path, ref }));
  } catch (err) {
    throw toGitHubServiceError(err);
  }

  if (Array.isArray(data) || data.type !== 'file') {
    throw new GitHubServiceError(`"${path}" at ref "${ref}" is not a file (it is a directory or submodule).`, {
      status: 422,
    });
  }

  if (data.size > MAX_INLINE_FILE_BYTES) {
    return {
      path,
      ref,
      sha: data.sha,
      size: data.size,
      truncated: true,
      message: `File is ${data.size} bytes, exceeding the ${MAX_INLINE_FILE_BYTES}-byte limit for inline content. Content not returned.`,
    };
  }

  if (data.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new GitHubServiceError(`Unsupported content encoding for "${path}".`, { status: 422 });
  }

  const buffer = Buffer.from(data.content, 'base64');
  if (looksBinary(buffer)) {
    return {
      path,
      ref,
      sha: data.sha,
      size: data.size,
      binary: true,
      message: 'File appears to be binary; content is not returned as text.',
    };
  }

  return { path, ref, sha: data.sha, size: data.size, content: buffer.toString('utf8') };
}

// A small sample is enough - real text files essentially never contain a NUL byte, and reading
// the whole buffer for every file would be wasted work for large ones.
function looksBinary(buffer: Buffer): boolean {
  const sampleLength = Math.min(buffer.length, 8000);
  for (let i = 0; i < sampleLength; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// --- create_pull_request_comment ---

export async function createPullRequestComment(
  params: RepoOverride & {
    pullNumber: number;
    path: string;
    line: number;
    side?: ReviewCommentSide;
    body: string;
    commitId?: string;
  },
  octokit: Octokit = getOctokit()
): Promise<ReviewCommentResult> {
  const { owner, repo } = resolveRepoRef(params);
  try {
    const commitId = params.commitId ?? (await octokit.rest.pulls.get({ owner, repo, pull_number: params.pullNumber })).data.head.sha;

    const { data } = await octokit.rest.pulls.createReviewComment({
      owner,
      repo,
      pull_number: params.pullNumber,
      commit_id: commitId,
      path: params.path,
      line: params.line,
      side: params.side ?? 'RIGHT',
      body: params.body,
    });

    return {
      id: data.id,
      url: data.html_url,
      path: data.path,
      line: data.line ?? data.original_line ?? params.line,
      side: (data.side as ReviewCommentSide | undefined) ?? params.side ?? 'RIGHT',
      body: data.body,
      commit_id: data.commit_id,
      created_at: data.created_at,
    };
  } catch (err) {
    throw toGitHubServiceError(err);
  }
}

// --- create_pull_request_review ---

export async function createPullRequestReview(
  params: RepoOverride & {
    pullNumber: number;
    event: ReviewEvent;
    body?: string;
    commitId?: string;
    comments?: ReviewCommentInput[];
  },
  octokit: Octokit = getOctokit()
): Promise<ReviewResult> {
  const { owner, repo } = resolveRepoRef(params);
  try {
    const commitId = params.commitId ?? (await octokit.rest.pulls.get({ owner, repo, pull_number: params.pullNumber })).data.head.sha;

    const { data } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: params.pullNumber,
      commit_id: commitId,
      event: params.event,
      body: params.body,
      comments: params.comments?.map((c) => ({ path: c.path, line: c.line, side: c.side ?? 'RIGHT', body: c.body })),
    });

    return {
      id: data.id,
      url: data.html_url,
      state: data.state,
      submitted_at: data.submitted_at ?? null,
      comments_count: params.comments?.length ?? 0,
    };
  } catch (err) {
    throw toGitHubServiceError(err);
  }
}

// --- get_existing_review_comments ---

export async function getExistingReviewComments(
  params: RepoOverride & {
    pullNumber: number;
    author?: string;
    includeAllAuthors?: boolean;
    page?: number;
    perPage?: number;
    /** The bot's own login, if already known (e.g. from config) - skips the GET /user attempt. */
    knownBotLogin?: string;
  },
  octokit: Octokit = getOctokit()
): Promise<ExistingReviewCommentsResult> {
  const { owner, repo } = resolveRepoRef(params);

  let filterLogin = params.author;
  let autoDetectFailed = false;

  if (!filterLogin && !params.includeAllAuthors) {
    filterLogin = params.knownBotLogin;
  }

  if (!filterLogin && !params.includeAllAuthors) {
    try {
      const { data: me } = await octokit.rest.users.getAuthenticated();
      filterLogin = me.login;
    } catch {
      // The Actions-provided GITHUB_TOKEN can't call GET /user - fall back to returning all
      // authors rather than failing the whole call, and say so in the response.
      autoDetectFailed = true;
    }
  }

  try {
    const { data } = await octokit.rest.pulls.listReviewComments({
      owner,
      repo,
      pull_number: params.pullNumber,
      page: params.page ?? 1,
      per_page: params.perPage ?? 100,
    });

    const filtered = filterLogin ? data.filter((c) => c.user?.login === filterLogin) : data;

    return {
      repository: `${owner}/${repo}`,
      number: params.pullNumber,
      filtered_by_author: filterLogin ?? null,
      note: autoDetectFailed
        ? "Could not auto-detect the bot's own login (GET /user is unavailable for this token). Returning comments from all authors - pass `author` explicitly to filter to just the bot's own."
        : undefined,
      count: filtered.length,
      comments: filtered.map((c) => ({
        id: c.id,
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        side: (c.side as ReviewCommentSide | undefined) ?? null,
        body: c.body,
        author: c.user?.login ?? null,
        created_at: c.created_at,
        updated_at: c.updated_at,
        in_reply_to_id: c.in_reply_to_id ?? null,
        commit_id: c.commit_id,
      })),
    };
  } catch (err) {
    throw toGitHubServiceError(err);
  }
}
