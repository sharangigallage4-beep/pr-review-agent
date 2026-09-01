import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, loadGithubToken, resolveRepoRef } from './config.js';

// These functions read process.env directly, so every test saves and restores the exact keys it
// touches - this file must never leak env mutations into other test files that might run in the
// same process.
const ENV_KEYS = ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPO', 'PR_REVIEW_BOT_LOGIN'] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => void): void {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];

  for (const key of ENV_KEYS) {
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    fn();
  } finally {
    for (const key of ENV_KEYS) {
      const original = saved[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

describe('loadGithubToken', () => {
  test('returns the token when only GITHUB_TOKEN is set - GITHUB_OWNER/GITHUB_REPO not required', () => {
    withEnv({ GITHUB_TOKEN: 'test-token' }, () => {
      assert.equal(loadGithubToken(), 'test-token');
    });
  });

  test('throws a clear, token-free error when GITHUB_TOKEN is missing', () => {
    withEnv({}, () => {
      assert.throws(() => loadGithubToken(), /GITHUB_TOKEN/);
    });
  });
});

describe('loadConfig', () => {
  test('requires GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO together', () => {
    withEnv({ GITHUB_TOKEN: 't', GITHUB_OWNER: 'o', GITHUB_REPO: 'r' }, () => {
      const config = loadConfig();
      assert.equal(config.githubToken, 't');
      assert.equal(config.githubOwner, 'o');
      assert.equal(config.githubRepo, 'r');
    });
  });

  test('lists every missing variable at once, not just the first', () => {
    withEnv({}, () => {
      assert.throws(() => loadConfig(), /GITHUB_TOKEN.*GITHUB_OWNER.*GITHUB_REPO/s);
    });
  });
});

describe('resolveRepoRef', () => {
  test('never touches process.env when both owner and repo are given explicitly', () => {
    withEnv({}, () => {
      // No GITHUB_TOKEN/OWNER/REPO set at all - would throw if this fell back to loadConfig().
      assert.deepEqual(resolveRepoRef({ owner: 'acme', repo: 'widgets' }), { owner: 'acme', repo: 'widgets' });
    });
  });

  test('falls back to GITHUB_OWNER/GITHUB_REPO when either is omitted', () => {
    withEnv({ GITHUB_TOKEN: 't', GITHUB_OWNER: 'default-owner', GITHUB_REPO: 'default-repo' }, () => {
      assert.deepEqual(resolveRepoRef({ owner: 'explicit-owner' }), { owner: 'explicit-owner', repo: 'default-repo' });
      assert.deepEqual(resolveRepoRef({}), { owner: 'default-owner', repo: 'default-repo' });
    });
  });
});
