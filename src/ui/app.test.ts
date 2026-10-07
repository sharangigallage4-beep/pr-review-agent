import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildUiApp } from './app.js';
import { JobManager } from './jobs.js';
import { readStatus } from './services.js';

const silent = { info() {}, warn() {}, error() {} };

// res.json() is typed `unknown`; these tests only read a few known fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<any> => res.json();

describe('review UI app', () => {
  let server: Server;
  let base: string;
  let publicDir: string;
  let started: Array<{ owner: string; repo: string; pr: number }>;

  before(async () => {
    publicDir = mkdtempSync(path.join(tmpdir(), 'ui-public-'));
    writeFileSync(path.join(publicDir, 'index.html'), '<h1>hello</h1>');
    started = [];
    const jobs = new JobManager({
      echo: silent,
      runReview: (async (owner: string, repo: string, pr: number) => {
        started.push({ owner, repo, pr });
        return { status: 'skipped', reason: 'no_reviewable_files' };
      }) as never,
    });
    const app = buildUiApp({
      jobs,
      publicDir,
      listPullRequests: async (owner, repo) => {
        if (repo === 'missing') throw new Error('Repository acme/missing was not found, or the token cannot see it.');
        return [{ number: 1, title: 'T', author: 'a', branch: 'b', baseBranch: 'main', updatedAt: '2026-01-01T00:00:00Z', url: 'u', draft: false }];
      },
      getStatus: async () => ({ github: { configured: true, owner: 'acme', repo: 'widgets' }, model: { kind: 'ollama', reachable: true } }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    rmSync(publicDir, { recursive: true, force: true });
  });

  const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  test('serves the page and the status', async () => {
    assert.match(await (await fetch(base + '/')).text(), /hello/);
    const status = await body(await fetch(base + '/api/status'));
    assert.equal(status.github.configured, true);
  });

  test('lists pull requests and turns a lookup failure into a readable 502', async () => {
    const ok = await fetch(base + '/api/prs?owner=acme&repo=widgets');
    assert.equal(ok.status, 200);
    assert.equal((await body(ok)).pullRequests.length, 1);

    const bad = await fetch(base + '/api/prs?owner=acme&repo=missing');
    assert.equal(bad.status, 502);
    assert.match((await body(bad)).error, /not found/);
  });

  test('rejects owner/repo values that are not plain names', async () => {
    for (const q of ['owner=a/b&repo=c', 'owner=a&repo=..%2F..', 'owner=&repo=c', 'repo=c']) {
      assert.equal((await fetch(base + '/api/prs?' + q)).status, 400, q);
    }
  });

  test('starts a review and exposes it as a job', async () => {
    const res = await post('/api/jobs', { owner: 'acme', repo: 'widgets', pr: 5 });
    assert.equal(res.status, 202);
    const job = await body(res);
    assert.equal(job.pr, 5);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(started.at(-1), { owner: 'acme', repo: 'widgets', pr: 5 });
    const fetched = await body(await fetch(`${base}/api/jobs/${job.id}`));
    assert.equal(fetched.status, 'skipped');
  });

  test('validates the review request and the decision', async () => {
    assert.equal((await post('/api/jobs', { owner: 'acme', repo: 'widgets', pr: 'five' })).status, 400);
    assert.equal((await post('/api/jobs', { owner: 'acme', repo: 'widgets', pr: -1 })).status, 400);
    assert.equal((await post('/api/jobs/nope/confirm', { post: 'yes' })).status, 400);
    assert.equal((await post('/api/jobs/nope/confirm', { post: true })).status, 409);
    assert.equal((await fetch(`${base}/api/jobs/nope`)).status, 404);
  });

  test('refuses requests from another website (Origin mismatch)', async () => {
    const res = await post('/api/jobs', { owner: 'acme', repo: 'widgets', pr: 9 }, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(started.some((s) => s.pr === 9), false);
  });

  test('refuses writes that are not JSON (cross-site form posts)', async () => {
    const res = await fetch(base + '/api/jobs', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"owner":"acme","repo":"widgets","pr":9}' });
    assert.equal(res.status, 415);
  });

  test('refuses an unexpected Host header (DNS rebinding)', async () => {
    const url = new URL(base);
    const status = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const req = request({ host: url.hostname, port: url.port, path: '/api/status', headers: { host: 'evil.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    });
    assert.equal(status, 403);
  });
});

describe('readStatus', () => {
  const json = (data: unknown, ok = true) => (async () => ({ ok, json: async () => data })) as unknown as typeof fetch;

  test('reports hosted Anthropic when no base URL is set', async () => {
    const s = await readStatus({ GITHUB_TOKEN: 't', ANTHROPIC_MODEL: 'm' } as NodeJS.ProcessEnv);
    assert.equal(s.model.kind, 'anthropic');
    assert.equal(s.github.configured, true);
  });

  test('reports an Ollama server with the model installed', async () => {
    const env = { ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_MODEL: 'qwen' } as NodeJS.ProcessEnv;
    const s = await readStatus(env, json({ models: [{ name: 'qwen:latest' }] }));
    assert.deepEqual([s.model.kind, s.model.reachable, s.model.modelInstalled], ['ollama', true, true]);
  });

  test('flags a model that is not pulled, and an unreachable server', async () => {
    const env = { ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_MODEL: 'qwen' } as NodeJS.ProcessEnv;
    assert.equal((await readStatus(env, json({ models: [{ name: 'other' }] }))).model.modelInstalled, false);
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    assert.equal((await readStatus(env, down)).model.reachable, false);
  });
});
