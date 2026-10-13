import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildUiApp } from './app.js';
import { JobManager } from './jobs.js';
import { createAuth } from './auth.js';
import { AutoReviewer } from './autoReview.js';
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
  let localDir: string;
  let versionCalls: Array<{ newFiles: string[]; oldFiles: string[] | undefined; label: string; useAi: boolean }>;

  before(async () => {
    publicDir = mkdtempSync(path.join(tmpdir(), 'ui-public-'));
    localDir = mkdtempSync(path.join(tmpdir(), 'ui-local-'));
    mkdirSync(path.join(localDir, 'v2'));
    mkdirSync(path.join(localDir, 'v1'));
    writeFileSync(path.join(localDir, 'v2', 'a.plsql'), 'new code');
    writeFileSync(path.join(localDir, 'v1', 'a.plsql'), 'old code');
    writeFileSync(path.join(localDir, 'notes.txt'), 'not offered');
    versionCalls = [];
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
        return [{ number: 1, title: 'T', author: 'a', branch: 'b', baseBranch: 'main', updatedAt: '2026-01-01T00:00:00Z', url: 'u', draft: false, headSha: 'abc123' }];
      },
      getStatus: async () => ({ github: { configured: true, owner: 'acme', repo: 'widgets' }, model: { kind: 'ollama', reachable: true } }),
      localInputDir: localDir,
      versionReview: (async (input: { newFiles: Map<string, Buffer>; oldFiles?: Map<string, Buffer>; label: string; useAi: boolean }) => {
        versionCalls.push({ newFiles: [...input.newFiles.keys()], oldFiles: input.oldFiles && [...input.oldFiles.keys()], label: input.label, useAi: input.useAi });
        return { summary: 'compared', findings: [{ severity: 'high', file: 'a.plsql', line: 1, title: 'BP1: x', explanation: 'e', suggestedFix: 'f' }] };
      }) as never,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    rmSync(publicDir, { recursive: true, force: true });
    rmSync(localDir, { recursive: true, force: true });
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

  test('offers only the folders and ZIPs inside local-input', async () => {
    const data = await body(await fetch(base + '/api/local-inputs'));
    assert.equal(data.available, true);
    assert.deepEqual(data.entries.map((e: { name: string }) => e.name), ['v1', 'v2']);
  });

  test('reviews two local versions and ends as a finished job with findings (nothing posted)', async () => {
    const res = await post('/api/local-reviews', { newName: 'v2', oldName: 'v1', useAi: false });
    assert.equal(res.status, 202);
    const job = await body(res);
    assert.equal(job.kind, 'local');
    for (let i = 0; i < 500; i += 1) {
      const current = await body(await fetch(`${base}/api/jobs/${job.id}`));
      if (current.status === 'done') {
        assert.equal(current.preview.inlineFindings.length, 1);
        assert.match(current.label, /v2 \(compared with v1\)/);
        break;
      }
      assert.notEqual(current.status, 'failed', current.error);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(versionCalls.at(-1), { newFiles: ['a.plsql'], oldFiles: ['a.plsql'], label: 'v2 (compared with v1)', useAi: false });
  });

  test('the old version is optional, and the AI defaults to on', async () => {
    const before = versionCalls.length;
    const res = await post('/api/local-reviews', { newName: 'v2' });
    assert.equal(res.status, 202);
    for (let i = 0; i < 500 && versionCalls.length === before; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(versionCalls.at(-1), { newFiles: ['a.plsql'], oldFiles: undefined, label: 'v2', useAi: true });
  });

  test('rejects names that are not entries of local-input, without starting anything', async () => {
    const before = versionCalls.length;
    for (const bad of [{ newName: '../v2' }, { newName: 'v2/..' }, { newName: 'notes.txt' }, { newName: 'missing' }, { newName: 'v2', oldName: '../v1' }, { newName: 5 }, {}, { newName: 'v2', oldName: 'v2' }]) {
      assert.equal((await post('/api/local-reviews', bad)).status, 400, JSON.stringify(bad));
    }
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(versionCalls.length, before);
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

describe('review UI app: login, feedback, auto-review, rules editor', () => {
  let server: Server;
  let base: string;
  let dirs: string[] = [];
  let conventionsDir: string;

  const preview = {
    owner: 'o', repo: 'r', pullRequestNumber: 1, summary: 's',
    inlineFindings: [{ severity: 'high', file: 'a.js', line: 1, title: 't', explanation: 'e', suggestedFix: 'f' }],
    summaryOnlyFindings: [],
  };

  before(async () => {
    const publicDir = mkdtempSync(path.join(tmpdir(), 'ui-public2-'));
    writeFileSync(path.join(publicDir, 'index.html'), '<h1>login page</h1>');
    conventionsDir = mkdtempSync(path.join(tmpdir(), 'ui-conv-'));
    dirs = [publicDir, conventionsDir];

    const jobs = new JobManager({
      echo: silent,
      runReview: (async (_o: string, _r: string, _n: number, overrides: { confirmBeforePosting?: (p: unknown) => unknown }) => {
        await overrides.confirmBeforePosting?.(preview);
        return { status: 'posted', reviewId: 1, reviewUrl: 'u', newCommentCount: 1, summaryOnlyCount: 0, totalFindings: 1 };
      }) as never,
    });
    const auto = new AutoReviewer({ jobs, listPullRequests: async () => [], intervalMs: 3_600_000 });
    const app = buildUiApp({
      jobs,
      publicDir,
      listPullRequests: async () => [],
      getStatus: async () => ({ github: { configured: true }, model: { kind: 'anthropic' } }),
      auth: createAuth({ password: 'open sesame', maxFailuresPerMinute: 3 }),
      auto,
      conventionsDir,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const send = (method: string, p: string, body?: unknown, cookie?: string) =>
    fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function signIn(): Promise<string> {
    const res = await send('POST', '/api/login', { password: 'open sesame' });
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    return setCookie.split(';')[0];
  }

  test('the page itself is public, but the API is locked until you sign in', async () => {
    assert.match(await (await fetch(base + '/')).text(), /login page/);
    assert.equal((await send('GET', '/api/status')).status, 401);
    assert.equal((await send('GET', '/api/jobs')).status, 401);
    const session = await body(await send('GET', '/api/session'));
    assert.deepEqual(session, { authRequired: true, authenticated: false });
  });

  test('a forged cookie does not open the API', async () => {
    assert.equal((await send('GET', '/api/status', undefined, 'pr_review_session=9999999999999.forged')).status, 401);
  });

  test('signing in opens the API, and signing out closes it again', async () => {
    const cookie = await signIn();
    assert.equal((await send('GET', '/api/status', undefined, cookie)).status, 200);
    assert.deepEqual(await body(await send('GET', '/api/session', undefined, cookie)), { authRequired: true, authenticated: true });
    const out = await send('POST', '/api/logout', {}, cookie);
    assert.match(out.headers.get('set-cookie') ?? '', /Max-Age=0/);
  });

  test('feedback is recorded per finding and summarized', async () => {
    const cookie = await signIn();
    const job = await body(await send('POST', '/api/jobs', { owner: 'o', repo: 'r', pr: 1, autoPost: true }, cookie));
    for (let i = 0; i < 500; i += 1) {
      const current = await body(await send('GET', `/api/jobs/${job.id}`, undefined, cookie));
      if (current.status === 'posted') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const ok = await body(await send('POST', `/api/jobs/${job.id}/feedback`, { index: 0, vote: 'down' }, cookie));
    assert.deepEqual(ok.summary, { up: 0, down: 1, percentUp: 0 });
    assert.equal((await send('POST', `/api/jobs/${job.id}/feedback`, { index: 9, vote: 'up' }, cookie)).status, 404);
    assert.equal((await send('POST', `/api/jobs/${job.id}/feedback`, { index: 0, vote: 'maybe' }, cookie)).status, 400);
    assert.deepEqual(await body(await send('GET', '/api/feedback', undefined, cookie)), { up: 0, down: 1, percentUp: 0 });
  });

  test('the auto-review switch validates its settings', async () => {
    const cookie = await signIn();
    assert.equal((await send('POST', '/api/auto', { enabled: true, owner: 'a/b', repo: 'c' }, cookie)).status, 400);
    const on = await body(await send('POST', '/api/auto', { enabled: true, autoPost: false, owner: 'acme', repo: 'widgets' }, cookie));
    assert.equal(on.enabled, true);
    assert.equal((await body(await send('GET', '/api/auto', undefined, cookie))).owner, 'acme');
    const off = await body(await send('POST', '/api/auto', { enabled: false }, cookie));
    assert.equal(off.enabled, false);
  });

  test('the rules editor lists, saves, validates and deletes documents', async () => {
    const cookie = await signIn();
    const saved = await send('PUT', '/api/conventions/my-rules.md', { content: '<!-- applies-to: .js -->\n- X1. Be nice.' }, cookie);
    assert.equal(saved.status, 200);
    assert.equal((await body(saved)).ruleCount, 1);
    assert.equal((await body(await send('GET', '/api/conventions', undefined, cookie))).docs.length, 1);

    assert.equal((await send('PUT', '/api/conventions/..%2Fevil.md', { content: 'x' }, cookie)).status, 400);
    assert.equal((await send('PUT', '/api/conventions/bad.txt', { content: 'x' }, cookie)).status, 400);
    assert.equal((await send('PUT', '/api/conventions/ok.md', { content: '' }, cookie)).status, 400);
    assert.equal((await send('PUT', '/api/conventions/ok.md', { content: 5 }, cookie)).status, 400);

    assert.equal((await send('DELETE', '/api/conventions/my-rules.md', undefined, cookie)).status, 200);
    assert.equal((await send('DELETE', '/api/conventions/my-rules.md', undefined, cookie)).status, 404);
  });

  test('without a local-input folder configured the routes are closed, and they are behind the login', async () => {
    assert.equal((await send('POST', '/api/local-reviews', { newName: 'x' })).status, 401);
    const cookie = await signIn();
    assert.equal((await send('POST', '/api/local-reviews', { newName: 'x' }, cookie)).status, 404);
    assert.deepEqual(await body(await send('GET', '/api/local-inputs', undefined, cookie)), { available: false, entries: [] });
  });

  // Last on purpose: failed logins are counted per client address, so this blocks it for a minute.
  test('a wrong password is refused, and repeated guesses are throttled', async () => {
    for (let i = 0; i < 3; i += 1) assert.equal((await send('POST', '/api/login', { password: 'nope' })).status, 401);
    const blocked = await send('POST', '/api/login', { password: 'open sesame' });
    assert.equal(blocked.status, 429, 'even the right password is refused while blocked');
  });
});
