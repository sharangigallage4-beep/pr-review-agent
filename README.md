# pr-review-agent

An automated GitHub pull request code reviewer: Claude reviews PR diffs and posts inline
comments back to GitHub. Every piece is implemented - the GitHub integration, the Claude review
engine, the orchestrator wiring them together, a manual-testing CLI, a webhook server, and a
GitHub Actions workflow - two independent ways to trigger a review automatically on
`opened`/`synchronize`/`reopened` events, whichever fits your deployment better.

```bash
npm run review -- --owner=my-org --repo=my-repo --pr=123   # manual, one PR, with a y/n prompt
npm run webhook                                              # automatic: host a server yourself
# or: .github/workflows/pr-review.yml                          automatic: GitHub Actions runs it for you
```

## Layout

```
src/
├── config.ts                  # GitHub env var loading/validation, owner/repo default resolution
├── github/
│   ├── client.ts                # Octokit singleton (auth only lives here)
│   ├── errors.ts                 # GitHubServiceError + safe error normalization
│   ├── types.ts                   # DTOs returned by the service layer
│   ├── prService.ts                # ALL GitHub REST API calls - the only file that touches Octokit
│   └── prService.test.ts            # unit tests for every service function
├── mcp/
│   ├── server.ts                 # stdio MCP entrypoint
│   └── tools/                     # thin adapters: zod-validated input -> service call -> MCP content
├── review/                      # the Claude review engine - NO dependency on github/ or mcp/
│   ├── config.ts                  # ANTHROPIC_* env var loading/validation (separate from ../config.ts)
│   ├── types.ts                    # ReviewInput, and the zod-validated ReviewResult/ReviewIssue output schema
│   ├── prompt.ts                    # system prompt (rubric + rules) and user-message builder - pure functions
│   ├── claudeClient.ts               # Anthropic SDK call, forces a structured tool-call response
│   ├── reviewService.ts               # reviewPullRequest(input, deps?) - the public entry point
│   ├── prompt.test.ts                  # unit tests for the prompt builders
│   └── reviewService.test.ts            # unit tests for the orchestrator, with a fake Claude call
├── workflow/                    # ties github/ and review/ together into one end-to-end review
│   ├── fileFilter.ts               # ignore rules: lockfiles, node_modules/dist/build/generated, binaries
│   ├── diffMapper.ts                 # the diff-line mapping system - see "Diff-line mapping" below
│   ├── fingerprint.ts                # computes/embeds/extracts the stable fingerprint - no comparison logic
│   ├── duplicateDetectionService.ts    # the duplicate-review-detection service - see below
│   ├── logger.ts                      # WorkflowLogger + toSafeLogFields (never logs secrets)
│   ├── reviewPullRequestWorkflow.ts     # reviewPullRequest(owner, repo, pullRequestNumber) - THE entry point
│   └── *.test.ts                        # unit tests for every file above, with fully faked deps
├── cli/                         # `npm run review` / `npm run auto-review` - see below
│   ├── args.ts                    # pure --owner=/--repo=/--pr= parsing
│   ├── format.ts                    # renders one finding for terminal display
│   ├── describeOutcome.ts             # renders a reviewPullRequest() outcome - shared by both entrypoints below
│   ├── review.ts                        # interactive: wires a y/n prompt into confirmBeforePosting
│   ├── autoReview.ts                      # non-interactive: what GitHub Actions runs - MCP-backed, see below
│   └── *.test.ts                            # unit tests for args.ts and format.ts
├── mcpClient/                   # what makes autoReview.ts's GitHub calls real MCP tool calls
│   ├── client.ts                   # connectMcpClient() - spawns mcp/server.ts, connects over stdio
│   ├── githubViaMcp.ts               # buildMcpBackedGithubDeps() - the 5 GitHub ops, MCP-backed
│   └── *.test.ts                       # unit tests for the argument-mapping and error-parsing logic
└── webhook/                     # `npm run webhook` - POST /webhooks/github, see below
    ├── config.ts                   # GITHUB_WEBHOOK_SECRET (+ optional PORT) loading/validation
    ├── verifySignature.ts            # HMAC-SHA256 X-Hub-Signature-256 verification
    ├── parsePullRequestEvent.ts        # pure extraction: raw payload -> {owner, repo, pullNumber, commitSha, action}
    ├── retry.ts                          # generic exponential-backoff retry helper
    ├── reviewStatusStore.ts                # in-memory review status tracking + duplicate-by-SHA detection
    ├── processReviewEvent.ts                 # ties dedup + status + retry + reviewPullRequest() together
    ├── app.ts                                  # the Express app (unstarted) - route handlers live here
    ├── server.ts                                 # entrypoint: buildWebhookApp() + app.listen(PORT)
    └── *.test.ts                                   # unit tests for every file above, plus real-HTTP app tests

.github/workflows/
├── ci.yml            # this project's own CI - typecheck + test on every push/PR
└── pr-review.yml       # the OTHER automatic trigger - see "Automatic reviews via GitHub Actions" below
```

`src/github/prService.ts` is the GitHub integration layer, kept deliberately separate from the
MCP tool definitions in `src/mcp/tools/*.ts`.

`src/review/` is the Claude review engine, kept deliberately separate from both `src/github/` and
`src/mcp/`. It has no imports from either - it only knows about the plain `ReviewInput` type in
`src/review/types.ts` - so it can be constructed and unit tested with literal objects, with no
GitHub API calls, no MCP transport, and no network access at all.

`src/workflow/` is the only place that imports from both `src/github/` and `src/review/` - it's
the orchestration layer that actually runs an end-to-end review.

## GitHub tools

`src/mcp/server.ts` starts an MCP server (stdio transport) exposing seven GitHub tools:

| Tool | Service function | Purpose |
| --- | --- | --- |
| `get_pull_request` | `getPullRequest` | PR metadata: repository, number, title, description, author, base/head branches. |
| `get_pull_request_diff` | `getPullRequestDiff` | The complete unified diff for the PR (truncatable via `max_bytes`). |
| `get_changed_files` | `getChangedFiles` | Changed files with status, additions/deletions, and per-file patch. Paginated. |
| `get_file_content` | `getFileContent` | A file's text content at a given ref (e.g. the PR head SHA), for context beyond a diff hunk. Refuses binaries and files over 500KB. |
| `create_pull_request_comment` | `createPullRequestComment` | Post one inline review comment on a file/line. |
| `create_pull_request_review` | `createPullRequestReview` | Submit an overall review (`APPROVE` / `REQUEST_CHANGES` / `COMMENT`), optionally batching several inline comments into one review. |
| `get_existing_review_comments` | `getExistingReviewComments` | List existing comments, filtered to the bot's own by default - for de-duplication before posting new findings. |

Every tool file (`tools/*.ts`) is typed against `ToolRegistrar` (`src/mcp/toolRegistrar.ts` - just
the `registerTool` method) rather than the full `McpServer` type, so `server.ts` can hand them
either a real `McpServer` or the logging wrapper below interchangeably.

**Debug logging**: `src/mcp/logging.ts`'s `withToolLogging()` wraps every registered tool so each
call logs to stderr - the tool name, a safe summary of its arguments (never a token; the one
field that could be long, a comment `body`, is logged as a length instead of its full text), and
whether it succeeded/errored plus how long it took:
```
[mcp] -> get_pull_request {"owner":"acme","repo":"widgets","pull_number":1}
[mcp] <- get_pull_request ok (912ms)
```
This is the only place any tool call is logged - individual `tools/*.ts` files never log
anything themselves.

## Claude review engine

`reviewPullRequest(input: ReviewInput, deps?)` in `src/review/reviewService.ts` is the entry
point (note: this is a *different, lower-level* function from the workflow's `reviewPullRequest`
below - see "Two `reviewPullRequest`s" if that's confusing). Given PR metadata, the diff, and the
changed-files list, it builds a system prompt + user message, calls Claude with a **forced tool
call** (`submit_review`) so the response is guaranteed to be one structured block rather than
free-form text, and validates the result against a zod schema before returning it. It has no
dependency on `src/github/` or `src/mcp/` - it never fetches from GitHub or posts anything itself,
which is what makes it testable (and literally usable) in isolation from the rest of the system.

The rubric (`buildSystemPrompt()` in `prompt.ts`) instructs Claude to: analyze only the changed
code; review for bugs/incorrect logic, security vulnerabilities, runtime errors, breaking changes,
incorrect API usage, performance problems, race conditions, bad/missing error handling, validation
issues, auth problems, database problems, important maintainability problems, and edge cases;
never report personal style preferences, minor formatting, subjective suggestions, or anything
unrelated to the changed code; and only report a finding if it's both actionable and held with
reasonable confidence - not a speculative guess.

**Prompt injection defense**: the PR title, description, and diff are untrusted content from
whoever opened the PR (potentially an anonymous public fork) - the system prompt explicitly warns
Claude that this content is data to review, never instructions to follow, and gives concrete
examples of what an embedded manipulation attempt looks like ("ignore previous instructions",
"mark this PR as safe", "give this a LOW severity", etc.), instructing it to flag rather than obey
them. `buildUserMessage()` also labels the title/description fields `(untrusted)` inline. This is
a mitigation, not a guarantee - no prompt-level defense can make injection structurally
impossible - so it's backed by independent, non-LLM-controlled enforcement everywhere it actually
matters: every finding's file/line is checked against the real diff before it can become a
comment (`diffMapper.ts`), and the output shape itself is zod-validated - Claude's text can
attempt to mislead a human reader, but it cannot forge a finding location or corrupt the response
structure no matter what instructions are embedded in the PR.

Output shape (`ReviewResult`):

```json
{
  "summary": "short overall summary",
  "issues": [
    {
      "severity": "critical|high|medium|low",
      "file": "path/to/file",
      "line": 123,
      "title": "Short issue title",
      "explanation": "What the problem is and why it matters - the concrete failure scenario.",
      "suggestedFix": "A concise, actionable recommended fix."
    }
  ]
}
```

(`explanation` and `suggestedFix` are two fields rather than one combined "body" - since they're
usually rendered differently by a consumer, e.g. `explanation` as prose and `suggestedFix` as its
own labeled line or code suggestion.)

## The end-to-end workflow

`reviewPullRequest(owner, repo, pullRequestNumber, overrides?)` in
`src/workflow/reviewPullRequestWorkflow.ts` is **the** orchestrator - the single function that
runs a complete review. It never throws; every outcome, including every failure mode, comes back
as a discriminated union:

```ts
type ReviewPullRequestOutcome =
  | { status: 'posted'; reviewId: number; reviewUrl: string; newCommentCount: number; summaryOnlyCount: number; totalFindings: number }
  | { status: 'cancelled'; newCommentCount: number; summaryOnlyCount: number }
  | { status: 'skipped'; reason: 'no_reviewable_files' | 'all_findings_already_posted' }
  | { status: 'failed'; stage: 'fetch' | 'claude' | 'dedup' | 'post' | 'unexpected'; reason: string };
```

Steps:

1. **Fetch** PR metadata (`getPullRequest`) and every changed file, paginating through
   `getChangedFiles` until all of them are collected. The combined PR diff
   (`getPullRequestDiff`) is also fetched, but only for logging/observability - a failure
   fetching it is non-fatal, since it isn't what's actually sent to Claude (see next point).
2. **Filter** (`fileFilter.ts`): drops `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`, anything
   under a `node_modules`/`dist`/`build`/`generated` path segment, common generated-file
   conventions (`*.min.js`, `*.generated.*`, `*.pb.go`, ...), and binary file extensions (images,
   fonts, archives, executables, media, databases). If nothing survives, the workflow stops here
   with `status: 'skipped', reason: 'no_reviewable_files'` - Claude is never called.
3. **Send to Claude**: the diff text Claude actually sees is built from the *filtered* files' own
   patches (not the combined diff), so an ignored file's contents structurally cannot reach the
   model - there's no diff-parsing/stripping step that could get that wrong.
4. **Map and validate every finding** (`diffMapper.ts` - see "Diff-line mapping" below): each
   returned `{file, line}` is checked against a full reconstruction of that file's diff, not just
   "is this line somewhere near a hunk". Only a finding whose line was an *actual added line* in
   the diff becomes an inline comment. Anything else - a hallucinated file path, a line number
   the diff never shows, or a real line number that's only unchanged context - is never dropped
   silently: it's written into the review summary text instead (step 6), with its full title and
   explanation, so the finding is never lost even when it can't be safely placed on a line.
5. **Detect duplicates** (`duplicateDetectionService.ts` - see "Duplicate review detection"
   below): every mappable finding is checked against the PR's existing bot comments
   (`getExistingReviewComments`) by stable fingerprint, and anything matching is skipped. If
   every mappable finding turns out to already be posted *and* there are no unmapped findings to
   mention either, the workflow stops with `status: 'skipped', reason:
   'all_findings_already_posted'` - no review is submitted at all, so re-running on an unchanged
   PR doesn't spam a fresh review every time.
6. **Confirm, then post once**: the fully-prepared review (summary + every new inline comment) is
   handed to `confirmBeforePosting()` - by default this always returns `true` (auto-post, for
   non-interactive callers), but the CLI (`src/cli/review.ts`) overrides it with an interactive
   y/n prompt. Only if it confirms does the workflow make its one `createPullRequestReview` call,
   batching every new inline comment plus a summary body that also lists any unmapped findings in
   full. This is deliberate - there is no code path that posts some comments and then fails,
   because there is only ever one write call, made only after every prior step (fetch, Claude,
   mapping, dedup, confirmation) has already succeeded.

### Failing safely

- **If Claude fails**, the function returns `{ status: 'failed', stage: 'claude', ... }`
  immediately - `createPullRequestReview` is never reached, so nothing is posted.
- **If any GitHub call fails** (fetch, dedup-check, or the final post), the error is logged and
  returned via `toSafeLogFields()` (`src/workflow/logger.ts`), which reads only `.status` and
  `.message` off the caught error - never `.request`, `.response`, or `.headers`, which is where
  an SDK error could carry the `Authorization` header or API key. A top-level try/catch around
  the whole function also guarantees this for any unexpected error, not just the ones explicitly
  anticipated.
- **Every log line goes to stderr** through the same safe extractor - nothing in this module ever
  logs a raw caught error or a raw env var.

### Diff-line mapping

The core safety guarantee of this whole workflow is: **a comment is never placed on a line that
wasn't actually changed.** `src/workflow/diffMapper.ts` is what makes that provable rather than
assumed:

- `parseFileDiff(patch)` reconstructs a full per-line map of a file's unified-diff patch:
  every context/added/removed line gets its old-file line number, new-file line number (either
  can be `null`, e.g. an added line has no old-file line number), and its 1-based **diff
  position** (GitHub's classic line-position numbering, counted from the file's first hunk
  header - included mainly as a debuggable audit trail, even though the actual GitHub API calls
  here use the modern `line`+`side` parameters rather than the deprecated `position` field).
- `mapLineToDiffPosition(patch, line)` looks up a line number in that map and only reports it
  `mapped: true` if the line exists **and was actually added** by the diff - not merely present
  as surrounding context within a hunk. A line that exists in the new file but wasn't touched
  (`line_not_changed`), or that the diff doesn't show at all (`line_not_in_diff`), or a patch
  that's missing/empty (`no_diff`), all come back `mapped: false` with a specific reason.
- The workflow re-runs this exact check a second time, immediately before building each
  `ReviewCommentInput` (`buildValidatedComment()`), and **throws** if it ever disagrees with the
  first pass - given the same patch and line this is deterministic, so a mismatch could only mean
  a future code change regressed the invariant, and refusing to post is the only acceptable
  response to that.
- A finding that fails mapping is never just dropped: `buildReviewSummaryBody()` writes its
  severity, file:line, title, and full explanation into the overall review body instead, under an
  "Additional findings that could not be safely placed on a specific diff line" heading - so
  real findings are never silently lost, only kept off a line the diff can't prove they belong on.

### Comment formatting

**Every inline comment** (`formatIssueCommentBody()` in `fingerprint.ts`) follows a fixed format:

```
**[HIGH] Possible null reference**

**Explanation:**
req.user may be undefined if the auth middleware is skipped for this route...

**Suggested fix:**
Add a guard: if (!req.user) return res.status(401).json(...);

<!-- pr-review-agent:fingerprint=... -->
```

**The single summary comment** (`buildReviewSummaryBody()` in `reviewPullRequestWorkflow.ts`)
covers every issue Claude returned this run (not just the new ones being posted, so re-reviewing
an unchanged PR still shows the full current picture, not just this run's delta):

```
**Issues found:** 3
- 🔴 Critical: 1
- 🟠 High: 1
- 🟡 Medium: 1
- 🟢 Low: 0

**Overall review result:** ⚠️ Changes requested - 1 critical issue(s) must be addressed before merging.

<Claude's own free-text summary>

_2 finding(s) posted as inline comments by pr-review-agent._
```

`overallReviewResult()` is a **deterministic, rule-based verdict computed from the severity
counts** - critical present → changes requested; else high present → changes requested; else →
approved with minor suggestions - never asked of Claude itself, so it can't vary in wording or
disagree with its own counts between runs of the identical findings.

When Claude finds **nothing at all** (`claudeResult.issues.length === 0`), the entire summary
body is replaced with a fixed message instead of a zeroed-out breakdown template:

```
✅ No significant issues found in the changed code.
```

### Duplicate review detection

Re-reviewing an updated PR must not re-post the same finding, but also must not lose a genuinely
new one just because *something* was already posted. That comparison logic lives entirely in
`src/workflow/duplicateDetectionService.ts` - `reviewPullRequestWorkflow.ts` never inspects a
fingerprint or a comment body itself, it just calls `detectDuplicateFindings(findings,
existingComments, ref)` and posts whatever comes back as new.

- **The fingerprint** (`fingerprintIssue()` in `fingerprint.ts`) is a SHA-1 of `repository ::
  pullNumber :: file :: line :: normalized(title)` - scoping it to the exact repository and PR
  means a fingerprint can never accidentally match a similarly-worded finding in a different PR
  or repo, even if fingerprints from multiple PRs were ever compared side by side. The **full
  comment body is deliberately never used** for matching: Claude's explanation text can legitimately
  reword itself between runs while still describing the same underlying problem, so comparing full
  bodies would make every reworded rerun look like a brand new issue.
- **Detection is pure set membership**: every existing comment's embedded fingerprint marker is
  collected into a set (via `extractFingerprint()`), and each candidate finding's freshly-computed
  fingerprint is checked against it - a match means `duplicateFindings`, no match means
  `newFindings`. No history, database, or run-to-run state is needed beyond what's already sitting
  in the PR's own comments.
- **"Same issue still exists" → skipped**: if Claude reports the identical `{file, line, title}`
  again on a later run, it hashes to the identical fingerprint, matches the existing comment, and
  is classified as a duplicate.
- **"Issue fixed" → nothing to suppress**: if the underlying code changed such that Claude no
  longer reports that issue at all, it simply isn't in the candidate list on the next run - there
  is nothing to compare or filter, the issue is just absent. No "resolved" tracking is needed.
- **New issue → posted**: any finding whose fingerprint isn't in the existing set is new, full
  stop, regardless of what else was already posted alongside it.
- **No database, deliberately.** GitHub's own existing comments on the PR (fetched fresh via
  `get_existing_review_comments` every run) are the *only* state duplicate-detection depends on -
  there's no separate persistence layer to keep in sync, migrate, or get out of date. This is
  also why the fingerprint intentionally does **not** include the commit SHA: findings need to
  match across commits (the same unfixed bug reported again on push #2 must still count as a
  duplicate of what was posted on push #1) - keying by commit would make every push mint a fresh
  fingerprint for the same old issue and defeat de-duplication entirely.
- **The posted review is still anchored to the exact commit that was reviewed**, though - the
  workflow passes `commitId: pr.head.sha` (captured once, back when the PR was first fetched)
  explicitly to `createPullRequestReview`, rather than letting it auto-resolve the PR's *current*
  head at post time. Without this, a new commit landing on the PR while Claude is still reviewing
  (a real, if narrow, race) would anchor the review to a commit whose diff was never actually
  analyzed.

### Two `reviewPullRequest`s

There are two functions named `reviewPullRequest` in this codebase, at different layers:

- `src/review/reviewService.ts` → `reviewPullRequest(input: ReviewInput, deps?)` - just the
  Claude call, given data you already assembled.
- `src/workflow/reviewPullRequestWorkflow.ts` → `reviewPullRequest(owner, repo, pullRequestNumber,
  overrides?)` - the full pipeline: fetch from GitHub, filter, call the one above, validate,
  dedup, post.

The workflow module imports the review-engine one aliased as `runClaudeReview` internally to
keep them apart. If you're wiring up an entrypoint, you want the one in `src/workflow/` - which
is exactly what `src/cli/review.ts` does, below.

### Manual-testing CLI

```bash
npm run review -- --owner=my-org --repo=my-repo --pr=123
```

`src/cli/review.ts` runs one real review end to end - connect to GitHub, fetch the PR/changed
files/diff, run Claude, then **pause for confirmation** before anything is written back - by
calling the exact same `reviewPullRequest()` from `src/workflow/`, overriding only its
`confirmBeforePosting` hook:

```
pr-review-agent: reviewing my-org/my-repo#123

Found 2 issue(s):

[HIGH] src/auth.ts:45
  Missing token expiry check
  The token is accepted regardless of its exp claim...

[MEDIUM] src/api.ts:81
  Unbounded page size on a public endpoint
  A caller can request an arbitrarily large page...

--- Review summary ---
Found a token validation gap and an unbounded query.
----------------------
(2 of these would be posted as inline comments.)

Post these comments to GitHub? (y/n)
```

- Answering anything other than `y`/`yes` returns `false` from the hook, which makes
  `reviewPullRequest` return `{ status: 'cancelled', ... }` **before** its one
  `createPullRequestReview` call - nothing is written to GitHub. This is the same
  fetch-then-post-once design used everywhere else in this codebase, just with one more gate in
  front of the write.
- Findings that could not be safely mapped to a diff line (see "Diff-line mapping") are shown
  too, labeled `(summary only - could not be safely mapped to a diff line)` - so what you're
  approving matches exactly what would be posted, not a rosier preview of it.
- `src/cli/args.ts` (flag parsing) and `src/cli/format.ts` (terminal rendering) are pure
  functions with their own unit tests; `review.ts` itself is a thin entrypoint over them plus
  `node:readline/promises` and is intentionally not imported/tested as a library - it's a script.
- Every log line from the underlying workflow still goes through `toSafeLogFields()` (see
  "Failing safely") - a failed run prints `Review failed at the "<stage>" stage: <message>` and
  nothing more, the same guarantee as any other caller of `reviewPullRequest()`.

## Automatic reviews via webhook

```bash
npm run webhook   # starts an Express server, POST /webhooks/github
```

Point a GitHub webhook (repo or org Settings → Webhooks) at this endpoint, content type
`application/json`, events **Pull requests** only (or "Send me everything" - non-`pull_request`
events are ignored, see below), with a secret matching `GITHUB_WEBHOOK_SECRET`. From then on,
opening, pushing to, or reopening a PR reviews it automatically - no CLI, no confirmation prompt.

Request flow (`src/webhook/app.ts`):

1. **Verify the signature** (`verifySignature.ts`): every request's `X-Hub-Signature-256` header
   is checked via HMAC-SHA256 against the **raw** request body (captured with `express.raw()`,
   never re-serialized JSON, which can silently produce different bytes than what GitHub signed)
   using `crypto.timingSafeEqual` - not `===` - so the comparison itself can't leak information
   through response-time differences. A missing, wrong-secret, or malformed signature gets `401`
   before anything else runs.
2. **Parse and extract** (`parsePullRequestEvent.ts`): pulls `{owner, repo, pullNumber,
   commitSha}` out of the payload for exactly `pull_request` events with action `opened`,
   `synchronize`, or `reopened`. Every other event type or action - `ping`, `push`,
   `pull_request.closed`, etc. - is a completely normal thing for a webhook URL to receive, so it
   comes back `200 { ignored: true, reason }` rather than being treated as an error.
3. **Respond immediately**: a valid, handled event gets `202 { accepted: true, ... }` **before**
   any review work starts. The actual review (a Claude API call plus several GitHub API calls,
   which can take a while) runs after the response is already sent, so it can never make GitHub's
   webhook delivery time out and retry a request whose processing already succeeded.
4. **Process asynchronously** (`processReviewEvent.ts`), fired off without being awaited by the
   route handler:
   - **Duplicate-by-commit-SHA check** (`reviewStatusStore.ts`): if this exact head SHA for this
     PR is already `queued`, `in_progress`, or `completed`, the event is skipped entirely - no
     second Claude/GitHub round trip for a redelivered or rapidly-repeated webhook. A *failed*
     attempt for the same SHA is **not** treated as a duplicate, so a transient failure can never
     permanently block a legitimate retry of that commit.
   - **Trigger the review**: calls the exact same `reviewPullRequest(owner, repo, pullNumber)`
     from `src/workflow/` used by the CLI - `confirmBeforePosting` is left at its default
     (always `true`), since this path is meant to be fully automatic. This one call is what
     performs "run Claude," "post valid inline comments," and "post the overall summary" - they
     are not separate steps here, they're what that function already does.
   - **Retry on failure** (`retry.ts`): if the outcome comes back `{ status: 'failed', ... }`,
     the whole call is retried up to twice more with exponential backoff (500ms, 1000ms) before
     giving up. This is safe to do blindly because `reviewPullRequest()` never posts partial
     results - a failure means nothing was written, so redoing the whole thing from scratch on
     retry can't produce a half-posted review.
   - **Track status** (`reviewStatusStore.ts`): every attempt transitions
     `queued → in_progress → completed` or `→ failed`, readable via `GET /webhooks/status`
     (returns the full in-memory list as JSON) - this state is process-local, not persisted, and
     is expected to reset on restart.

### Logging and error handling

- Every log line (`WorkflowLogger`, reused from `src/workflow/logger.ts`) goes through
  `toSafeLogFields()`, which reads only `.status`/`.message` off any caught error - never
  `.request`/`.response`/`.headers`, where a token, API key, or the webhook secret itself could
  live. This applies uniformly: a bad signature, a malformed payload, a GitHub/Claude failure
  inside the retried review, and even a hypothetical bug inside `processReviewEvent()` itself (a
  last-resort `.catch()` on the fire-and-forget call) all funnel through the same safe path.
  `GITHUB_WEBHOOK_SECRET` itself is never logged anywhere, including at startup (`server.ts` logs
  only that a secret *was configured*, never its value).
- A generic 404 for unknown routes and a 4-arg Express error handler for anything unhandled both
  return a fixed generic message (`"Not found."` / `"Internal server error."`) - a client can
  never see a stack trace or a raw error object.
- `app.ts` exports `buildWebhookApp()` separately from `server.ts` (which just calls
  `.listen()`), specifically so `app.test.ts` can start a real ephemeral HTTP server and exercise
  actual signature verification, header handling, and async timing with the platform's built-in
  `fetch` - not a mocked request object - while injecting a fake `runReview` and a fresh
  `ReviewStatusStore` per test, with no real GitHub/Anthropic credentials needed.

## Automatic reviews via GitHub Actions

A second, independent way to trigger reviews automatically - no server to host at all, GitHub's
own runners do the work. `.github/workflows/pr-review.yml` triggers on `pull_request:
[opened, synchronize, reopened]` in *this* repo (add pr-review-agent's code to whichever repo you
want auto-reviewed, and this workflow reviews PRs opened against it) and runs
`src/cli/autoReview.ts` - the same non-interactive pattern as the webhook, just triggered by
GitHub instead of an HTTP request.

Steps, matching the trigger requirements:

1. **Receive the PR event** - the `on: pull_request: types: [opened, synchronize, reopened]`
   trigger.
2. **Identify** repository, PR number, commit SHA, source branch, and target branch - all five
   read straight from `github.event.pull_request.*` / `github.repository` in the "Identify the
   pull request" step and logged for traceability (none of these are secrets).
3. **Start the review** - `npx tsx src/cli/autoReview.ts --owner=... --repo=... --pr=...`, using
   only the repository/PR number `reviewPullRequest()` actually needs; the workflow refetches the
   head SHA and everything else itself.
4. **Pass PR information to the review engine** - `reviewPullRequest()` (fetch, via MCP - see
   next point) → `review/reviewService.ts` (Claude, unchanged - the review engine has never gone
   through GitHub/MCP and isn't meant to).
5. **GitHub operations go through a real MCP server** - literally, not just the same underlying
   logic. `autoReview.ts` calls `connectMcpClient()` (`src/mcpClient/client.ts`), which spawns
   `src/mcp/server.ts` as its own child process and connects over stdio exactly as any other MCP
   client (Claude Desktop, another agent) would. `buildMcpBackedGithubDeps()`
   (`src/mcpClient/githubViaMcp.ts`) turns that connection into the five functions
   `reviewPullRequestWorkflow.ts` needs, passed in as `overrides` - each one makes a real
   `tools/call` JSON-RPC request and parses the tool's JSON response, rather than calling
   `github/prService.ts` in-process. **This was verified by actually running it**, not just by the
   code existing: `node --import tsx src/cli/autoReview.ts --owner=... --repo=... --pr=...`
   against a dummy token shows the real MCP server subprocess start
   (`pr-review-github-mcp server running on stdio`), a real per-call log from the server's own
   tool-logging wrapper (`[mcp] -> get_pull_request {...}`), a real Octokit HTTP request against
   GitHub, the error propagating back through the actual MCP protocol, and the subprocess shutting
   down cleanly afterward. See "MCP client architecture" below for the full design and what's
   still shared vs. not with the other two triggers.
6. **Fail safely**: `autoReview.ts` never throws uncaught - a genuine failure (`status: 'failed'`)
   sets `process.exitCode = 1`, so the step (and the check on the PR) goes visibly red; `skipped`
   ("nothing to review") and any hypothetical `cancelled` outcome exit 0, since those aren't
   failures. Either way, `reviewPullRequest()`'s own fetch-then-post-once design (see "Failing
   safely" above) means a failure here - at any stage - can never leave a PR with partial or
   incorrect comments, the same guarantee every other trigger gets.

**Secrets**: only `ANTHROPIC_API_KEY` needs to be added (Settings → Secrets and variables →
Actions). `GITHUB_TOKEN` is the Actions-generated ephemeral token, scoped by the workflow's own
`permissions: { pull-requests: write, contents: read }` block - not something you configure.
Neither is ever logged: GitHub Actions automatically masks any output matching a configured
secret's value, and this project's own logging (`toSafeLogFields()`) never reads a raw error's
request/response internals to begin with, so a token can't leak through an error message either.
`GITHUB_OWNER`/`GITHUB_REPO` are deliberately **not** needed here (see the `loadGithubToken()`
note in Configuration below) - the workflow always passes its own owner/repo explicitly.

**Infinite-loop prevention**: posting a review or comment doesn't create a commit and doesn't
open/reopen the PR, so it cannot itself produce a new `pull_request:
[opened|synchronize|reopened]` event - this workflow structurally cannot re-trigger itself from
its own output. The job's `if:` condition is a defensive extra on top of that structural fact,
for the one scenario that would matter if this is ever extended (e.g. the bot opening PRs
itself): it skips whenever the PR's author or the event's actor is `github-actions[bot]` (the
default token's actor login - change both logins in the workflow if you use a custom bot
account/PAT instead).

**Safe against malicious/fork PRs**: `actions/checkout@v4` is pinned to
`github.event.pull_request.base.sha` - this repo's own trusted history - not the PR's head or
GitHub's default merge ref for `pull_request` events. This is deliberate and important: without
it, `npm ci` and the review step would install and execute the *pull request's own* source code
(package.json install scripts, `src/cli/autoReview.ts`, anything else in the checkout) while
`ANTHROPIC_API_KEY`/`GITHUB_TOKEN` are present in the environment - a one-line change to
`autoReview.ts` in a malicious fork PR would be enough to exfiltrate both secrets the moment the
workflow runs. Since this tool only ever reads a PR's diff over the GitHub API - it never needs
the PR's own files checked out locally - pinning to the base commit costs nothing functionally.
Every `${{ }}` expression that comes from the PR event (branch names, etc.) is also routed
through an `env:` block and read back as a shell variable (`$VAR`), never interpolated directly
into a `run:` script body - PR-controlled fields like the source branch name are attacker input,
and direct interpolation into a script is a well-known GitHub Actions script-injection vector.

### MCP client architecture

```
src/mcpClient/
├── client.ts             # connectMcpClient() - spawns mcp/server.ts, connects over stdio
├── githubViaMcp.ts         # buildMcpBackedGithubDeps() - the 5 GitHub ops, MCP-backed
├── client.test.ts            # unit tests for the pure error/env parsing logic
└── githubViaMcp.test.ts        # unit tests for the camelCase -> snake_case argument mapping
```

- **`connectMcpClient(env?)`** spawns `src/mcp/server.ts` as a child process (`node --import tsx
  <path>` in dev/CI, or `node <path>` once built - resolved from this file's own location and
  extension, so it works in either mode) and connects a real `@modelcontextprotocol/sdk` `Client`
  to it over stdio. `callTool(name, args)` makes a real `tools/call` request and returns the
  parsed JSON result, or throws an error carrying only `.status`/`.message` read from the tool's
  own (already-sanitized) error payload if the tool itself reported one.
- **`buildMcpBackedGithubDeps(mcp)`** returns the five functions
  (`getPullRequest`/`getChangedFiles`/`getPullRequestDiff`/`getExistingReviewComments`/`createPullRequestReview`)
  with the exact same parameter and return shapes as their `github/prService.ts` counterparts -
  each one just translates camelCase workflow parameters to the snake_case MCP tool arguments
  (`pullNumber` → `pull_number`, `maxBytes` → `max_bytes`, `commitId` → `commit_id`, etc.) and
  calls `mcp.callTool()`. The shapes match exactly because every MCP tool in `src/mcp/tools/*.ts`
  is a thin wrapper that calls the identical `prService.ts` function and returns its
  JSON-serialized result verbatim - parsing that JSON back reconstructs the exact same type.
- **Why only `autoReview.ts` (GitHub Actions) uses this, not the webhook or interactive CLI**:
  this is a deliberate difference between the three triggers, not an inconsistency to "fix"
  elsewhere. A GitHub Actions job is a short-lived, single-purpose process that starts, does one
  review, and exits - spawning one MCP server subprocess for that one run is cheap and matches
  what was actually asked for (GitHub operations literally going through MCP). The webhook server
  is a long-running process handling a stream of events; spawning (and keeping alive, and
  restarting on crash) a persistent MCP server subprocess for it would be real added operational
  complexity for the same underlying GitHub calls, with no behavioral difference - so
  `webhook/processReviewEvent.ts` and the interactive `cli/review.ts` still use
  `github/prService.ts` directly, and `reviewPullRequestWorkflow.ts` itself is unchanged either
  way: it only ever sees `ReviewPullRequestDeps`, never which of the two ways they were built.
- **`knownBotLogin`** isn't a real MCP tool parameter (the `get_existing_review_comments` tool has
  no such field in its schema) - the tool resolves the bot's own login from its own process's
  `PR_REVIEW_BOT_LOGIN` env var internally. Since the spawned server inherits this process's
  environment, that resolves to the identical value either way.
- **`GITHUB_OWNER`/`GITHUB_REPO` are passed explicitly to the spawned server's environment**,
  derived from `autoReview.ts`'s own `--owner=`/`--repo=` arguments, regardless of whether the
  outer environment has them set. This was a real bug found only by actually running the full
  chain: `mcp/server.ts` validates the complete `GITHUB_TOKEN`/`GITHUB_OWNER`/`GITHUB_REPO` set at
  its own startup (correctly, for its general standalone use where a tool call can omit
  owner/repo) - but `autoReview.ts` was only setting `GITHUB_TOKEN`/`ANTHROPIC_API_KEY` on itself,
  so the child process failed to start until this was added.

## Configuration

Three independent config loaders, validated separately at startup - each throws once, listing
every missing variable, rather than failing on the first:

| Variable | Required by | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | `src/config.ts` (`loadGithubToken`) | Auth token for every Octokit call. Needs `pull-requests: write` + `contents: read`. Works against private repos - there's no separate code path, an authenticated request just has access to whatever the token can see. |
| `GITHUB_OWNER` | `src/config.ts` (`loadConfig`, optional) | Default repository owner, used only when a tool call doesn't pass its own `owner`. **Not needed** by the workflow, webhook, or GitHub Actions trigger - all three always pass owner/repo explicitly, so `getOctokit()` uses `loadGithubToken()` (token only) rather than the full `loadConfig()`. |
| `GITHUB_REPO` | `src/config.ts` (`loadConfig`, optional) | Default repository name. Same caveat as above. |
| `PR_REVIEW_BOT_LOGIN` | `src/config.ts` (optional) | The bot's own GitHub login, for de-duplication. See below. |
| `ANTHROPIC_API_KEY` | `src/review/config.ts` (`loadReviewConfig`) | Claude API key. |
| `ANTHROPIC_MODEL` | `src/review/config.ts` (optional) | Overrides the default review model. |
| `GITHUB_WEBHOOK_SECRET` | `src/webhook/config.ts` (`loadWebhookConfig`) | Shared secret configured on the GitHub webhook itself - every request is HMAC-verified against it. Only required to run `npm run webhook`. |
| `PORT` | `src/webhook/config.ts` (optional) | Port the webhook server listens on. Defaults to 4300. |

`src/review/config.ts` never reads or requires `GITHUB_*`, `src/config.ts` never reads or
requires `ANTHROPIC_*` or `GITHUB_WEBHOOK_SECRET`, and `src/webhook/config.ts` never reads or
requires anything from the other two - each is validated independently so any one half can run
(and be tested) without the others configured.

Every GitHub tool's `owner`/`repo` inputs are optional - pass them explicitly to target a
different repository per call, or omit them to use `GITHUB_OWNER`/`GITHUB_REPO`. `resolveRepoRef()`
(`src/config.ts`) only reads env config when a call omits owner or repo, so callers (and tests)
that always pass both never need the env vars set at all.

## Design notes

- **Every GitHub tool input is a zod schema** (`src/schemas.ts`), passed to the MCP SDK's
  `registerTool` as the `inputSchema`. The SDK validates tool-call arguments against this shape
  before a handler ever runs.
- **Neither API key is ever printed or returned.** `github/client.ts` and `review/claudeClient.ts`
  each hold their own key only inside their SDK client's own auth internals. Every GitHub call in
  `prService.ts` is wrapped in try/catch, funneled through `toGitHubServiceError()`
  (`src/github/errors.ts`), reading only `status`/`message`/`documentation_url`/`errors` off the
  Octokit error - never `err.request` or response headers. The workflow layer's
  `toSafeLogFields()` applies the same principle one level up, for any error reaching it.
- **`commit_id` is optional** on `create_pull_request_comment` and `create_pull_request_review` -
  if omitted, the service function fetches the PR's current head SHA itself.
- **`get_existing_review_comments` needs to know the bot's own login** to filter correctly. It
  tries, in order: an explicit `author` argument, a `knownBotLogin` (from `PR_REVIEW_BOT_LOGIN`),
  then `GET /user` (which only works for a PAT, not the Actions-provided `GITHUB_TOKEN`). If none
  of those resolve it, it returns comments from *all* authors with a `note` explaining why.
- **`get_file_content` and `get_pull_request_diff` guard against huge payloads** (binary
  detection via a NUL-byte sample, and byte-size caps); the workflow's own diff-from-files
  builder applies the same kind of cap before handing text to Claude.
- **Every Octokit/Anthropic call site accepts an injectable client parameter**, and the workflow
  accepts an injectable object for every one of its GitHub/Claude calls plus its logger. This is
  what makes every layer - service functions, the review engine, and the full orchestrator - unit
  testable with fakes and no network access, rather than needing a mocking library.
- **`tsconfig.json` (used by `npm run typecheck`) includes test files; `tsconfig.build.json`
  (used by `npm run build`) extends it and excludes them.** These used to be the same config with
  tests excluded, which meant `npm run typecheck` was silently never checking any `*.test.ts` file
  - a real gap, found while migrating the `ReviewIssue` schema, when several test fixtures with
  stale fields passed "typecheck" but would have failed to compile as a standalone file. Splitting
  the two configs keeps `dist/` test-free without blinding typecheck to test code.
- **`getOctokit()` (`github/client.ts`) validates only `GITHUB_TOKEN`** via `loadGithubToken()`,
  not the full `loadConfig()` (which also requires `GITHUB_OWNER`/`GITHUB_REPO`). Found while
  wiring up the GitHub Actions trigger: every automated entrypoint (webhook, Actions,
  `autoReview.ts`) always passes its own owner/repo explicitly, so requiring the other two env
  vars anyway - which nothing would ever read - was a real, if harmless-looking, over-requirement
  that would have forced unnecessary config on every automated deployment. `resolveRepoRef()` and
  the MCP server's own startup check still use the full `loadConfig()`, correctly - a bare MCP
  tool call *can* omit owner/repo and needs the fallback.

## Setup

```bash
npm install
cp .env.example .env   # then fill in GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, ANTHROPIC_API_KEY
npm run typecheck
npm run dev             # runs src/mcp/server.ts directly via tsx
```

For a built/production run:

```bash
npm run build
npm start                # runs dist/mcp/server.js
```

To run the webhook server locally against a real GitHub webhook, also set
`GITHUB_WEBHOOK_SECRET`, run `npm run webhook`, and expose it with a tunnel (e.g. `ngrok http
4300`) so GitHub's servers can reach `http://localhost:4300/webhooks/github` - point the
repo/org's webhook URL at the tunnel's HTTPS address, with the same secret configured on both
sides.

To use the GitHub Actions trigger instead (no server to host at all): add this repo's code to
whichever repo you want auto-reviewed, set an `ANTHROPIC_API_KEY` secret (Settings → Secrets and
variables → Actions - `GITHUB_TOKEN` needs no setup, it's Actions-provided), and
`.github/workflows/pr-review.yml` reviews every PR opened/pushed-to/reopened automatically. See
"Automatic reviews via GitHub Actions" below for the full walkthrough.

## Testing

```bash
npm test
```

Runs every `*.test.ts` file via Node's built-in test runner (`node --test`, loaded through `tsx`
so it runs directly against the TypeScript source - no build step needed):

- **`src/github/prService.test.ts`** - fake Octokit client, no network.
- **`src/review/prompt.test.ts`** / **`reviewService.test.ts`** - pure prompt-builder checks, and
  a fake `requestReview` (no Anthropic SDK call, no `ANTHROPIC_API_KEY` needed).
- **`src/workflow/fileFilter.test.ts`** - every ignore rule (lockfiles, `node_modules`/`dist`/
  `build`/`generated` paths, generated-file naming conventions, binary extensions), plus
  false-positive checks (e.g. `distinct-values.ts` isn't mistaken for `dist/`).
- **`src/workflow/diffMapper.test.ts`** - hand-traced hunk parsing (old/new line numbers and diff
  positions for context/added/removed lines across single and multiple hunks), and every
  `mapLineToDiffPosition` outcome: a real added line, a context line correctly refused, a line
  number the diff never shows, and a missing patch.
- **`src/workflow/fingerprint.test.ts`** - fingerprint determinism/normalization, that repository
  and PR number are part of the hash, the embed/extract round-trip, and that the rendered comment
  matches the exact required `[SEVERITY] Title` / `Explanation:` / `Suggested fix:` format and
  ordering.
- **`src/workflow/duplicateDetectionService.test.ts`** - new vs. duplicate classification, the
  same-issue-resurfaces-and-is-skipped and fixed-issue-simply-absent scenarios from the
  requirements, that a different repository/PR number never cross-matches, and that matching is
  strictly by the embedded fingerprint marker - never by comparing full comment body text.
- **`src/workflow/reviewPullRequestWorkflow.test.ts`** - the full orchestrator with every
  dependency faked: the happy path, that ignored files never reach Claude, pagination across
  multiple `get_changed_files` pages, every failure stage (`fetch`/`claude`/`dedup`/`post`)
  returning the right outcome *without* calling the next step, that a caught error's secrets
  never reach the returned outcome, that a finding with a bad file or an out-of-range line is
  moved into the summary rather than posted, that a context line is refused even when it falls
  within a hunk's range, skipping entirely when every finding was already posted in a previous
  run, and the confirmation gate itself: nothing is posted when `confirmBeforePosting` returns
  false, an async confirm function works too, and the preview handed to it exactly matches the
  split between inline and summary-only findings. Also covers the summary comment's content: the
  exact fixed "No significant issues found" message when Claude reports nothing, that the
  critical/high/medium/low breakdown covers every issue Claude returned (not just new ones), and
  that the deterministic overall-result verdict escalates correctly (critical → high → approved).
  A dedicated end-to-end suite (`reviewPullRequest duplicate-review protection across multiple
  reviews`) runs `reviewPullRequest()` twice in sequence against one shared in-memory "posted
  comments" list (standing in for GitHub's own state, with no separate persistence layer) to prove
  the same unchanged finding is skipped on a second review, and that a finding fixed in a new
  commit is never re-reported without any special-case "resolved" handling. Also confirms the
  posted review's `commitId` is the exact head SHA fetched at the start of the run, not whatever
  the PR's head happens to be when the write call actually goes out.
- **`src/workflow/prReviewScenarios.test.ts`** - seven realistic-PR end-to-end scenarios (a clear
  bug, a SQL injection vulnerability, a clean PR, a formatting-only PR, a multi-file/multi-issue
  PR, an issue fixed in a follow-up commit, and the same commit reviewed twice), each with a real
  diff fixture rather than a synthetic one-liner. Like every other test here, `runClaudeReview` is
  injected with a fixed response rather than a live Claude call - these prove the *system's*
  handling (diff-line mapping to the right file/line, inline-vs-summary routing, severity in the
  comment, duplicate detection) is correct for each scenario, not Claude's own judgment on that
  code, which needs a real `ANTHROPIC_API_KEY` and `npm run review` to verify.
- **`src/cli/args.test.ts`** / **`format.test.ts`** - flag parsing (order-independent, reports
  every missing argument at once, rejects a non-numeric/non-positive `--pr`) and terminal
  rendering of a finding (severity header, title, multi-line body, optional note).
- **`src/mcpClient/githubViaMcp.test.ts`** - the camelCase → snake_case argument mapping for all
  five MCP-backed GitHub operations (`pullNumber` → `pull_number`, `maxBytes` → `max_bytes`,
  `commitId` → `commit_id`, etc., against a fake `McpClientHandle`), that `knownBotLogin` is never
  forwarded as an MCP argument, and that whatever the tool call returns or throws propagates
  unchanged. `src/mcpClient/client.test.ts` covers the pure logic around the real subprocess
  connection (extracting text from a tool result, stripping `undefined` values before they reach
  `child_process`'s env, and that a tool error's parsed `.status`/`.message` never carries
  anything beyond that even when the payload had more). The actual spawn-and-connect round trip
  isn't unit tested - it was verified by really running it (see "MCP client architecture" above).
- **`src/webhook/verifySignature.test.ts`** - a correctly signed payload is accepted; a wrong
  secret, a tampered payload, a missing header, a missing `sha256=` prefix, and a malformed/short
  signature are all rejected without throwing.
- **`src/webhook/parsePullRequestEvent.test.ts`** - all three handled actions
  (opened/synchronize/reopened) extract correctly; an unrelated event, an unhandled action (e.g.
  `closed`), a missing event name, a non-object payload, and missing required fields all come
  back `handled: false` rather than throwing.
- **`src/webhook/retry.test.ts`** - succeeds without retrying on the first try, retries and then
  succeeds, exhausts every attempt and throws the last error, calls `onRetry` with 1-based attempt
  numbers, and the default retry count.
- **`src/webhook/reviewStatusStore.test.ts`** - queued/in_progress/completed all count as a
  duplicate for the same commit SHA, a different SHA or a different repo/PR never does, a
  **failed** attempt is deliberately not a duplicate (allows retrying that SHA later), and a new
  SHA for the same PR overwrites the old entry.
- **`src/webhook/processReviewEvent.test.ts`** - skips `runReview` entirely on a duplicate SHA,
  tracks queued→in_progress→completed on success, retries a failed outcome until it succeeds,
  marks failed with the original reason once retries are exhausted, and confirms a thrown error's
  attached request/headers never reach the tracked status.
- **`src/webhook/app.test.ts`** - real HTTP tests against a live ephemeral server (`app.listen(0)`
  + the platform's built-in `fetch`, not a mocking library): signature rejection/acceptance,
  ignoring non-`pull_request` events and unhandled actions with `200`, that the response returns
  in well under the time a slow fake review takes to finish (proving async processing), the
  `GET /webhooks/status` endpoint, and that a second delivery for the same commit SHA never
  triggers a second `runReview` call.

- **`src/config.test.ts`** - `loadGithubToken()` needs only `GITHUB_TOKEN` (not
  `GITHUB_OWNER`/`GITHUB_REPO`); `loadConfig()` requires all three together and lists every
  missing one at once; `resolveRepoRef()` never touches `process.env` at all when both owner and
  repo are given explicitly, and correctly falls back to the configured defaults when either is
  omitted. Every test here saves and restores the exact env keys it touches, so nothing leaks
  into other test files.

Every test that passes explicit values instead of relying on defaults never requires
`GITHUB_TOKEN`/`GITHUB_OWNER`/`GITHUB_REPO`/`ANTHROPIC_API_KEY`/`GITHUB_WEBHOOK_SECRET` to be set.
`src/cli/review.ts`, `src/cli/autoReview.ts`, and `src/webhook/server.ts` have no test files of
their own - all three are thin, side-effecting entrypoints (call `main()` / `.listen()` at module
load) over logic that's fully tested elsewhere (`args.ts`/`format.ts`/`describeOutcome.ts`, and
`app.ts` respectively).

### CI

`.github/workflows/ci.yml` runs `npm ci`, `npm run typecheck`, and `npm test` on every push and
every pull request, against both Node 20.x and 22.x. It needs no secrets - every test in this
suite is either a pure function or uses an injected fake, so none of them touch a real GitHub or
Anthropic API. Node 18 (this package's `engines.node` floor) isn't in the matrix because the test
suite runs via `node --import tsx --test`, which needs a newer `--import` loader implementation
than early Node 18 shipped with.

This is a different workflow from `.github/workflows/pr-review.yml` (documented above under
"Automatic reviews via GitHub Actions") - `ci.yml` tests *this project's own code* on every push;
`pr-review.yml` is the trigger that reviews *other* pull requests using this project.

## Not implemented yet

Nothing outstanding. Both automatic triggers (`npm run webhook` and
`.github/workflows/pr-review.yml`) call the same complete, tested `reviewPullRequest()`
orchestrator; the manual CLI (`npm run review`) and this project's own CI (`ci.yml`) round out
the rest.
