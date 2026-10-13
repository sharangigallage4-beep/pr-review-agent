import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

async function waitFor(job: Job, predicate: (j: Job) => boolean, ms = 15_000): Promise<void> {
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

describe('JobManager history and feedback', () => {
  function withHistory(fn: (file: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(path.join(tmpdir(), 'history-'));
    return fn(path.join(dir, 'history.json')).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  test('finished reviews survive a restart, with their preview', () =>
    withHistory(async (historyFile) => {
      const first = new JobManager({ runReview: gatedRun(), echo: silent, historyFile });
      const job = first.start('acme', 'widgets', 7, true);
      await waitFor(job, (j) => j.status === 'posted');

      const second = new JobManager({ echo: silent, historyFile });
      const restored = second.get(job.id);
      assert.equal(restored?.status, 'posted');
      assert.equal(restored?.preview?.inlineFindings.length, 1);
    }));

  test('a review that was in flight at shutdown comes back as failed, not "running"', () =>
    withHistory(async (historyFile) => {
      const first = new JobManager({ runReview: gatedRun(), echo: silent, historyFile });
      const job = first.start('acme', 'widgets', 7);
      await waitFor(job, (j) => j.status === 'awaiting_confirmation');

      const second = new JobManager({ echo: silent, historyFile });
      const restored = second.get(job.id);
      assert.equal(restored?.status, 'failed');
      assert.match(restored?.error ?? '', /restarted/);
      first.confirm(job.id, false);
    }));

  test('a corrupt history file is ignored instead of breaking startup', () =>
    withHistory(async (historyFile) => {
      writeFileSync(historyFile, '{not json');
      assert.deepEqual(new JobManager({ echo: silent, historyFile }).list(), []);
    }));

  test('feedback is stored per finding, summarized, clearable, and validated', () =>
    withHistory(async (historyFile) => {
      const jobs = new JobManager({ runReview: gatedRun(), echo: silent, historyFile });
      const job = jobs.start('acme', 'widgets', 7, true);
      await waitFor(job, (j) => j.status === 'posted');

      assert.equal(jobs.setFeedback(job.id, 0, 'up'), true);
      assert.equal(jobs.setFeedback(job.id, 5, 'up'), false, 'no such finding');
      assert.equal(jobs.setFeedback('missing', 0, 'up'), false, 'no such job');
      assert.deepEqual(jobs.feedbackSummary(), { up: 1, down: 0, percentUp: 100 });

      jobs.setFeedback(job.id, 0, 'down');
      assert.deepEqual(jobs.feedbackSummary(), { up: 0, down: 1, percentUp: 0 });
      assert.equal(new JobManager({ echo: silent, historyFile }).get(job.id)?.feedback?.['0'], 'down');

      jobs.setFeedback(job.id, 0, null);
      assert.deepEqual(jobs.feedbackSummary(), { up: 0, down: 0, percentUp: null });
    }));
});

describe('JobManager local reviews', () => {
  const result = { summary: 'done', findings: [{ severity: 'low' as const, file: 'a.plsql', line: 1, title: 'NM9: x', explanation: 'e', suggestedFix: 'f' }] };

  test('runs the work, reports progress, and ends as done with the findings as a preview', async () => {
    const jobs = new JobManager({ echo: silent });
    const job = jobs.startLocal('sol (compared with old)', async (log) => {
      log('step one');
      return result;
    });
    assert.equal(job.kind, 'local');
    await waitFor(job, (j) => j.status === 'done');
    assert.deepEqual(job.log.map((l) => l.message), ['step one']);
    assert.equal(job.preview?.inlineFindings.length, 1);
    assert.equal(job.repo, 'sol (compared with old)');
    assert.equal(jobs.confirm(job.id, true), false, 'nothing to post');
  });

  test('a failure becomes a failed job with the reason', async () => {
    const jobs = new JobManager({ echo: silent });
    const job = jobs.startLocal('sol', async () => {
      throw new Error('The ZIP is damaged.');
    });
    await waitFor(job, (j) => j.status === 'failed');
    assert.equal(job.error, 'The ZIP is damaged.');
  });

  test('shares the queue with PR reviews: one at a time', async () => {
    let running = 0;
    let max = 0;
    const tracked = async () => {
      running += 1;
      max = Math.max(max, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
    };
    const jobs = new JobManager({
      runReview: (async () => {
        await tracked();
        return { status: 'skipped', reason: 'no_reviewable_files' };
      }) as never,
      echo: silent,
    });
    const a = jobs.start('acme', 'w', 1);
    const b = jobs.startLocal('sol', async () => {
      await tracked();
      return result;
    });
    await waitFor(a, (j) => j.status === 'skipped');
    await waitFor(b, (j) => j.status === 'done');
    assert.equal(max, 1);
  });

  test('thumbs up/down work on a local review, and it survives a restart', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'local-history-'));
    try {
      const historyFile = path.join(dir, 'h.json');
      const jobs = new JobManager({ echo: silent, historyFile });
      const job = jobs.startLocal('sol', async () => result);
      await waitFor(job, (j) => j.status === 'done');
      assert.equal(jobs.setFeedback(job.id, 0, 'down'), true);
      const restored = new JobManager({ echo: silent, historyFile }).get(job.id);
      assert.equal(restored?.status, 'done');
      assert.equal(restored?.feedback?.['0'], 'down');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
