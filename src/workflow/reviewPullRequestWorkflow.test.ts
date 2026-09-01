import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPullRequest } from './reviewPullRequestWorkflow.js';
import type { ReviewPullRequestDeps } from './reviewPullRequestWorkflow.js';
import type { WorkflowLogger } from './logger.js';

// A silent logger for tests that don't care about log output, and a capturing one for tests
// that do (e.g. asserting a warning was logged when findings are dropped).
const silentLogger: WorkflowLogger = { info: () => {}, warn: () => {}, error: () => {} };

function capturingLogger(): WorkflowLogger & { calls: { level: string; message: string; meta?: Record<string, unknown> }[] } {
  const calls: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  return {
    calls,
    info: (message, meta) => calls.push({ level: 'info', message, meta }),
    warn: (message, meta) => calls.push({ level: 'warn', message, meta }),
    error: (message, meta) => calls.push({ level: 'error', message, meta }),
  };
}

const pr = {
  repository: 'acme/widgets',
  number: 42,
  title: 'Fix checkout race condition',
  description: 'Adds a lock around the checkout critical section.',
  author: 'alice',
  state: 'open',
  draft: false,
  base: { ref: 'main', sha: 'base-sha' },
  head: { ref: 'fix/checkout-race', sha: 'head-sha' },
  url: 'https://github.com/acme/widgets/pull/42',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const reviewableFile = {
  filename: 'src/checkout.ts',
  previous_filename: null,
  status: 'modified',
  additions: 5,
  deletions: 1,
  changes: 6,
  patch: '@@ -10,3 +10,5 @@\n context\n+added line\n+another added line\n context',
};

const lockfile = {
  filename: 'package-lock.json',
  previous_filename: null,
  status: 'modified',
  additions: 100,
  deletions: 50,
  changes: 150,
  patch: '@@ -1,1 +1,1 @@\n-x\n+y',
};

function changedFilesPage(files: typeof reviewableFile[], totalCount: number, page: number, perPage: number) {
  return { repository: 'acme/widgets', number: 42, total_count: totalCount, page, per_page: perPage, files };
}

function baseDeps(overrides: Partial<ReviewPullRequestDeps> = {}): Partial<ReviewPullRequestDeps> {
  return {
    getPullRequest: async () => pr,
    getChangedFiles: async ({ page, perPage }) => changedFilesPage([reviewableFile, lockfile], 2, page ?? 1, perPage ?? 100),
    getPullRequestDiff: async () => ({ repository: 'acme/widgets', number: 42, truncated: false, total_bytes: 100, diff: 'irrelevant' }),
    getExistingReviewComments: async () => ({ repository: 'acme/widgets', number: 42, filtered_by_author: 'pr-review-bot', count: 0, comments: [] }),
    createPullRequestReview: async ({ event, body, comments }) => ({
      id: 999,
      url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-999',
      state: event === 'COMMENT' ? 'COMMENTED' : event,
      submitted_at: '2026-01-01T00:00:00Z',
      comments_count: comments?.length ?? 0,
    }),
    runClaudeReview: async () => ({
      summary: 'Found one race condition.',
      issues: [
        {
          severity: 'high' as const,
          file: 'src/checkout.ts',
          line: 11,
          title: 'Unsynchronized inventory update',
          explanation: 'Two concurrent checkouts can race on the stock count.',
          suggestedFix: 'Wrap the read-modify-write in the existing InventoryLock.',
        },
      ],
    }),
    knownBotLogin: 'pr-review-bot',
    logger: silentLogger,
    ...overrides,
  };
}

describe('reviewPullRequest happy path', () => {
  test('posts a review with the valid, non-duplicate finding', async () => {
    const outcome = await reviewPullRequest('acme', 'widgets', 42, baseDeps());
    assert.equal(outcome.status, 'posted');
    if (outcome.status === 'posted') {
      assert.equal(outcome.newCommentCount, 1);
      assert.equal(outcome.totalFindings, 1);
      assert.equal(outcome.reviewId, 999);
    }
  });

  test('anchors the posted review to the PR head SHA that was actually reviewed', async () => {
    let capturedCommitId: string | undefined;
    await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        createPullRequestReview: async (params) => {
          capturedCommitId = params.commitId;
          return { id: 999, url: '', state: 'COMMENTED', submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );
    // `pr` (the module-level fixture) has head.sha === 'head-sha' - this must be passed
    // explicitly, not left for createPullRequestReview to auto-resolve by re-fetching the PR's
    // CURRENT head at post time (which could differ if a new commit landed mid-review).
    assert.equal(capturedCommitId, 'head-sha');
  });

  test('excludes ignored files (lockfile) from what Claude sees', async () => {
    let capturedDiff = '';
    let capturedFilenames: string[] = [];
    await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        runClaudeReview: async (input) => {
          capturedDiff = input.diff;
          capturedFilenames = input.changedFiles.map((f) => f.filename);
          return { summary: 'ok', issues: [] };
        },
      })
    );
    assert.deepEqual(capturedFilenames, ['src/checkout.ts']);
    assert.equal(capturedDiff.includes('package-lock.json'), false);
    assert.match(capturedDiff, /diff --git a\/src\/checkout\.ts/);
  });

  test('paginates through get_changed_files until every file is collected', async () => {
    // A real page is only ever short on the last page - GitHub always fills a page to per_page
    // unless there's nothing left. So to force a second fetch, page 1 must come back FULL (100
    // items) even though most are duplicates here; only page 2's single extra file matters.
    let callCount = 0;
    const pageOneFiles = Array.from({ length: 100 }, (_, i) => ({ ...reviewableFile, filename: `src/file-${i}.ts` }));
    const pageTwoFile = { ...reviewableFile, filename: 'src/other.ts' };
    const totalCount = pageOneFiles.length + 1;

    let capturedFilenames: string[] = [];
    await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        getChangedFiles: async ({ page, perPage }) => {
          callCount += 1;
          if (page === 1) return changedFilesPage(pageOneFiles, totalCount, 1, perPage ?? 100);
          return changedFilesPage([pageTwoFile], totalCount, 2, perPage ?? 100);
        },
        runClaudeReview: async (input) => {
          capturedFilenames = input.changedFiles.map((f) => f.filename);
          return { summary: 'ok', issues: [] };
        },
      })
    );

    assert.equal(callCount, 2);
    assert.equal(capturedFilenames.length, totalCount);
    assert.ok(capturedFilenames.includes('src/other.ts'));
  });
});

describe('reviewPullRequest confirmation gate', () => {
  test('does not post when confirmBeforePosting returns false', async () => {
    let postCalled = false;
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        confirmBeforePosting: () => false,
        createPullRequestReview: async () => {
          postCalled = true;
          return { id: 1, url: '', state: '', submitted_at: null, comments_count: 0 };
        },
      })
    );

    assert.deepEqual(outcome, { status: 'cancelled', newCommentCount: 1, summaryOnlyCount: 0 });
    assert.equal(postCalled, false);
  });

  test('supports an async confirmBeforePosting (e.g. an interactive CLI prompt)', async () => {
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({ confirmBeforePosting: async () => Promise.resolve(true) })
    );
    assert.equal(outcome.status, 'posted');
  });

  test('passes the prepared review preview - owner/repo/PR, summary, and split inline vs summary-only findings', async () => {
    let capturedPreview: unknown;
    await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        runClaudeReview: async () => ({
          summary: 'One mappable issue and one that could not be placed.',
          issues: [
            { severity: 'high', file: 'src/checkout.ts', line: 11, title: 'Mappable issue', explanation: 'x', suggestedFix: 'fix-x' },
            { severity: 'low', file: 'src/checkout.ts', line: 9999, title: 'Unmappable issue', explanation: 'y', suggestedFix: 'fix-y' },
          ],
        }),
        confirmBeforePosting: (preview) => {
          capturedPreview = preview;
          return true;
        },
      })
    );

    assert.deepEqual(capturedPreview, {
      owner: 'acme',
      repo: 'widgets',
      pullRequestNumber: 42,
      summary: 'One mappable issue and one that could not be placed.',
      inlineFindings: [{ severity: 'high', file: 'src/checkout.ts', line: 11, title: 'Mappable issue', explanation: 'x', suggestedFix: 'fix-x' }],
      summaryOnlyFindings: [{ severity: 'low', file: 'src/checkout.ts', line: 9999, title: 'Unmappable issue', explanation: 'y', suggestedFix: 'fix-y' }],
    });
  });
});

describe('reviewPullRequest safe-failure modes', () => {
  test('fails at the fetch stage and never calls Claude or GitHub write APIs', async () => {
    let claudeCalled = false;
    let postCalled = false;
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        getPullRequest: async () => {
          throw Object.assign(new Error('Not Found'), { status: 404 });
        },
        runClaudeReview: async () => {
          claudeCalled = true;
          return { summary: '', issues: [] };
        },
        createPullRequestReview: async () => {
          postCalled = true;
          return { id: 1, url: '', state: '', submitted_at: null, comments_count: 0 };
        },
      })
    );

    assert.deepEqual(outcome, { status: 'failed', stage: 'fetch', reason: 'Not Found' });
    assert.equal(claudeCalled, false);
    assert.equal(postCalled, false);
  });

  test('fails at the claude stage without posting anything', async () => {
    let postCalled = false;
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        runClaudeReview: async () => {
          throw new Error('Claude API request failed.');
        },
        createPullRequestReview: async () => {
          postCalled = true;
          return { id: 1, url: '', state: '', submitted_at: null, comments_count: 0 };
        },
      })
    );

    assert.deepEqual(outcome, { status: 'failed', stage: 'claude', reason: 'Claude API request failed.' });
    assert.equal(postCalled, false);
  });

  test('fails at the dedup stage when get_existing_review_comments errors, without posting', async () => {
    let postCalled = false;
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        getExistingReviewComments: async () => {
          throw Object.assign(new Error('Server Error'), { status: 500 });
        },
        createPullRequestReview: async () => {
          postCalled = true;
          return { id: 1, url: '', state: '', submitted_at: null, comments_count: 0 };
        },
      })
    );

    assert.deepEqual(outcome, { status: 'failed', stage: 'dedup', reason: 'Server Error' });
    assert.equal(postCalled, false);
  });

  test('reports a post-stage failure when createPullRequestReview errors', async () => {
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        createPullRequestReview: async () => {
          throw Object.assign(new Error('Validation Failed'), { status: 422 });
        },
      })
    );
    assert.deepEqual(outcome, { status: 'failed', stage: 'post', reason: 'Validation Failed' });
  });

  test('never leaks error internals - only status/message reach the outcome', async () => {
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        getPullRequest: async () => {
          const err = new Error('Bad credentials') as Error & { request?: unknown; headers?: unknown };
          err.request = { headers: { Authorization: 'token super-secret-value' } };
          throw err;
        },
      })
    );
    assert.equal(outcome.status, 'failed');
    assert.equal(JSON.stringify(outcome).includes('super-secret-value'), false);
  });
});

describe('reviewPullRequest filtering and dedup behavior', () => {
  test('skips entirely when every changed file is ignored', async () => {
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({ getChangedFiles: async () => changedFilesPage([lockfile], 1, 1, 100) })
    );
    assert.deepEqual(outcome, { status: 'skipped', reason: 'no_reviewable_files' });
  });

  test('moves a finding whose file is not part of the reviewed diff into the summary, never as an inline comment', async () => {
    const log = capturingLogger();
    let capturedComments: unknown[] | undefined;
    let capturedBody = '';
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        logger: log,
        runClaudeReview: async () => ({
          summary: 'ok',
          issues: [{ severity: 'high', file: 'src/does-not-exist.ts', line: 1, title: 'Bogus finding', explanation: 'explanation text', suggestedFix: 'fix it' }],
        }),
        createPullRequestReview: async (params) => {
          capturedComments = params.comments;
          capturedBody = params.body ?? '';
          return { id: 1, url: 'https://example.test', state: 'COMMENTED', submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );
    assert.equal(outcome.status, 'posted');
    if (outcome.status === 'posted') {
      assert.equal(outcome.newCommentCount, 0);
      assert.equal(outcome.summaryOnlyCount, 1);
    }
    assert.deepEqual(capturedComments, []);
    assert.match(capturedBody, /Bogus finding/);
    assert.match(capturedBody, /explanation text/);
    assert.ok(log.calls.some((c) => c.level === 'warn' && c.message.includes('could not be safely mapped')));
  });

  test('moves a finding whose line is outside every diff hunk into the summary instead of posting on the wrong line', async () => {
    let capturedComments: unknown[] | undefined;
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        runClaudeReview: async () => ({
          summary: 'ok',
          issues: [{ severity: 'low', file: 'src/checkout.ts', line: 9999, title: 'Out of range', explanation: 'x', suggestedFix: 'fix-x' }],
        }),
        createPullRequestReview: async (params) => {
          capturedComments = params.comments;
          return { id: 1, url: '', state: 'COMMENTED', submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );
    assert.equal(outcome.status, 'posted');
    if (outcome.status === 'posted') {
      assert.equal(outcome.newCommentCount, 0);
      assert.equal(outcome.summaryOnlyCount, 1);
    }
    assert.deepEqual(capturedComments, []);
  });

  test('never posts an inline comment on a context line, even when it falls within a hunk range', async () => {
    // Line 10 in `reviewableFile`'s patch is a context line (present in the diff, but never
    // changed) - the old range-based check would have accepted it; the new one must not.
    let capturedComments: unknown[] | undefined;
    await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        runClaudeReview: async () => ({
          summary: 'ok',
          issues: [{ severity: 'low', file: 'src/checkout.ts', line: 10, title: 'On a context line', explanation: 'x', suggestedFix: 'fix-x' }],
        }),
        createPullRequestReview: async (params) => {
          capturedComments = params.comments;
          return { id: 1, url: '', state: 'COMMENTED', submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );
    assert.deepEqual(capturedComments, []);
  });

  test('skips posting when every valid finding was already posted in a previous run', async () => {
    const { fingerprintIssue } = await import('./fingerprint.js');
    const existingFp = fingerprintIssue({ repository: 'acme/widgets', pullNumber: 42 }, 'src/checkout.ts', 11, 'Unsynchronized inventory update');

    let postCalled = false;
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        getExistingReviewComments: async () => ({
          repository: 'acme/widgets',
          number: 42,
          filtered_by_author: 'pr-review-bot',
          count: 1,
          comments: [
            {
              id: 1,
              path: 'src/checkout.ts',
              line: 11,
              side: 'RIGHT',
              body: `already posted <!-- pr-review-agent:fingerprint=${existingFp} -->`,
              author: 'pr-review-bot',
              created_at: '',
              updated_at: '',
              in_reply_to_id: null,
              commit_id: 'head-sha',
            },
          ],
        }),
        createPullRequestReview: async (params) => {
          postCalled = true;
          return { id: 1, url: '', state: '', submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );

    assert.deepEqual(outcome, { status: 'skipped', reason: 'all_findings_already_posted' });
    assert.equal(postCalled, false);
  });
});

describe('reviewPullRequest summary comment content', () => {
  test('posts the exact fixed message when Claude finds no issues', async () => {
    let capturedBody = '';
    await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        runClaudeReview: async () => ({ summary: 'Looks clean to me.', issues: [] }),
        createPullRequestReview: async (params) => {
          capturedBody = params.body ?? '';
          return { id: 1, url: '', state: 'COMMENTED', submitted_at: null, comments_count: 0 };
        },
      })
    );
    assert.equal(capturedBody, '✅ No significant issues found in the changed code.');
  });

  test('includes a total + per-severity breakdown covering every issue Claude returned', async () => {
    let capturedBody = '';
    await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        runClaudeReview: async () => ({
          summary: 'Two problems found.',
          issues: [
            { severity: 'critical', file: 'src/checkout.ts', line: 11, title: 'Critical one', explanation: 'e1', suggestedFix: 'f1' },
            { severity: 'high', file: 'src/checkout.ts', line: 12, title: 'High one', explanation: 'e2', suggestedFix: 'f2' },
          ],
        }),
        createPullRequestReview: async (params) => {
          capturedBody = params.body ?? '';
          return { id: 1, url: '', state: 'COMMENTED', submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );
    assert.match(capturedBody, /\*\*Issues found:\*\* 2/);
    assert.match(capturedBody, /Critical: 1/);
    assert.match(capturedBody, /High: 1/);
    assert.match(capturedBody, /Medium: 0/);
    assert.match(capturedBody, /Low: 0/);
  });

  test('overall review result requests changes when a critical issue is present', async () => {
    let capturedBody = '';
    await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        runClaudeReview: async () => ({
          summary: 'ok',
          issues: [{ severity: 'critical', file: 'src/checkout.ts', line: 11, title: 't', explanation: 'e', suggestedFix: 'f' }],
        }),
        createPullRequestReview: async (params) => {
          capturedBody = params.body ?? '';
          return { id: 1, url: '', state: 'COMMENTED', submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );
    assert.match(capturedBody, /\*\*Overall review result:\*\* ⚠️ Changes requested.*1 critical/);
  });

  test('overall review result requests changes for high severity when there is no critical issue', async () => {
    let capturedBody = '';
    await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        runClaudeReview: async () => ({
          summary: 'ok',
          issues: [{ severity: 'high', file: 'src/checkout.ts', line: 11, title: 't', explanation: 'e', suggestedFix: 'f' }],
        }),
        createPullRequestReview: async (params) => {
          capturedBody = params.body ?? '';
          return { id: 1, url: '', state: 'COMMENTED', submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );
    assert.match(capturedBody, /\*\*Overall review result:\*\* ⚠️ Changes requested.*high-severity/);
  });

  test('overall review result is approved-with-suggestions when only medium/low issues exist', async () => {
    let capturedBody = '';
    await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        runClaudeReview: async () => ({
          summary: 'ok',
          issues: [
            { severity: 'medium', file: 'src/checkout.ts', line: 11, title: 't1', explanation: 'e', suggestedFix: 'f' },
            { severity: 'low', file: 'src/checkout.ts', line: 12, title: 't2', explanation: 'e', suggestedFix: 'f' },
          ],
        }),
        createPullRequestReview: async (params) => {
          capturedBody = params.body ?? '';
          return { id: 1, url: '', state: 'COMMENTED', submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );
    assert.match(capturedBody, /\*\*Overall review result:\*\* ✅ Approved with minor suggestions/);
  });
});

describe('reviewPullRequest duplicate-review protection across multiple reviews', () => {
  // Simulates the real scenario end to end across two sequential reviewPullRequest() calls
  // sharing one in-memory "posted comments" list - exactly what GitHub itself would hold
  // between two pushes to the same PR. No database or extra persistence layer is used or
  // needed: GitHub's own existing comments (returned by getExistingReviewComments) are the only
  // state duplicate-detection depends on.
  function sharedGithubState() {
    const postedComments: { id: number; path: string; line: number | null; side: 'RIGHT'; body: string; author: string; created_at: string; updated_at: string; in_reply_to_id: null; commit_id: string }[] = [];
    let nextId = 1;
    return {
      getExistingReviewComments: async () => ({
        repository: 'acme/widgets',
        number: 42,
        filtered_by_author: 'pr-review-bot',
        count: postedComments.length,
        comments: postedComments,
      }),
      createPullRequestReview: async (params: { comments?: { path: string; line: number; side?: 'LEFT' | 'RIGHT'; body: string }[]; commitId?: string }) => {
        for (const c of params.comments ?? []) {
          postedComments.push({
            id: nextId++,
            path: c.path,
            line: c.line,
            side: 'RIGHT',
            body: c.body,
            author: 'pr-review-bot',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            in_reply_to_id: null,
            commit_id: params.commitId ?? 'unknown-sha',
          });
        }
        return { id: nextId, url: '', state: 'COMMENTED', submitted_at: null, comments_count: params.comments?.length ?? 0 };
      },
    };
  }

  test('requirement 3: the same unchanged finding is not re-posted on a later review of the same PR', async () => {
    const state = sharedGithubState();
    const findingIssue = { severity: 'high' as const, file: 'src/checkout.ts', line: 11, title: 'Race condition', explanation: 'e', suggestedFix: 'f' };

    const run1 = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({ ...state, runClaudeReview: async () => ({ summary: 'Found a race condition.', issues: [findingIssue] }) })
    );
    assert.equal(run1.status, 'posted');
    if (run1.status === 'posted') assert.equal(run1.newCommentCount, 1);

    // Second review of the SAME PR (e.g. a redundant re-trigger) - Claude reports the identical
    // finding again, since the code hasn't actually changed.
    const run2 = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({ ...state, runClaudeReview: async () => ({ summary: 'Found a race condition.', issues: [findingIssue] }) })
    );
    assert.deepEqual(run2, { status: 'skipped', reason: 'all_findings_already_posted' });
  });

  test('requirement 5: an issue fixed in a new commit is not reported again, without any special-case handling', async () => {
    const state = sharedGithubState();
    const findingIssue = { severity: 'high' as const, file: 'src/checkout.ts', line: 11, title: 'Race condition', explanation: 'e', suggestedFix: 'f' };

    // Run 1, against commit "sha-1": Claude finds the issue, it gets posted.
    const run1 = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        ...state,
        getPullRequest: async () => ({ ...pr, head: { ref: pr.head.ref, sha: 'sha-1' } }),
        runClaudeReview: async () => ({ summary: 'Found a race condition.', issues: [findingIssue] }),
      })
    );
    assert.equal(run1.status, 'posted');
    if (run1.status === 'posted') assert.equal(run1.newCommentCount, 1);

    // Run 2, after a new commit "sha-2" that fixes it: Claude's response for the new diff simply
    // doesn't include the finding anymore - nothing here has to know it "used to" exist.
    const run2 = await reviewPullRequest(
      'acme',
      'widgets',
      42,
      baseDeps({
        ...state,
        getPullRequest: async () => ({ ...pr, head: { ref: pr.head.ref, sha: 'sha-2' } }),
        runClaudeReview: async () => ({ summary: 'No issues found - the fix looks correct.', issues: [] }),
      })
    );
    assert.equal(run2.status, 'posted');
    if (run2.status === 'posted') {
      assert.equal(run2.newCommentCount, 0);
      assert.equal(run2.totalFindings, 0);
    }
  });
});
