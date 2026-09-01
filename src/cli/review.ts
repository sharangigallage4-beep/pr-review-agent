#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { loadDotEnv } from '../loadEnv.js';
import { parseCliArgs } from './args.js';
import { formatFinding } from './format.js';
import { describeOutcome } from './describeOutcome.js';
import { reviewPullRequest } from '../workflow/reviewPullRequestWorkflow.js';
import type { ReviewPreview } from '../workflow/reviewPullRequestWorkflow.js';

const UNMAPPABLE_NOTE = 'summary only - could not be safely mapped to a diff line';

/**
 * The confirmation gate the CLI plugs into `reviewPullRequest`'s `confirmBeforePosting` hook:
 * prints every finding (split into what would become an inline comment vs. what can only appear
 * in the summary), then blocks on a y/n answer. Everything except an explicit y/yes answer
 * counts as "no" - declining to post is always the safe default on ambiguous input.
 */
async function confirmBeforePosting(preview: ReviewPreview): Promise<boolean> {
  const total = preview.inlineFindings.length + preview.summaryOnlyFindings.length;

  if (total === 0) {
    console.log('\nNo issues found by Claude.');
  } else {
    console.log(`\nFound ${total} issue(s):\n`);
    for (const issue of preview.inlineFindings) {
      console.log(formatFinding(issue));
      console.log('');
    }
    for (const issue of preview.summaryOnlyFindings) {
      console.log(formatFinding(issue, UNMAPPABLE_NOTE));
      console.log('');
    }
  }

  console.log('--- Review summary ---');
  console.log(preview.summary);
  console.log('----------------------');
  if (preview.inlineFindings.length > 0) {
    console.log(`(${preview.inlineFindings.length} of these would be posted as inline comments.)`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('\nPost these comments to GitHub? (y/n) ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  loadDotEnv();

  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  const { owner, repo, pr } = parsed.args;
  console.log(`pr-review-agent: reviewing ${owner}/${repo}#${pr}`);

  const outcome = await reviewPullRequest(owner, repo, pr, { confirmBeforePosting });
  describeOutcome(outcome);
}

main().catch((err) => {
  // Same safety rule as everywhere else in this codebase: only ever print a plain message off a
  // caught error, never the error object itself, in case something unanticipated throws with
  // request/response internals (and therefore a token or API key) attached.
  const message = err instanceof Error ? err.message : 'Unknown error.';
  console.error(`\nUnexpected CLI error: ${message}`);
  process.exitCode = 1;
});
