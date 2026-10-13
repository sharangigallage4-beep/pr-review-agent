import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listOpenPullRequests } from './services.js';

const prJson = [
  { number: 7, title: 'T', user: { login: 'a' }, head: { ref: 'b', sha: 'abc' }, base: { ref: 'main' }, updated_at: '2026-01-01T00:00:00Z', html_url: 'u', draft: false },
];

const okResponse = () => ({ ok: true, status: 200, json: async () => prJson }) as unknown as Response;
const statusResponse = (status: number) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response;
const dnsError = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' }) });

/** A fake fetch that plays the given outcomes in order (an Error is thrown, a Response is returned). */
function script(outcomes: Array<Error | Response>) {
  const state = { calls: 0 };
  const fetchFn = (async () => {
    const outcome = outcomes[Math.min(state.calls, outcomes.length - 1)];
    state.calls += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }) as unknown as typeof fetch;
  return { state, fetchFn };
}

describe('listOpenPullRequests', () => {
  test('returns the pull requests, including the head commit', async () => {
    const { fetchFn } = script([okResponse()]);
    const prs = await listOpenPullRequests('o', 'r', 't', fetchFn, { delayMs: 1 });
    assert.deepEqual(prs.map((p) => [p.number, p.headSha, p.branch]), [[7, 'abc', 'b']]);
  });

  test('rides out a DNS hiccup or a temporary GitHub error and then succeeds', async () => {
    const { state, fetchFn } = script([dnsError(), statusResponse(503), okResponse()]);
    const prs = await listOpenPullRequests('o', 'r', 't', fetchFn, { delayMs: 1 });
    assert.equal(prs.length, 1);
    assert.equal(state.calls, 3);
  });

  test('a lasting outage is reported in plain words, not as "fetch failed"', async () => {
    const { state, fetchFn } = script([dnsError()]);
    await assert.rejects(() => listOpenPullRequests('o', 'r', 't', fetchFn, { delayMs: 1 }), /Could not reach GitHub.*DNS/);
    assert.equal(state.calls, 4, 'the first attempt plus three retries');
  });

  test('a real error (missing repo, bad token) is reported at once, without retrying', async () => {
    const missing = script([statusResponse(404)]);
    await assert.rejects(() => listOpenPullRequests('o', 'r', 't', missing.fetchFn, { delayMs: 1 }), /was not found/);
    assert.equal(missing.state.calls, 1);

    const denied = script([statusResponse(401)]);
    await assert.rejects(() => listOpenPullRequests('o', 'r', 't', denied.fetchFn, { delayMs: 1 }), /rejected the token/);
    assert.equal(denied.state.calls, 1);
  });
});
