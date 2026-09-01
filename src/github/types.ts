export interface RepoOverride {
  owner?: string;
  repo?: string;
}

export interface PullRequestMetadata {
  repository: string;
  number: number;
  title: string;
  description: string;
  author: string | null;
  state: string;
  draft: boolean;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  url: string;
  created_at: string;
  updated_at: string;
}

export interface PullRequestDiffResult {
  repository: string;
  number: number;
  truncated: boolean;
  total_bytes: number;
  diff: string;
}

export interface ChangedFile {
  filename: string;
  previous_filename: string | null;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch: string | null;
}

export interface ChangedFilesResult {
  repository: string;
  number: number;
  total_count: number;
  page: number;
  per_page: number;
  files: ChangedFile[];
}

export interface FileContentResult {
  path: string;
  ref: string;
  sha: string;
  size: number;
  content?: string;
  binary?: boolean;
  truncated?: boolean;
  message?: string;
}

export type ReviewCommentSide = 'LEFT' | 'RIGHT';

export interface ReviewCommentResult {
  id: number;
  url: string;
  path: string;
  line: number;
  side: ReviewCommentSide | null;
  body: string;
  commit_id: string;
  created_at: string;
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface ReviewCommentInput {
  path: string;
  line: number;
  side?: ReviewCommentSide;
  body: string;
}

export interface ReviewResult {
  id: number;
  url: string;
  state: string;
  submitted_at: string | null;
  comments_count: number;
}

export interface ExistingReviewComment {
  id: number;
  path: string;
  line: number | null;
  side: ReviewCommentSide | null;
  body: string;
  author: string | null;
  created_at: string;
  updated_at: string;
  in_reply_to_id: number | null;
  commit_id: string;
}

export interface ExistingReviewCommentsResult {
  repository: string;
  number: number;
  filtered_by_author: string | null;
  note?: string;
  count: number;
  comments: ExistingReviewComment[];
}
