import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JobManager } from './jobs.js';
import type { Job } from './jobs.js';
import type { ReviewPreview, ReviewPullRequestOutcome } from '../workflow/reviewPullRequestWorkflow.js';

const silent = { info() {}, warn() {}, error() {} };

const preview: ReviewPreview = {
  owner: 'acme',
  repo: 'widgets',
  pullRequestNumber: 7,
  summary: 'One issue.',
  inlineFindings: [
    { severity: 'high', file: 'a.js', line: 3, title: 'Bug', explanation: 'Because.', suggestedFix: 'Fix it.' },
  ],
  summaryOnlyFindings: [],
};

type RunReview = ConstructorParameters<typeof JobManager>[0] extends infer O
  ? O extends { runReview?: infer R }
    ? R
    : never
  : never;

/** A fake workflow: asks the confirm gate with `preview`, then reports what the gate answered. */
function gatedRun(onDecision?: (posted: boolean) => void): NonNullable<RunReview> {
  return (async (_o: string, _r: string, _n: number, overrides: { confirmBeforePosting?: (p: ReviewPreview) => unknown }) => {
    const posted = Boolean(await overrides.confirmBeforePosting?.(preview));
    onDecision?.(posted);
    return posted
      ? ({ status: 'posted', reviewId: 1, reviewUrl: 'https://github.com/x/y/pull/7#r1', newCommentCount: 1, summaryOnlyCount: 0, totalFindings: 1 } as ReviewPullRequestOutcome)
      : ({ status: 'cancelled', newCommentCount: 1, summaryOnlyCount: 0 } as ReviewPullRequestOutcome);
  }) as unknown as NonNullable<RunReview>;
}

async function waitFor(job: Job, predicate: (j: Job) => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate(job)) {
    if (Date.now() > end) throw new Error(`Timed out; job status is ${job.status}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('JobManager', () => {
  test('waits for the user, then posts exactly when told to', async () => {
    let decision: boolean | undefined;
    const jobs = new JobManager({ runReview: gatedRun((p) => (decision = p)), echo: silent });
    const job = jobs.start('acme', 'widgets', 7);

    await waitFor(job, (j) => j.status === 'awaiting_confirmation');
    assert.equal(job.preview?.inlineFindings.length, 1);
    assert.equal(decision, undefined, 'nothing is decided before the user answers');

    assert.equal(jobs.confirm(job.id, true), true);
    await waitFor(job, (j) => j.status === 'posted');
    assert.equal(decision, true);
  });

  test('discarding ends as cancelled', async () => {
    const jobs = new JobManager({ runReview: gatedRun(), echo: silent });
    const job = jobs.start('acme', 'widgets', 7);
    await waitFor(job, (j) => j.status === 'awaiting_confirmation');
    jobs.confirm(job.id, false);
    await waitFor(job, (j) => j.status === 'cancelled');
  });

  test('autoPost skips the wait and posts straight away', async () => {
    const jobs = new JobManager({ runReview: gatedRun(), echo: silent });
    const job = jobs.start('acme', 'widgets', 7, true);
    await waitFor(job, (j) => j.status === 'posted');
    assert.equal(jobs.confirm(job.id, true), false, 'nothing is waiting any more');
  });

  test('a preview nobody answers is discarded after the timeout', async () => {
    const jobs = new JobManager({ runReview: gatedRun(), confirmTimeoutMs: 20, echo: silent });
    const job = jobs.start('acme', 'widgets', 7);
    await waitFor(job, (j) => j.status === 'cancelled');
    assert.ok(job.log.some((l) => /discarded/i.test(l.message)));
  });

  test('a failed workflow outcome becomes a failed job with a readable reason', async () => {
    const run = (async () => ({ status: 'failed', stage: 'claude', reason: 'Connection error.' })) as unknown as NonNullable<RunReview>;
    const jobs = new JobManager({ runReview: run, echo: silent });
    const job = jobs.start('acme', 'widgets', 7);
    await waitFor(job, (j) => j.status === 'failed');
    assert.match(job.error ?? '', /claude.*Connection error/);
  });

  test('an unexpected throw becomes a failed job instead of crashing', async () => {
    const run = (async () => {
      throw new Error('boom');
    }) as unknown as NonNullable<RunReview>;
    const jobs = new JobManager({ runReview: run, echo: silent });
    const job = jobs.start('acme', 'widgets', 7);
    await waitFor(job, (j) => j.status === 'failed');
    assert.equal(job.error, 'boom');
  });

  test('starting the same PR twice returns the active job instead of a duplicate', async () => {
    const jobs = new JobManager({ runReview: gatedRun(), echo: silent });
    const first = jobs.start('acme', 'widgets', 7);
    const second = jobs.start('acme', 'widgets', 7);
    assert.equal(second.id, first.id);
    await waitFor(first, (j) => j.status === 'awaiting_confirmation');
    jobs.confirm(first.id, false);
  });

  test('reviews run one at a time', async () => {
    let running = 0;
    let maxRunning = 0;
    const run = (async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      return { status: 'skipped', reason: 'no_reviewable_files' };
    }) as unknown as NonNullable<RunReview>;
    const jobs = new JobManager({ runReview: run, echo: silent });
    const a = jobs.start('acme', 'widgets', 1);
    const b = jobs.start('acme', 'widgets', 2);
    await waitFor(a, (j) => j.status === 'skipped');
    await waitFor(b, (j) => j.status === 'skipped');
    assert.equal(maxRunning, 1);
  });

  test('workflow log lines are captured on the job', async () => {
    const run = (async (_o: string, _r: string, _n: number, overrides: { logger?: { info(m: string): void } }) => {
      overrides.logger?.info('Fetched full PR diff');
      return { status: 'skipped', reason: 'no_reviewable_files' };
    }) as unknown as NonNullable<RunReview>;
    const jobs = new JobManager({ runReview: run, echo: silent });
    const job = jobs.start('acme', 'widgets', 7);
    await waitFor(job, (j) => j.status === 'skipped');
    assert.deepEqual(job.log.map((l) => l.message), ['Fetched full PR diff']);
  });
});
