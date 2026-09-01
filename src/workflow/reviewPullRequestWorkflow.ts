import { loadConfig } from '../config.js';
import {
  getPullRequest as githubGetPullRequest,
  getChangedFiles as githubGetChangedFiles,
  getPullRequestDiff as githubGetPullRequestDiff,
  getExistingReviewComments as githubGetExistingReviewComments,
  createPullRequestReview as githubCreatePullRequestReview,
} from '../github/prService.js';
import type { ChangedFile, ReviewCommentInput } from '../github/types.js';
import { reviewPullRequest as runClaudeReview } from '../review/reviewService.js';
import type { ReviewInput, ReviewIssue, Severity } from '../review/types.js';
import { filterReviewableFiles } from './fileFilter.js';
import { mapLineToDiffPosition } from './diffMapper.js';
import { formatIssueCommentBody } from './fingerprint.js';
import type { RepositoryPullRequestRef } from './fingerprint.js';
import { detectDuplicateFindings } from './duplicateDetectionService.js';
import { consoleLogger, toSafeLogFields } from './logger.js';
import type { WorkflowLogger } from './logger.js';

const MAX_DIFF_CHARS = 300_000;

export type ReviewPullRequestOutcome =
  | {
      status: 'posted';
      reviewId: number;
      reviewUrl: string;
      newCommentCount: number;
      summaryOnlyCount: number;
      totalFindings: number;
    }
  | { status: 'cancelled'; newCommentCount: number; summaryOnlyCount: number }
  | { status: 'skipped'; reason: 'no_reviewable_files' | 'all_findings_already_posted' }
  | { status: 'failed'; stage: 'fetch' | 'claude' | 'dedup' | 'post' | 'unexpected'; reason: string };

interface MappedFinding {
  issue: ReviewIssue;
  side: 'RIGHT';
  line: number;
  position: number;
}

/**
 * The fully-prepared review, handed to `confirmBeforePosting` immediately before it would be
 * posted - everything a human (or a script) needs to decide whether to go ahead.
 */
export interface ReviewPreview {
  owner: string;
  repo: string;
  pullRequestNumber: number;
  summary: string;
  /** Findings that passed diff-line mapping and dedup - would be posted as inline comments. */
  inlineFindings: ReviewIssue[];
  /** Findings that could not be safely mapped to a line - only ever appear in the summary text. */
  summaryOnlyFindings: ReviewIssue[];
}

export interface ReviewPullRequestDeps {
  getPullRequest: typeof githubGetPullRequest;
  getChangedFiles: typeof githubGetChangedFiles;
  getPullRequestDiff: typeof githubGetPullRequestDiff;
  getExistingReviewComments: typeof githubGetExistingReviewComments;
  createPullRequestReview: typeof githubCreatePullRequestReview;
  runClaudeReview: typeof runClaudeReview;
  /** The bot's own login for dedup filtering - defaults to PR_REVIEW_BOT_LOGIN via loadConfig(). */
  knownBotLogin?: string;
  /**
   * Called with the fully-prepared review immediately before the one write call to GitHub.
   * Returning false (or a rejected/false-resolving promise) cancels: nothing is posted, and the
   * function returns `{ status: 'cancelled', ... }` instead. Defaults to always confirming, so
   * every existing non-interactive caller keeps posting automatically; the CLI overrides this
   * with an interactive y/n prompt.
   */
  confirmBeforePosting: (preview: ReviewPreview) => boolean | Promise<boolean>;
  logger: WorkflowLogger;
}

// This workflow always receives owner/repo explicitly (they're its own first two parameters),
// so GITHUB_OWNER/GITHUB_REPO are never actually needed here - only GITHUB_TOKEN is. But
// loadConfig() validates all three together, so a caller that hasn't set every var (e.g. a unit
// test overriding every other dep) would otherwise fail just from constructing the defaults.
// Swallow that and fall back to no known login - getExistingReviewComments already has its own
// GET /user fallback chain for this exact situation.
function resolveDefaultBotLogin(): string | undefined {
  try {
    return loadConfig().botLogin;
  } catch {
    return undefined;
  }
}

function defaultDeps(): ReviewPullRequestDeps {
  return {
    getPullRequest: githubGetPullRequest,
    getChangedFiles: githubGetChangedFiles,
    getPullRequestDiff: githubGetPullRequestDiff,
    getExistingReviewComments: githubGetExistingReviewComments,
    createPullRequestReview: githubCreatePullRequestReview,
    runClaudeReview,
    knownBotLogin: resolveDefaultBotLogin(),
    confirmBeforePosting: () => true,
    logger: consoleLogger,
  };
}

/**
 * The complete PR review workflow: fetch PR context from GitHub, filter out files not worth
 * reviewing, send the rest to Claude, validate every finding against the actual diff, skip
 * anything already posted, and post the remainder as a single batched GitHub review.
 *
 * Deliberately makes exactly one write call to GitHub (`createPullRequestReview`, batching every
 * new comment plus the summary) and only after every prior step - fetching, the Claude call,
 * finding validation, and dedup - has succeeded. If anything fails before that point, nothing is
 * posted: there is no code path that posts some comments and then fails, so a Claude or GitHub
 * failure can never leave a PR with partial/incorrect comments.
 *
 * Never throws - every failure mode is caught and reported via the returned outcome's
 * `status`/`reason`, and every logged/returned error message is passed through
 * `toSafeLogFields()` first, which reads only `.status`/`.message` off the original error and
 * never its request/response internals (where a token or API key could live).
 */
export async function reviewPullRequest(
  owner: string,
  repo: string,
  pullRequestNumber: number,
  overrides: Partial<ReviewPullRequestDeps> = {}
): Promise<ReviewPullRequestOutcome> {
  const deps = { ...defaultDeps(), ...overrides };
  const log = deps.logger;
  const ref = { owner, repo, pullNumber: pullRequestNumber };

  try {
    log.info('Starting PR review', { owner, repo, pullRequestNumber });

    // --- 2-4: gather PR context from GitHub ---
    let pr;
    let allChangedFiles: ChangedFile[];
    try {
      pr = await deps.getPullRequest(ref);
      allChangedFiles = await fetchAllChangedFiles(deps.getChangedFiles, ref);
      // The combined diff isn't what gets sent to Claude (see buildDiffFromFiles below, which
      // is built from the already-filtered per-file patches so ignored files never reach the
      // model) - it's fetched here only to satisfy the "get the PR diff" step and for
      // observability logging. A failure fetching it is non-fatal.
      try {
        const fullDiff = await deps.getPullRequestDiff(ref);
        log.info('Fetched full PR diff', { totalBytes: fullDiff.total_bytes, truncated: fullDiff.truncated });
      } catch (err) {
        log.warn('Could not fetch the combined PR diff (continuing with per-file patches only)', toSafeLogFields(err));
      }
    } catch (err) {
      const safe = toSafeLogFields(err);
      log.error('Failed to fetch PR data from GitHub - aborting, nothing will be posted', safe);
      return { status: 'failed', stage: 'fetch', reason: safe.message };
    }

    // --- 5: ignore lockfiles/node_modules/build output/generated/binary files ---
    const reviewableFiles = filterReviewableFiles(allChangedFiles);
    log.info('Filtered changed files', {
      total: allChangedFiles.length,
      reviewable: reviewableFiles.length,
      ignored: allChangedFiles.length - reviewableFiles.length,
    });

    if (reviewableFiles.length === 0) {
      log.info('No reviewable files after filtering - skipping Claude review', { owner, repo, pullRequestNumber });
      return { status: 'skipped', reason: 'no_reviewable_files' };
    }

    // --- 6-8: send the filtered diff to Claude and get back structured findings ---
    const reviewInput: ReviewInput = {
      pullRequest: {
        repository: pr.repository,
        number: pr.number,
        title: pr.title,
        description: pr.description,
        author: pr.author,
        baseRef: pr.base.ref,
        headRef: pr.head.ref,
      },
      diff: buildDiffFromFiles(reviewableFiles),
      changedFiles: reviewableFiles.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
    };

    let claudeResult;
    try {
      claudeResult = await deps.runClaudeReview(reviewInput);
    } catch (err) {
      const safe = toSafeLogFields(err);
      log.error('Claude review failed - aborting, nothing will be posted', safe);
      return { status: 'failed', stage: 'claude', reason: safe.message };
    }

    // --- 9: map + validate every finding against the actual diff-line-mapping system ---
    // A finding only ever becomes an inline comment if its {file, line} maps to a line the diff
    // actually added (see diffMapper.ts) - never just "somewhere near a hunk". Anything that
    // can't be mapped safely is never dropped outright: it's carried into the review summary
    // instead (step 6), so real findings are never silently lost, only kept off a line they
    // don't provably belong on.
    const reviewableByFilename = new Map(reviewableFiles.map((f) => [f.filename, f]));
    const mappedFindings: MappedFinding[] = [];
    const unmappedFindings: { issue: ReviewIssue; reason: string }[] = [];

    for (const issue of claudeResult.issues) {
      const file = reviewableByFilename.get(issue.file);
      if (!file) {
        unmappedFindings.push({ issue, reason: 'file_not_in_reviewed_diff' });
        continue;
      }
      const mapping = mapLineToDiffPosition(file.patch, issue.line);
      if (!mapping.mapped) {
        unmappedFindings.push({ issue, reason: mapping.reason });
        continue;
      }
      mappedFindings.push({ issue, side: mapping.side, line: mapping.line, position: mapping.position });
    }

    if (unmappedFindings.length > 0) {
      log.warn(
        `${unmappedFindings.length} finding(s) could not be safely mapped to a diff line - moving to the review summary instead of an inline comment`,
        { unmapped: unmappedFindings.map((u) => ({ file: u.issue.file, line: u.issue.line, reason: u.reason })) }
      );
    }

    // --- 10-11: duplicate review detection - drop anything already posted ---
    // findingRef scopes every fingerprint to this exact repository + pull request, so a
    // duplicate check can never cross-match findings from a different PR or repo.
    const findingRef: RepositoryPullRequestRef = { repository: pr.repository, pullNumber: pullRequestNumber };
    let newFindings = mappedFindings;
    if (mappedFindings.length > 0) {
      let existing;
      try {
        existing = await deps.getExistingReviewComments({ ...ref, knownBotLogin: deps.knownBotLogin });
      } catch (err) {
        const safe = toSafeLogFields(err);
        log.error('Failed to fetch existing review comments - aborting to avoid posting duplicates blind', safe);
        return { status: 'failed', stage: 'dedup', reason: safe.message };
      }

      const { newFindings: deduped, duplicateFindings } = detectDuplicateFindings(mappedFindings, existing.comments, findingRef);
      newFindings = deduped;

      if (duplicateFindings.length > 0) {
        log.info(`Skipped ${duplicateFindings.length} finding(s) already posted in a previous run`, {
          duplicates: duplicateFindings.map((f) => ({ file: f.issue.file, line: f.issue.line, title: f.issue.title })),
        });
      }
    }

    // Only truly nothing to say when every mappable finding was already posted before AND there
    // are no unmapped findings to surface in the summary either.
    if (mappedFindings.length > 0 && newFindings.length === 0 && unmappedFindings.length === 0) {
      log.info('Every finding was already posted previously - nothing new to review', { owner, repo, pullRequestNumber });
      return { status: 'skipped', reason: 'all_findings_already_posted' };
    }

    // --- 12-13: post new inline comments plus a summary (including any unmapped findings) ---
    // Re-validated immediately before building each comment - a second, independent pass right
    // at the write boundary, so a future change to the code above can never regress this into
    // posting a comment whose line was never actually confirmed against the diff.
    const comments: ReviewCommentInput[] = newFindings.map((finding) => buildValidatedComment(finding, reviewableByFilename, findingRef));

    const body = buildReviewSummaryBody(claudeResult.summary, claudeResult.issues, newFindings.length, unmappedFindings);

    const confirmed = await deps.confirmBeforePosting({
      owner,
      repo,
      pullRequestNumber,
      summary: claudeResult.summary,
      inlineFindings: newFindings.map((f) => f.issue),
      summaryOnlyFindings: unmappedFindings.map((u) => u.issue),
    });

    if (!confirmed) {
      log.info('Posting cancelled by confirmBeforePosting - nothing was posted', { owner, repo, pullRequestNumber });
      return { status: 'cancelled', newCommentCount: newFindings.length, summaryOnlyCount: unmappedFindings.length };
    }

    try {
      // Anchor the review to the exact commit that was actually fetched and reviewed
      // (pr.head.sha, captured back at step 2-4), not whatever the PR's head happens to be at
      // post time. Without this, createPullRequestReview() would auto-resolve the commit_id by
      // re-fetching the PR's CURRENT head - if a new commit lands on the PR while Claude is
      // still reviewing (a real, if narrow, race), the posted review would end up anchored to a
      // commit whose diff was never actually analyzed.
      const review = await deps.createPullRequestReview({ ...ref, event: 'COMMENT', body, comments, commitId: pr.head.sha });
      log.info('Posted PR review', { reviewId: review.id, newCommentCount: newFindings.length, summaryOnlyCount: unmappedFindings.length });
      return {
        status: 'posted',
        reviewId: review.id,
        reviewUrl: review.url,
        newCommentCount: newFindings.length,
        summaryOnlyCount: unmappedFindings.length,
        totalFindings: claudeResult.issues.length,
      };
    } catch (err) {
      const safe = toSafeLogFields(err);
      log.error('Failed to post the review to GitHub', safe);
      return { status: 'failed', stage: 'post', reason: safe.message };
    }
  } catch (err) {
    const safe = toSafeLogFields(err);
    log.error('Unexpected error in the review workflow - aborting, nothing will be posted', safe);
    return { status: 'failed', stage: 'unexpected', reason: safe.message };
  }
}

async function fetchAllChangedFiles(
  getChangedFilesFn: ReviewPullRequestDeps['getChangedFiles'],
  ref: { owner: string; repo: string; pullNumber: number }
): Promise<ChangedFile[]> {
  const perPage = 100;
  let page = 1;
  const all: ChangedFile[] = [];

  // Stop once we've collected every file GitHub reported, or a page comes back short (a page
  // with fewer than perPage results can't be followed by more).
  for (;;) {
    const result = await getChangedFilesFn({ ...ref, page, perPage });
    all.push(...result.files);
    if (all.length >= result.total_count || result.files.length < perPage) break;
    page += 1;
  }
  return all;
}

/**
 * Builds the diff text sent to Claude from the already-filtered files' own patches, rather than
 * the combined PR diff - this is what guarantees an ignored file's contents never reach the
 * model, without needing to parse and strip sections out of a combined diff string.
 */
function buildDiffFromFiles(files: ChangedFile[]): string {
  const sections = files.filter((f) => f.patch).map((f) => `diff --git a/${f.filename} b/${f.filename}\n${f.patch}`);

  if (sections.length === 0) {
    return '(No textual diff available for the reviewable files - GitHub did not provide a patch for any of them.)';
  }

  const combined = sections.join('\n\n');
  return combined.length > MAX_DIFF_CHARS ? `${combined.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated)` : combined;
}

/**
 * Re-runs the same diff-line mapping used for classification, immediately before turning a
 * finding into a GitHub comment payload. Throws (rather than posting) if it ever disagrees with
 * the earlier result - given the same patch and line this is deterministic and should never
 * happen, so a mismatch means something upstream regressed, and refusing to post is the only
 * acceptable response to that: this codebase must never place a comment on the wrong line.
 */
function buildValidatedComment(
  finding: MappedFinding,
  reviewableByFilename: Map<string, ChangedFile>,
  ref: RepositoryPullRequestRef
): ReviewCommentInput {
  const file = reviewableByFilename.get(finding.issue.file);
  const revalidated = file ? mapLineToDiffPosition(file.patch, finding.line) : ({ mapped: false, reason: 'file_not_in_reviewed_diff' } as const);

  if (!revalidated.mapped) {
    throw new Error(
      `Diff-line mapping invariant violated for ${finding.issue.file}:${finding.line} - refusing to post an unverified comment.`
    );
  }

  return {
    path: finding.issue.file,
    line: revalidated.line,
    side: revalidated.side,
    body: formatIssueCommentBody(ref, finding.issue),
  };
}

const NO_ISSUES_MESSAGE = '✅ No significant issues found in the changed code.';

type SeverityCounts = Record<Severity, number>;

function countBySeverity(issues: ReviewIssue[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return counts;
}

/**
 * A deterministic, rule-based verdict from severity counts - never asked of Claude itself, so
 * this line is guaranteed consistent between runs with the same findings, rather than subject to
 * however the model happens to phrase it this time.
 */
function overallReviewResult(counts: SeverityCounts): string {
  if (counts.critical > 0) {
    return `⚠️ Changes requested - ${counts.critical} critical issue(s) must be addressed before merging.`;
  }
  if (counts.high > 0) {
    return `⚠️ Changes requested - ${counts.high} high-severity issue(s) should be addressed.`;
  }
  return '✅ Approved with minor suggestions - no blocking issues found.';
}

/**
 * Builds the single summary comment: total issues found plus a critical/high/medium/low
 * breakdown, a deterministic overall verdict, Claude's own summary text, how many inline
 * comments were posted, and - per the "never place a comment on the wrong line" rule - every
 * finding that couldn't be safely mapped to a diff line, written out in full so nothing is
 * silently lost. `allIssues` is every issue Claude returned this run (not just the new ones being
 * posted), so the counts always describe the PR's current full picture, not just this run's delta.
 *
 * When Claude found nothing at all, the whole body is replaced with the fixed
 * "No significant issues found" message rather than a zeroed-out breakdown template.
 */
function buildReviewSummaryBody(
  summary: string,
  allIssues: ReviewIssue[],
  newInlineCount: number,
  unmapped: { issue: ReviewIssue; reason: string }[]
): string {
  if (allIssues.length === 0) {
    return NO_ISSUES_MESSAGE;
  }

  const counts = countBySeverity(allIssues);
  const parts: string[] = [];

  parts.push(
    [
      `**Issues found:** ${allIssues.length}`,
      `- 🔴 Critical: ${counts.critical}`,
      `- 🟠 High: ${counts.high}`,
      `- 🟡 Medium: ${counts.medium}`,
      `- 🟢 Low: ${counts.low}`,
    ].join('\n')
  );

  parts.push(`**Overall review result:** ${overallReviewResult(counts)}`);

  parts.push(summary);

  if (newInlineCount > 0) {
    parts.push(`_${newInlineCount} finding(s) posted as inline comments by pr-review-agent._`);
  }

  if (unmapped.length > 0) {
    const entries = unmapped.map(
      ({ issue }) =>
        `- **[${issue.severity.toUpperCase()}] ${issue.file}:${issue.line}** - ${issue.title}\n\n` +
        `  **Explanation:**\n  ${issue.explanation}\n\n` +
        `  **Suggested fix:**\n  ${issue.suggestedFix}`
    );
    parts.push(['**Additional findings that could not be safely placed on a specific diff line:**', '', ...entries].join('\n'));
  }

  return parts.join('\n\n');
}
