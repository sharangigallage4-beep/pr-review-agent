import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { NetlifyBuildError, buildNetlifySite, normalizeApiUrl } from './netlifyBuild.js';

function withDirs(fn: (publicDir: string, outDir: string) => void): void {
  const root = mkdtempSync(path.join(tmpdir(), 'netlify-build-'));
  const publicDir = path.join(root, 'public');
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<h1>review page</h1>');
  writeFileSync(path.join(publicDir, 'extra.css'), 'body{}');
  try {
    fn(publicDir, path.join(root, 'out'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('normalizeApiUrl', () => {
  test('accepts a backend address and removes trailing slashes', () => {
    assert.equal(normalizeApiUrl('https://app.onrender.com'), 'https://app.onrender.com');
    assert.equal(normalizeApiUrl('  https://app.onrender.com/  '), 'https://app.onrender.com');
    assert.equal(normalizeApiUrl('http://localhost:4700'), 'http://localhost:4700');
    assert.equal(normalizeApiUrl('https://host.example/base/'), 'https://host.example/base');
  });

  test('refuses a missing, malformed or /api address with a message that says what to do', () => {
    assert.throws(() => normalizeApiUrl(undefined), /API_URL is not set.*Environment variables/s);
    assert.throws(() => normalizeApiUrl('   '), NetlifyBuildError);
    for (const bad of ['app.onrender.com', 'ftp://x.com', 'https://', 'https://a b.com', 'https://x.com?x=1', 'https://x.com/#a']) {
      assert.throws(() => normalizeApiUrl(bad), /not a valid address/, bad);
    }
    assert.throws(() => normalizeApiUrl('https://x.com/api'), /must not end with \/api/);
    assert.throws(() => normalizeApiUrl('https://x.com/api/'), /must not end with \/api/);
  });
});

describe('buildNetlifySite', () => {
  test('publishes the page and proxies /api/* to the backend', () =>
    withDirs((publicDir, outDir) => {
      buildNetlifySite({ apiUrl: 'https://app.onrender.com/', publicDir, outDir });
      assert.equal(readFileSync(path.join(outDir, 'index.html'), 'utf8'), '<h1>review page</h1>');
      assert.ok(existsSync(path.join(outDir, 'extra.css')));
      assert.equal(readFileSync(path.join(outDir, '_redirects'), 'utf8'), '/api/*  https://app.onrender.com/api/:splat  200!\n');
      assert.match(readFileSync(path.join(outDir, '_headers'), 'utf8'), /X-Frame-Options: DENY/);
    }));

  test('empties the output folder first, so old files never linger', () =>
    withDirs((publicDir, outDir) => {
      mkdirSync(outDir);
      writeFileSync(path.join(outDir, 'stale.txt'), 'old');
      buildNetlifySite({ apiUrl: 'https://a.example', publicDir, outDir });
      assert.equal(existsSync(path.join(outDir, 'stale.txt')), false);
    }));

  test('fails with a clear reason, and writes nothing, when the settings are wrong', () =>
    withDirs((publicDir, outDir) => {
      assert.throws(() => buildNetlifySite({ apiUrl: undefined, publicDir, outDir }), /API_URL is not set/);
      assert.equal(existsSync(outDir), false);
      assert.throws(() => buildNetlifySite({ apiUrl: 'https://a.example', publicDir: path.join(publicDir, 'missing'), outDir }), /review page was not found/);
    }));
});

describe('the build command Netlify runs', () => {
  test('exits non-zero with a readable message when API_URL is missing', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'netlifyBuild.ts')], {
      env: { ...process.env, API_URL: '' },
      encoding: 'utf8',
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /API_URL is not set/);
  });
});
