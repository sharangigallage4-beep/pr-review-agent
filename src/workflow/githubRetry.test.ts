import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubRetry, isNeverSent, isTransientRead } from './githubRetry.js';

const silent = { info() {}, warn() {}, error() {} };
const fast = { delayMs: 1, retries: 4 };

/** Fails with `error` the first `failures` times, then succeeds - and counts the calls. */
function flaky(failures: number, error: unknown) {
  const state = { calls: 0 };
  const fn = async () => {
    state.calls += 1;
    if (state.calls <= failures) throw error;
    return 'ok';
  };
  return { state, fn };
}

const dns = Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { status: 500 });
const reset = new Error('read ECONNRESET');
const notFound = Object.assign(new Error('Not Found'), { status: 404 });
const unavailable = Object.assign(new Error('Service Unavailable'), { status: 503 });

describe('error classification', () => {
  test('a request that never reached GitHub is "never sent"; a dropped connection is not', () => {
    assert.equal(isNeverSent(dns), true);
    assert.equal(isNeverSent(new Error('connect ECONNREFUSED 140.82.0.1:443')), true);
    assert.equal(isNeverSent(new Error('getaddrinfo EAI_AGAIN api.github.com')), true);
    assert.equal(isNeverSent(reset), false);
    assert.equal(isNeverSent(unavailable), false);
    assert.equal(isNeverSent(notFound), false);
  });

  test('reads retry network errors and temporary GitHub statuses, never real errors', () => {
    for (const err of [dns, reset, unavailable, new Error('fetch failed'), Object.assign(new Error('x'), { status: 429 }), Object.assign(new Error('x'), { code: 'ETIMEDOUT' })]) {
      assert.equal(isTransientRead(err), true, String(err));
    }
    for (const err of [notFound, Object.assign(new Error('Bad credentials'), { status: 401 }), Object.assign(new Error('Forbidden'), { status: 403 }), new Error('boom'), 'a string']) {
      assert.equal(isTransientRead(err), false, String(err));
    }
  });

  test('looks inside a wrapped cause', () => {
    const wrapped = Object.assign(new Error('request failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }) });
    assert.equal(isNeverSent(wrapped), true);
  });
});

describe('createGithubRetry.read', () => {
  test('rides out a short outage and returns the result', async () => {
    const { state, fn } = flaky(3, dns);
    assert.equal(await createGithubRetry(silent, fast).read(fn), 'ok');
    assert.equal(state.calls, 4);
  });

  test('gives up with the real error when the outage lasts', async () => {
    const { state, fn } = flaky(99, dns);
    await assert.rejects(() => createGithubRetry(silent, fast).read(fn), /ENOTFOUND/);
    assert.equal(state.calls, 5, 'the first attempt plus four retries');
  });

  test('does not retry an error that retrying cannot fix', async () => {
    const { state, fn } = flaky(99, notFound);
    await assert.rejects(() => createGithubRetry(silent, fast).read(fn), /Not Found/);
    assert.equal(state.calls, 1);
  });

  test('tells the log what it is doing', async () => {
    const warnings: string[] = [];
    const { fn } = flaky(1, dns);
    await createGithubRetry({ ...silent, warn: (m) => warnings.push(m) }, fast).read(fn);
    assert.match(warnings[0], /retrying \(1 of 4\)/);
  });
});

describe('createGithubRetry.write', () => {
  test('retries when the request never left this computer', async () => {
    const { state, fn } = flaky(2, dns);
    assert.equal(await createGithubRetry(silent, fast).write(fn), 'ok');
    assert.equal(state.calls, 3);
  });

  test('never repeats a write that may have reached GitHub (it could post twice)', async () => {
    for (const error of [reset, unavailable, new Error('fetch failed'), Object.assign(new Error('x'), { code: 'ETIMEDOUT' })]) {
      const { state, fn } = flaky(99, error);
      await assert.rejects(() => createGithubRetry(silent, fast).write(fn));
      assert.equal(state.calls, 1, String(error));
    }
  });
});
