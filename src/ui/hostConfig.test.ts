import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isLoopbackHost, platformHosts, resolvePort } from './hostConfig.js';

const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;

describe('resolvePort', () => {
  test('defaults to 4500, and PR_REVIEW_UI_PORT always wins', () => {
    assert.equal(resolvePort(env({})), 4500);
    assert.equal(resolvePort(env({ PR_REVIEW_UI_PORT: '4700' })), 4700);
    assert.equal(resolvePort(env({ PR_REVIEW_UI_PORT: '4700', PORT: '10000', PR_REVIEW_UI_HOST: '0.0.0.0' })), 4700);
  });

  test('a hosting service\'s PORT is used when the UI listens on a public address', () => {
    assert.equal(resolvePort(env({ PORT: '10000', PR_REVIEW_UI_HOST: '0.0.0.0' })), 10000);
  });

  test('an unrelated PORT (the webhook server\'s) never moves a local UI', () => {
    assert.equal(resolvePort(env({ PORT: '4300' })), 4500);
    assert.equal(resolvePort(env({ PORT: '4300', PR_REVIEW_UI_HOST: '127.0.0.1' })), 4500);
  });

  test('ignores a PORT that is not a number', () => {
    assert.equal(resolvePort(env({ PORT: 'abc', PR_REVIEW_UI_HOST: '0.0.0.0' })), 4500);
  });
});

describe('platformHosts', () => {
  test('collects the public host names the hosting services announce', () => {
    assert.deepEqual(platformHosts(env({ RENDER_EXTERNAL_HOSTNAME: 'pr-review-ui.onrender.com' })), ['pr-review-ui.onrender.com']);
    assert.deepEqual(platformHosts(env({ RAILWAY_PUBLIC_DOMAIN: 'app.up.railway.app' })), ['app.up.railway.app']);
    assert.deepEqual(platformHosts(env({ FLY_APP_NAME: 'my-app' })), ['my-app.fly.dev']);
  });

  test('is empty on a normal machine, and ignores blank values', () => {
    assert.deepEqual(platformHosts(env({})), []);
    assert.deepEqual(platformHosts(env({ RENDER_EXTERNAL_HOSTNAME: '  ' })), []);
  });
});

describe('isLoopbackHost', () => {
  test('only this computer\'s own addresses count', () => {
    for (const h of ['127.0.0.1', 'localhost', '::1']) assert.equal(isLoopbackHost(h), true, h);
    for (const h of ['0.0.0.0', '10.0.0.5', 'example.com']) assert.equal(isLoopbackHost(h), false, h);
  });
});
