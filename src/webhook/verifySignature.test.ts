import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyGitHubSignature } from './verifySignature.js';

const secret = 'test-webhook-secret';
const payload = Buffer.from(JSON.stringify({ action: 'opened', number: 1 }));

function sign(body: Buffer, withSecret: string): string {
  return `sha256=${createHmac('sha256', withSecret).update(body).digest('hex')}`;
}

describe('verifyGitHubSignature', () => {
  test('accepts a correctly signed payload', () => {
    assert.equal(verifyGitHubSignature(payload, sign(payload, secret), secret), true);
  });

  test('rejects a signature computed with the wrong secret', () => {
    assert.equal(verifyGitHubSignature(payload, sign(payload, 'wrong-secret'), secret), false);
  });

  test('rejects a signature computed over a different payload', () => {
    const tamperedPayload = Buffer.from(JSON.stringify({ action: 'opened', number: 2 }));
    assert.equal(verifyGitHubSignature(tamperedPayload, sign(payload, secret), secret), false);
  });

  test('rejects a missing signature header', () => {
    assert.equal(verifyGitHubSignature(payload, undefined, secret), false);
  });

  test('rejects a header without the sha256= prefix', () => {
    const raw = createHmac('sha256', secret).update(payload).digest('hex');
    assert.equal(verifyGitHubSignature(payload, raw, secret), false);
  });

  test('rejects a malformed/short signature without throwing', () => {
    assert.equal(verifyGitHubSignature(payload, 'sha256=not-hex-and-too-short', secret), false);
  });

  test('rejects an empty string signature', () => {
    assert.equal(verifyGitHubSignature(payload, '', secret), false);
  });
});
