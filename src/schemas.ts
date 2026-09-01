import { z } from 'zod';

// Shared building blocks. Every tool takes at least owner/repo (and almost all take
// pull_number), so these are composed into each tool's own input shape below rather than
// repeated field-by-field.

export const repoIdentifier = {
  owner: z
    .string()
    .min(1)
    .optional()
    .describe('Repository owner (user or org login), e.g. "octocat". Defaults to the GITHUB_OWNER env var if omitted.'),
  repo: z
    .string()
    .min(1)
    .optional()
    .describe('Repository name, e.g. "hello-world". Defaults to the GITHUB_REPO env var if omitted.'),
};

export const pullRequestIdentifier = {
  ...repoIdentifier,
  pull_number: z.number().int().positive().describe('The pull request number.'),
};

export const reviewCommentSide = z
  .enum(['LEFT', 'RIGHT'])
  .describe('Which side of the diff the line is on: RIGHT = the new/head version of the file, LEFT = the old/base version.');

// --- get_pull_request ---

export const getPullRequestInput = {
  ...pullRequestIdentifier,
};

// --- get_pull_request_diff ---

export const getPullRequestDiffInput = {
  ...pullRequestIdentifier,
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(2_000_000)
    .optional()
    .describe('Truncate the diff to at most this many characters (default 300000) to keep very large PRs from blowing out context.'),
};

// --- get_changed_files ---

export const getChangedFilesInput = {
  ...pullRequestIdentifier,
  page: z.number().int().positive().optional().describe('Page number for pagination (default 1).'),
  per_page: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Results per page, 1-100 (default 30). Large PRs may need multiple pages.'),
};

// --- get_file_content ---

export const getFileContentInput = {
  ...repoIdentifier,
  path: z.string().min(1).describe('Path to the file within the repository, e.g. "src/index.ts".'),
  ref: z
    .string()
    .min(1)
    .describe('Git ref to read the file at - a commit SHA, branch, or tag. Pass the PR head SHA to see the file as changed by the PR.'),
};

// --- create_pull_request_comment ---

export const createPullRequestCommentInput = {
  ...pullRequestIdentifier,
  path: z.string().min(1).describe('File path the comment applies to (must be a path present in the PR diff).'),
  line: z.number().int().positive().describe('Line number in the file (on the given side) to attach the comment to.'),
  side: reviewCommentSide.optional().describe('Defaults to RIGHT (the new version of the file).'),
  body: z.string().min(1).describe('The comment text (GitHub-flavored Markdown supported).'),
  commit_id: z
    .string()
    .optional()
    .describe("The commit SHA to attach the comment to. Defaults to the PR's current head SHA if omitted."),
};

// --- create_pull_request_review ---

export const reviewEvent = z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).describe('The overall review verdict.');

export const createPullRequestReviewInput = {
  ...pullRequestIdentifier,
  event: reviewEvent,
  body: z.string().optional().describe('Summary text for the overall review. Required by GitHub if no inline comments are included.'),
  commit_id: z
    .string()
    .optional()
    .describe("The commit SHA this review applies to. Defaults to the PR's current head SHA if omitted."),
  comments: z
    .array(
      z.object({
        path: z.string().min(1),
        line: z.number().int().positive(),
        side: reviewCommentSide.optional(),
        body: z.string().min(1),
      })
    )
    .optional()
    .describe('Inline line comments to submit as part of this review, batched into one request.'),
};

// --- get_existing_review_comments ---

export const getExistingReviewCommentsInput = {
  ...pullRequestIdentifier,
  author: z
    .string()
    .optional()
    .describe(
      "Filter to comments by this GitHub login only. Defaults to the bot's own login (from PR_REVIEW_BOT_LOGIN or GET /user), so previously-posted bot comments can be found for de-duplication."
    ),
  include_all_authors: z
    .boolean()
    .optional()
    .describe('If true, return comments from every author instead of filtering to one. Defaults to false.'),
  page: z.number().int().positive().optional(),
  per_page: z.number().int().min(1).max(100).optional(),
};
