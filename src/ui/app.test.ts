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
import { ProviderSettings } from './providerSettings.js';
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

describe('review UI app: login throttle behind a reverse proxy', () => {
  const servers: Server[] = [];
  after(() => servers.forEach((s) => s.close()));

  async function start(trustProxy?: number) {
    const publicDir = mkdtempSync(path.join(tmpdir(), 'ui-proxy-'));
    writeFileSync(path.join(publicDir, 'index.html'), 'x');
    const app = buildUiApp({
      jobs: new JobManager({ echo: silent }),
      publicDir,
      listPullRequests: async () => [],
      getStatus: async () => ({ github: { configured: true }, model: { kind: 'anthropic' } }),
      auth: createAuth({ password: 'right', maxFailuresPerMinute: 2 }),
      trustProxy,
    });
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const attempt = (base: string, password: string, forwardedFor: string) =>
    fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': forwardedFor },
      body: JSON.stringify({ password }),
    });

  test('with the proxy trusted, one person guessing wrong does not lock everyone else out', async () => {
    const base = await start(1);
    for (let i = 0; i < 2; i += 1) assert.equal((await attempt(base, 'wrong', '203.0.113.7')).status, 401);
    assert.equal((await attempt(base, 'wrong', '203.0.113.7')).status, 429, 'the guesser is blocked');
    assert.equal((await attempt(base, 'right', '198.51.100.9')).status, 200, 'a different person can still sign in');
  });

  test('without a proxy configured, the forwarded header is ignored (it could be faked)', async () => {
    const base = await start(undefined);
    for (let i = 0; i < 2; i += 1) assert.equal((await attempt(base, 'wrong', `10.0.0.${i}`)).status, 401);
    assert.equal((await attempt(base, 'wrong', '10.9.9.9')).status, 429, 'changing the header does not reset the count');
  });
});

describe('review UI app: a separate website (Netlify) fronting the server', () => {
  let server: Server;
  let base: string;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ui-origins-'));
    writeFileSync(path.join(dir, 'index.html'), 'x');
    const app = buildUiApp({
      jobs: new JobManager({ echo: silent }),
      publicDir: dir,
      listPullRequests: async () => [],
      getStatus: async () => ({ github: { configured: true }, model: { kind: 'anthropic' } }),
      allowedOrigins: ['https://my-site.netlify.app', 'not a url'],
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // 400 = the request got past the origin check and failed validation (no pr), 403 = refused.
  const post = (origin: string) =>
    fetch(base + '/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' });

  test('accepts requests that come from the listed website', async () => {
    assert.equal((await post('https://my-site.netlify.app')).status, 400);
  });

  test('still refuses every other origin, and an unparseable entry allows nothing', async () => {
    assert.equal((await post('https://evil.example')).status, 403);
    assert.equal((await post('https://other-site.netlify.app')).status, 403);
    assert.equal((await post('not a url')).status, 403);
  });

  test('without any allowed origin, a foreign Origin is refused as before', async () => {
    const app = buildUiApp({
      jobs: new JobManager({ echo: silent }),
      publicDir: dir,
      listPullRequests: async () => [],
      getStatus: async () => ({ github: { configured: true }, model: { kind: 'anthropic' } }),
    });
    const s = app.listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    try {
      const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api/jobs`;
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://my-site.netlify.app' }, body: '{}' });
      assert.equal(res.status, 403);
    } finally {
      s.close();
    }
  });
});

describe('readStatus for the provider chosen in the UI', () => {
  const ollamaUp = (async () => ({ ok: true, json: async () => ({ models: [{ name: 'q:latest' }] }) })) as unknown as typeof fetch;
  const neverCalled = (async () => {
    throw new Error('Claude must not be probed - that would cost money');
  }) as unknown as typeof fetch;

  test('Claude is described by its key, without any request', async () => {
    const withKey = await readStatus({ CLAUDE_API_KEY: 'k', CLAUDE_MODEL: 'claude-sonnet-5-5' } as NodeJS.ProcessEnv, neverCalled, 'claude');
    assert.deepEqual([withKey.model.kind, withKey.model.name, withKey.model.reachable], ['anthropic', 'claude-sonnet-5-5', undefined]);
    const withoutKey = await readStatus({} as NodeJS.ProcessEnv, neverCalled, 'claude');
    assert.equal(withoutKey.model.reachable, false);
  });

  test('Ollama is probed at its own address with its own model', async () => {
    const status = await readStatus({ OLLAMA_BASE_URL: 'http://localhost:11434', OLLAMA_MODEL: 'q' } as NodeJS.ProcessEnv, ollamaUp, 'ollama');
    assert.deepEqual([status.model.kind, status.model.name, status.model.reachable, status.model.modelInstalled], ['ollama', 'q', true, true]);
  });
});

describe('review UI app: choosing the AI', () => {
  let server: Server;
  let base: string;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'ui-provider-'));
    writeFileSync(path.join(dir, 'index.html'), 'x');
    const providers = new ProviderSettings({ CLAUDE_API_KEY: 'sk-ant-secret-value', OLLAMA_BASE_URL: 'http://localhost:11434', AI_PROVIDER: 'ollama' } as NodeJS.ProcessEnv);
    const noClaude = new ProviderSettings({ OLLAMA_BASE_URL: 'http://localhost:11434' } as NodeJS.ProcessEnv);
    const make = (settings?: ProviderSettings) =>
      buildUiApp({
        jobs: new JobManager({ echo: silent }),
        publicDir: dir,
        listPullRequests: async () => [],
        getStatus: async () => ({ github: { configured: true }, model: { kind: 'anthropic' } }),
        providers: settings,
      });
    const a = make(providers).listen(0, '127.0.0.1');
    const b = make(noClaude).listen(0, '127.0.0.1');
    const c = make(undefined).listen(0, '127.0.0.1');
    server = a;
    await Promise.all([a, b, c].map((s) => new Promise((r) => s.once('listening', r))));
    const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    base = url(a);
    (globalThis as { __noClaude?: string; __noFeature?: string; __extra?: Server[] }).__noClaude = url(b);
    (globalThis as { __noFeature?: string }).__noFeature = url(c);
    (globalThis as { __extra?: Server[] }).__extra = [b, c];
  });

  after(() => {
    server.close();
    (globalThis as { __extra?: Server[] }).__extra?.forEach((s) => s.close());
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, body: unknown) => fetch(`${url}/api/provider`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  test('lists both providers with the selected one, and never includes a key', async () => {
    const res = await fetch(`${base}/api/provider`);
    const text = await res.text();
    const data = JSON.parse(text);
    assert.equal(data.selected, 'ollama');
    assert.deepEqual(data.providers.map((p: { id: string; available: boolean }) => [p.id, p.available]), [['ollama', true], ['claude', true]]);
    assert.equal(text.includes('sk-ant-secret-value'), false);
  });

  test('switches the provider and reports the new selection', async () => {
    const res = await post(base, { id: 'claude' });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { selected: string }).selected, 'claude');
    assert.equal(((await (await fetch(`${base}/api/provider`)).json()) as { selected: string }).selected, 'claude');
    await post(base, { id: 'ollama' });
  });

  test('refuses an unknown provider, and Claude without a key (with the reason)', async () => {
    assert.equal((await post(base, { id: 'gemini' })).status, 400);
    assert.equal((await post(base, {})).status, 400);
    const noClaude = (globalThis as { __noClaude?: string }).__noClaude as string;
    const res = await post(noClaude, { id: 'claude' });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /CLAUDE_API_KEY/);
    assert.equal(((await (await fetch(`${noClaude}/api/provider`)).json()) as { selected: string }).selected, 'ollama');
  });

  test('without the feature configured the route says so', async () => {
    const url = (globalThis as { __noFeature?: string }).__noFeature as string;
    assert.deepEqual(await (await fetch(`${url}/api/provider`)).json(), { available: false, selected: null, providers: [] });
    assert.equal((await post(url, { id: 'claude' })).status, 404);
  });
});
