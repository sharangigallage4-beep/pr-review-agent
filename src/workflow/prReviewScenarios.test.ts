import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reviewPullRequest } from './reviewPullRequestWorkflow.js';
import type { ReviewPullRequestDeps } from './reviewPullRequestWorkflow.js';
import type { WorkflowLogger } from './logger.js';
import type { ReviewIssue } from '../review/types.js';

// End-to-end scenario tests for the automated PR review system, matching TEST 1-7 as specified.
//
// IMPORTANT ABOUT WHAT THESE PROVE: no ANTHROPIC_API_KEY is configured in this environment, so
// these do NOT make a real Claude API call - `runClaudeReview` is injected with a fixed response
// representing what Claude would plausibly return for each realistic PR. What these tests
// verify is the SYSTEM's handling of that response: diff-line mapping to the correct file/line,
// inline-vs-summary routing, severity-aware summary content, and duplicate detection across
// multiple reviews - the same orchestration logic regardless of which specific finding Claude
// produces. They do not verify Claude's own judgment (e.g. "would Claude actually flag this
// SQL query"); that requires a real key and `npm run review` against an actual PR.

const silentLogger: WorkflowLogger = { info: () => {}, warn: () => {}, error: () => {} };

const basePr = {
  repository: 'acme/widgets',
  number: 100,
  title: 'Test PR',
  description: '',
  author: 'dev',
  state: 'open',
  draft: false,
  base: { ref: 'main', sha: 'base-sha' },
  head: { ref: 'feature-branch', sha: 'head-sha-1' },
  url: 'https://github.com/acme/widgets/pull/100',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

interface FileFixture {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch: string;
}

function changedFile(overrides: Partial<FileFixture> & { filename: string; patch: string }): FileFixture {
  return { status: 'modified', additions: 1, deletions: 0, ...overrides };
}

function deps(
  files: FileFixture[],
  runClaudeReview: ReviewPullRequestDeps['runClaudeReview'],
  overrides: Partial<ReviewPullRequestDeps> = {}
): Partial<ReviewPullRequestDeps> {
  return {
    getPullRequest: async () => basePr,
    getChangedFiles: async () => ({
      repository: basePr.repository,
      number: basePr.number,
      total_count: files.length,
      page: 1,
      per_page: 100,
      files: files.map((f) => ({ ...f, previous_filename: null, changes: f.additions + f.deletions })),
    }),
    getPullRequestDiff: async () => ({ repository: basePr.repository, number: basePr.number, truncated: false, total_bytes: 0, diff: '' }),
    getExistingReviewComments: async () => ({ repository: basePr.repository, number: basePr.number, filtered_by_author: 'pr-review-bot', count: 0, comments: [] }),
    createPullRequestReview: async (params) => ({
      id: 1,
      url: 'https://github.com/acme/widgets/pull/100#pullrequestreview-1',
      state: params.event,
      submitted_at: '2026-01-01T00:00:00Z',
      comments_count: params.comments?.length ?? 0,
    }),
    runClaudeReview,
    knownBotLogin: 'pr-review-bot',
    logger: silentLogger,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// TEST 1: A PR containing a clear bug -> Claude identifies it, an inline comment is created.
// ---------------------------------------------------------------------------------------------

describe('TEST 1: clear bug', () => {
  // src/utils.ts, new file - line 2 has a classic off-by-one: items.length is out of bounds,
  // should be items.length - 1.
  const files = [
    changedFile({
      filename: 'src/utils.ts',
      status: 'added',
      additions: 3,
      patch: ['@@ -0,0 +1,3 @@', '+function getLastItem(items) {', '+  return items[items.length];', '+}'].join('\n'),
    }),
  ];

  const finding: ReviewIssue = {
    severity: 'high',
    file: 'src/utils.ts',
    line: 2,
    title: 'Off-by-one array index',
    explanation: 'items[items.length] is always undefined - valid indices only go up to items.length - 1, so this never returns the last item.',
    suggestedFix: 'Use items[items.length - 1].',
  };

  test('Claude identifies the bug and an inline comment is posted at the exact line', async () => {
    let capturedComments: { path: string; line: number; body: string }[] | undefined;
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      100,
      deps(files, async () => ({ summary: 'Found an off-by-one bug.', issues: [finding] }), {
        createPullRequestReview: async (params) => {
          capturedComments = params.comments as { path: string; line: number; body: string }[];
          return { id: 1, url: '', state: params.event, submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );

    assert.equal(outcome.status, 'posted');
    if (outcome.status === 'posted') {
      assert.equal(outcome.newCommentCount, 1);
      assert.equal(outcome.totalFindings, 1);
    }
    assert.equal(capturedComments?.length, 1);
    assert.equal(capturedComments?.[0].path, 'src/utils.ts');
    assert.equal(capturedComments?.[0].line, 2);
    assert.match(capturedComments?.[0].body ?? '', /\[HIGH\] Off-by-one array index/);
  });
});

// ---------------------------------------------------------------------------------------------
// TEST 2: A PR containing a security vulnerability -> HIGH or CRITICAL severity.
// ---------------------------------------------------------------------------------------------

describe('TEST 2: security vulnerability', () => {
  const files = [
    changedFile({
      filename: 'src/db.js',
      status: 'added',
      additions: 7,
      patch: [
        '@@ -0,0 +1,7 @@',
        '+app.get("/user/:id", async (req, res) => {',
        '+    const user = await db.query(',
        '+        `SELECT * FROM users WHERE id = ${req.params.id}`',
        '+    );',
        '+',
        '+    res.json(user);',
        '+});',
      ].join('\n'),
    }),
  ];

  const finding: ReviewIssue = {
    severity: 'critical',
    file: 'src/db.js',
    line: 3,
    title: 'SQL injection via string interpolation',
    explanation: 'req.params.id is interpolated directly into the SQL query, letting an attacker inject arbitrary SQL through the URL.',
    suggestedFix: 'Use a parameterized query: db.query("SELECT * FROM users WHERE id = ?", [req.params.id]).',
  };

  test('Claude identifies the vulnerability with CRITICAL (or HIGH) severity', async () => {
    let capturedComments: { path: string; line: number; body: string }[] | undefined;
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      100,
      deps(files, async () => ({ summary: 'Found a SQL injection vulnerability.', issues: [finding] }), {
        createPullRequestReview: async (params) => {
          capturedComments = params.comments as { path: string; line: number; body: string }[];
          return { id: 1, url: '', state: params.event, submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );

    assert.equal(outcome.status, 'posted');
    assert.equal(capturedComments?.length, 1);
    assert.match(capturedComments?.[0].body ?? '', /\[CRITICAL\]|\[HIGH\]/);
    assert.match(capturedComments?.[0].body ?? '', /SQL injection/i);
    assert.equal(capturedComments?.[0].path, 'src/db.js');
    assert.equal(capturedComments?.[0].line, 3);
  });
});

// ---------------------------------------------------------------------------------------------
// TEST 3: A clean PR -> no unnecessary comments, one clean-review summary.
// ---------------------------------------------------------------------------------------------

describe('TEST 3: clean PR', () => {
  const files = [
    changedFile({
      filename: 'src/validators.ts',
      status: 'added',
      additions: 4,
      patch: [
        '@@ -0,0 +1,4 @@',
        '+function isValidEmail(email) {',
        "+  if (typeof email !== 'string') return false;",
        '+  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);',
        '+}',
      ].join('\n'),
    }),
  ];

  test('no issues reported, and the summary is the exact required clean-review message', async () => {
    let capturedComments: unknown[] | undefined;
    let capturedBody = '';
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      100,
      deps(files, async () => ({ summary: 'The code is correct and well-validated.', issues: [] }), {
        createPullRequestReview: async (params) => {
          capturedComments = params.comments;
          capturedBody = params.body ?? '';
          return { id: 1, url: '', state: params.event, submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );

    assert.equal(outcome.status, 'posted');
    if (outcome.status === 'posted') assert.equal(outcome.newCommentCount, 0);
    assert.deepEqual(capturedComments, []);
    assert.equal(capturedBody, '✅ No significant issues found in the changed code.');
  });
});

// ---------------------------------------------------------------------------------------------
// TEST 4: A PR containing only formatting/style changes -> no unnecessary comments.
// ---------------------------------------------------------------------------------------------

describe('TEST 4: formatting/style-only PR', () => {
  const files = [
    changedFile({
      filename: 'src/math.ts',
      status: 'modified',
      additions: 3,
      deletions: 1,
      patch: [
        '@@ -1,1 +1,3 @@',
        '-function add(a,b){return a+b;}',
        '+function add(a, b) {',
        '+  return a + b;',
        '+}',
      ].join('\n'),
    }),
  ];

  test('Claude reports nothing for a purely cosmetic reformat, and no comments are posted', async () => {
    let capturedComments: unknown[] | undefined;
    let capturedBody = '';
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      100,
      // A correctly-behaving reviewer, per the system prompt's own "no style/formatting" rule,
      // returns an empty issues array here - this fixture represents that expected behavior.
      deps(files, async () => ({ summary: 'Only formatting changed - no functional difference.', issues: [] }), {
        createPullRequestReview: async (params) => {
          capturedComments = params.comments;
          capturedBody = params.body ?? '';
          return { id: 1, url: '', state: params.event, submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );

    assert.equal(outcome.status, 'posted');
    if (outcome.status === 'posted') assert.equal(outcome.newCommentCount, 0);
    assert.deepEqual(capturedComments, []);
    assert.equal(capturedBody, '✅ No significant issues found in the changed code.');
  });
});

// ---------------------------------------------------------------------------------------------
// TEST 5: Multiple files, multiple issues -> comments map to the correct file/line each.
// ---------------------------------------------------------------------------------------------

describe('TEST 5: multi-file, multi-issue PR', () => {
  const files = [
    changedFile({
      filename: 'src/auth.ts',
      status: 'modified',
      additions: 2,
      patch: [
        '@@ -10,2 +10,4 @@',
        ' function getUser(req) {',
        '+  const token = req.headers.authorization;',
        "+  return db.findUser(token.split(' ')[1]);",
        ' }',
      ].join('\n'),
    }),
    changedFile({
      filename: 'src/payment.ts',
      status: 'modified',
      additions: 2,
      patch: [
        '@@ -20,2 +20,4 @@',
        ' function chargeCard(account, amount) {',
        '+  account.balance -= amount;',
        '+  saveAccount(account);',
        ' }',
      ].join('\n'),
    }),
  ];

  const authFinding: ReviewIssue = {
    severity: 'high',
    file: 'src/auth.ts',
    line: 12,
    title: 'Missing null check before splitting the authorization header',
    explanation: 'If the Authorization header is absent, token is undefined and token.split(...) throws, crashing the request instead of returning 401.',
    suggestedFix: "Check `if (!token) return res.status(401).end();` before calling token.split(' ').",
  };

  const paymentFinding: ReviewIssue = {
    severity: 'medium',
    file: 'src/payment.ts',
    line: 21,
    title: 'Unsynchronized balance update',
    explanation: 'account.balance is read and written without any locking, so two concurrent charges on the same account can race and leave the balance inconsistent.',
    suggestedFix: 'Perform the balance update as an atomic database operation (e.g. a single UPDATE ... SET balance = balance - ? statement) instead of read-modify-write in application code.',
  };

  test('each finding is mapped to its own correct file and line', async () => {
    let capturedComments: { path: string; line: number; body: string }[] | undefined;
    const outcome = await reviewPullRequest(
      'acme',
      'widgets',
      100,
      deps(files, async () => ({ summary: 'Two issues found across two files.', issues: [authFinding, paymentFinding] }), {
        createPullRequestReview: async (params) => {
          capturedComments = params.comments as { path: string; line: number; body: string }[];
          return { id: 1, url: '', state: params.event, submitted_at: null, comments_count: params.comments?.length ?? 0 };
        },
      })
    );

    assert.equal(outcome.status, 'posted');
    if (outcome.status === 'posted') assert.equal(outcome.newCommentCount, 2);
    assert.equal(capturedComments?.length, 2);

    const authComment = capturedComments?.find((c) => c.path === 'src/auth.ts');
    const paymentComment = capturedComments?.find((c) => c.path === 'src/payment.ts');

    assert.ok(authComment, 'expected a comment on src/auth.ts');
    assert.equal(authComment?.line, 12);
    assert.match(authComment?.body ?? '', /\[HIGH\]/);

    assert.ok(paymentComment, 'expected a comment on src/payment.ts');
    assert.equal(paymentComment?.line, 21);
    assert.match(paymentComment?.body ?? '', /\[MEDIUM\]/);
  });
});

// ---------------------------------------------------------------------------------------------
// TEST 6: A second commit fixes an existing issue -> the bot does not report it again.
// ---------------------------------------------------------------------------------------------

describe('TEST 6: issue fixed in a follow-up commit', () => {
  const files = [
    changedFile({
      filename: 'src/utils.ts',
      status: 'added',
      additions: 3,
      patch: ['@@ -0,0 +1,3 @@', '+function getLastItem(items) {', '+  return items[items.length];', '+}'].join('\n'),
    }),
  ];

  const finding: ReviewIssue = {
    severity: 'high',
    file: 'src/utils.ts',
    line: 2,
    title: 'Off-by-one array index',
    explanation: 'items[items.length] is always undefined.',
    suggestedFix: 'Use items[items.length - 1].',
  };

  test('run 1 (buggy) posts the finding; run 2 (fixed, new commit) reports nothing about it', async () => {
    const postedComments: { id: number; path: string; line: number | null; side: 'RIGHT'; body: string; author: string; created_at: string; updated_at: string; in_reply_to_id: null; commit_id: string }[] = [];
    let nextId = 1;

    const sharedGithub = {
      getExistingReviewComments: async () => ({
        repository: basePr.repository,
        number: basePr.number,
        filtered_by_author: 'pr-review-bot',
        count: postedComments.length,
        comments: postedComments,
      }),
      createPullRequestReview: async (params: { comments?: { path: string; line: number; body: string }[]; event: string; commitId?: string }) => {
        for (const c of params.comments ?? []) {
          postedComments.push({
            id: nextId++,
            path: c.path,
            line: c.line,
            side: 'RIGHT' as const,
            body: c.body,
            author: 'pr-review-bot',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            in_reply_to_id: null,
            commit_id: params.commitId ?? 'unknown',
          });
        }
        return { id: nextId, url: '', state: params.event, submitted_at: null, comments_count: params.comments?.length ?? 0 };
      },
    };

    // Run 1: commit "sha-buggy" - the bug exists, Claude finds it, it gets posted.
    const run1 = await reviewPullRequest(
      'acme',
      'widgets',
      100,
      deps(files, async () => ({ summary: 'Found an off-by-one bug.', issues: [finding] }), {
        ...sharedGithub,
        getPullRequest: async () => ({ ...basePr, head: { ref: basePr.head.ref, sha: 'sha-buggy' } }),
      })
    );
    assert.equal(run1.status, 'posted');
    if (run1.status === 'posted') assert.equal(run1.newCommentCount, 1);

    // Run 2: commit "sha-fixed" - the developer pushed a fix; Claude's response for the new diff
    // simply no longer includes the finding.
    const run2 = await reviewPullRequest(
      'acme',
      'widgets',
      100,
      deps(files, async () => ({ summary: 'The off-by-one bug has been fixed.', issues: [] }), {
        ...sharedGithub,
        getPullRequest: async () => ({ ...basePr, head: { ref: basePr.head.ref, sha: 'sha-fixed' } }),
      })
    );

    assert.equal(run2.status, 'posted');
    if (run2.status === 'posted') {
      assert.equal(run2.newCommentCount, 0);
      assert.equal(run2.totalFindings, 0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// TEST 7: Running the workflow twice for the SAME commit -> no duplicate comments.
// ---------------------------------------------------------------------------------------------

describe('TEST 7: the same commit reviewed twice', () => {
  const files = [
    changedFile({
      filename: 'src/db.js',
      status: 'added',
      additions: 7,
      patch: [
        '@@ -0,0 +1,7 @@',
        '+app.get("/user/:id", async (req, res) => {',
        '+    const user = await db.query(',
        '+        `SELECT * FROM users WHERE id = ${req.params.id}`',
        '+    );',
        '+',
        '+    res.json(user);',
        '+});',
      ].join('\n'),
    }),
  ];

  const finding: ReviewIssue = {
    severity: 'critical',
    file: 'src/db.js',
    line: 3,
    title: 'SQL injection via string interpolation',
    explanation: 'req.params.id is interpolated directly into the SQL query.',
    suggestedFix: 'Use a parameterized query.',
  };

  test('re-running the workflow for the same commit does not post the same finding twice', async () => {
    const postedComments: { id: number; path: string; line: number | null; side: 'RIGHT'; body: string; author: string; created_at: string; updated_at: string; in_reply_to_id: null; commit_id: string }[] = [];
    let nextId = 1;
    let postCallCount = 0;

    const sharedGithub = {
      getExistingReviewComments: async () => ({
        repository: basePr.repository,
        number: basePr.number,
        filtered_by_author: 'pr-review-bot',
        count: postedComments.length,
        comments: postedComments,
      }),
      createPullRequestReview: async (params: { comments?: { path: string; line: number; body: string }[]; event: string; commitId?: string }) => {
        postCallCount += 1;
        for (const c of params.comments ?? []) {
          postedComments.push({
            id: nextId++,
            path: c.path,
            line: c.line,
            side: 'RIGHT' as const,
            body: c.body,
            author: 'pr-review-bot',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            in_reply_to_id: null,
            commit_id: params.commitId ?? 'unknown',
          });
        }
        return { id: nextId, url: '', state: params.event, submitted_at: null, comments_count: params.comments?.length ?? 0 };
      },
    };

    const runOnce = () =>
      reviewPullRequest(
        'acme',
        'widgets',
        100,
        deps(files, async () => ({ summary: 'Found a SQL injection vulnerability.', issues: [finding] }), sharedGithub)
      );

    const run1 = await runOnce();
    assert.equal(run1.status, 'posted');
    if (run1.status === 'posted') assert.equal(run1.newCommentCount, 1);

    // Re-run the exact same workflow again (e.g. a redundant webhook redelivery, or someone
    // manually re-triggering it) - Claude, asked again, reports the identical finding.
    const run2 = await runOnce();
    assert.deepEqual(run2, { status: 'skipped', reason: 'all_findings_already_posted' });

    // Only the first run's post call actually reached createPullRequestReview.
    assert.equal(postCallCount, 1);
    assert.equal(postedComments.length, 1);
  });
});
