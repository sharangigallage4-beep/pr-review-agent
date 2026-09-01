import { z } from 'zod';

// Input types are intentionally NOT imported from src/github/types.ts, even though some fields
// overlap in meaning - the review engine must not depend on the GitHub integration at all, so it
// can be constructed and unit tested with plain literal objects.

export interface ReviewPullRequestMetadata {
  repository: string;
  number: number;
  title: string;
  description: string;
  author: string | null;
  baseRef: string;
  headRef: string;
}

export interface ReviewChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified diff patch for this file, if GitHub generated one. */
  patch?: string | null;
}

export interface ReviewFileContent {
  path: string;
  content: string;
}

export interface ReviewInput {
  pullRequest: ReviewPullRequestMetadata;
  diff: string;
  changedFiles: ReviewChangedFile[];
  /** Full contents of files worth showing beyond their diff hunks (e.g. for cross-function context). */
  fileContents?: ReviewFileContent[];
}

// --- Output schema - exactly the shape Claude must return ---

export const SEVERITY_LEVELS = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITY_LEVELS)[number];

export const reviewIssueSchema = z.object({
  severity: z.enum(SEVERITY_LEVELS),
  file: z.string().min(1),
  line: z.number().int().positive(),
  title: z.string().min(1),
  /** What the problem is and why it matters (the concrete failure scenario). */
  explanation: z.string().min(1),
  /** A concise, actionable recommended fix - kept separate from `explanation` so a consumer can render/format it distinctly (e.g. as a code suggestion). */
  suggestedFix: z.string().min(1),
});

export const reviewResultSchema = z.object({
  summary: z.string(),
  issues: z.array(reviewIssueSchema),
});

export type ReviewIssue = z.infer<typeof reviewIssueSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
