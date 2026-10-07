import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AutoReviewer } from './autoReview.js';
import type { Job, JobManager } from './jobs.js';
import type { PullRequestSummary } from './app.js';

const pr = (number: number, headSha: string, draft = false): PullRequestSummary => ({
  number, title: `PR ${number}`, author: 'a', branch: 'b', baseBranch: 'main', updatedAt: '2026-01-01T00:00:00Z', url: 'u', draft, headSha,
});

const prsOf = (list: Array<{ pr: number }>): number[] => list.map((s) => s.pr).sort();

/** A stand-in for JobManager recording what was started and what each PR's latest job looks like. */
function fakeJobs() {
  const started: Array<{ pr: number; autoPost: boolean }> = [];
  const latest = new Map<number, Partial<Job>>();
  const fake = {
    start: (owner: string, repo: string, prNumber: number, autoPost: boolean) => {
      started.push({ pr: prNumber, autoPost });
      latest.set(prNumber, { owner, repo, pr: prNumber, status: 'running' });
      return {} as Job;
    },
    activeFor: (_o: string, _r: string, prNumber: number) =>
      ['queued', 'running', 'awaiting_confirmation'].includes(String(latest.get(prNumber)?.status)) ? ({} as Job) : undefined,
    list: () => [...latest.values()] as Job[],
  };
  return { started, latest, jobs: fake as unknown as JobManager };
}

function reviewer(prs: () => PullRequestSummary[], jobs: JobManager, extra: { stateFile?: string; maxAttempts?: number } = {}) {
  const r = new AutoReviewer({ jobs, listPullRequests: async () => prs(), intervalMs: 3_600_000, ...extra });
  return r;
}

describe('AutoReviewer', () => {
  test('is off until switched on, and needs a valid repository to turn on', async () => {
    const { jobs, started } = fakeJobs();
    const r = reviewer(() => [pr(1, 'a')], jobs);
    await r.tick();
    assert.deepEqual(started, []);
    assert.match(r.configure({ enabled: true }) ?? '', /owner and repository/);
    assert.match(r.configure({ enabled: true, owner: 'a/b', repo: 'c' }) ?? '', /owner and repository/);
    assert.equal(r.configure({ enabled: true, owner: 'acme', repo: 'widgets' }), undefined);
    r.stop();
  });

  test('the first poll only records existing PRs; later new commits and PRs are reviewed once', async () => {
    const { jobs, started, latest } = fakeJobs();
    let prs = [pr(1, 'a'), pr(2, 'b')];
    const r = reviewer(() => prs, jobs);
    r.configure({ enabled: true, owner: 'acme', repo: 'widgets' });
    await r.tick(); // (configure also kicks off a tick; this one is a no-op repeat)
    assert.deepEqual(started, [], 'existing PRs are not reviewed');

    prs = [pr(1, 'a'), pr(2, 'b2'), pr(3, 'c')];
    await r.tick();
    assert.deepEqual(prsOf(started), [2, 3]);

    latest.get(2)!.status = 'posted';
    latest.get(3)!.status = 'posted';
    await r.tick();
    assert.equal(started.length, 2, 'the same commits are never reviewed twice');
    r.stop();
  });

  test('draft PRs are skipped, and autoPost is passed through', async () => {
    const { jobs, started } = fakeJobs();
    let prs: PullRequestSummary[] = [];
    const r = reviewer(() => prs, jobs);
    r.configure({ enabled: true, autoPost: true, owner: 'acme', repo: 'widgets' });
    await r.tick();
    prs = [pr(5, 'x', true), pr(6, 'y')];
    await r.tick();
    assert.deepEqual(started, [{ pr: 6, autoPost: true }]);
    r.stop();
  });

  test('a failed review is retried on later polls, but only up to the limit', async () => {
    const { jobs, started, latest } = fakeJobs();
    let prs: PullRequestSummary[] = [];
    const r = reviewer(() => prs, jobs, { maxAttempts: 2 });
    r.configure({ enabled: true, owner: 'acme', repo: 'widgets' });
    await r.tick();
    prs = [pr(7, 'z')];
    await r.tick();
    assert.equal(started.length, 1);

    latest.get(7)!.status = 'failed';
    await r.tick();
    assert.equal(started.length, 2, 'retried once');
    latest.get(7)!.status = 'failed';
    await r.tick();
    assert.equal(started.length, 2, 'gave up after maxAttempts');
    r.stop();
  });

  test('a GitHub error is reported in the status and does not throw', async () => {
    const { jobs } = fakeJobs();
    const r = new AutoReviewer({ jobs, listPullRequests: async () => { throw new Error('GitHub returned 502'); }, intervalMs: 3_600_000 });
    r.configure({ enabled: true, owner: 'acme', repo: 'widgets' });
    await r.tick();
    assert.match(r.status().lastError ?? '', /502/);
    r.stop();
  });

  test('settings and seen commits survive a restart (nothing is re-reviewed)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'auto-'));
    try {
      const stateFile = path.join(dir, 'state.json');
      const first = fakeJobs();
      let prs = [pr(1, 'a')];
      const r1 = reviewer(() => prs, first.jobs, { stateFile });
      r1.configure({ enabled: true, owner: 'acme', repo: 'widgets' });
      await r1.tick();
      prs = [pr(1, 'a'), pr(2, 'b')];
      await r1.tick();
      assert.equal(first.started.length, 1);
      r1.stop();

      const second = fakeJobs();
      const r2 = reviewer(() => prs, second.jobs, { stateFile });
      assert.equal(r2.status().enabled, true);
      await r2.tick();
      assert.deepEqual(second.started, [], 'PR 2 was already reviewed before the restart');
      r2.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
