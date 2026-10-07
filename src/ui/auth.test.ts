import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, readCookie } from './auth.js';

describe('createAuth', () => {
  const secret = Buffer.from('a'.repeat(32));

  test('accepts only the right password', () => {
    const auth = createAuth({ password: 'correct horse', sessionSecret: secret });
    assert.equal(auth.checkPassword('correct horse'), true);
    for (const wrong of ['', 'correct', 'correct horse ', 'CORRECT HORSE', 'x'.repeat(500)]) {
      assert.equal(auth.checkPassword(wrong), false, JSON.stringify(wrong));
    }
  });

  test('a session token verifies until it expires', () => {
    const auth = createAuth({ password: 'p', sessionSecret: secret, sessionMs: 1000 });
    const token = auth.issueToken(10_000);
    assert.equal(auth.verifyToken(token, 10_500), true);
    assert.equal(auth.verifyToken(token, 11_001), false);
  });

  test('a forged, edited or foreign token is rejected', () => {
    const auth = createAuth({ password: 'p', sessionSecret: secret, sessionMs: 1000 });
    const other = createAuth({ password: 'p', sessionSecret: Buffer.from('b'.repeat(32)), sessionMs: 1000 });
    const token = auth.issueToken(10_000);
    const [payload] = token.split('.');

    assert.equal(auth.verifyToken(undefined), false);
    assert.equal(auth.verifyToken(''), false);
    assert.equal(auth.verifyToken('garbage'), false);
    assert.equal(auth.verifyToken(`${Number(payload) + 99_999_999}.${token.split('.')[1]}`, 10_500), false, 'extended expiry');
    assert.equal(auth.verifyToken(other.issueToken(10_000), 10_500), false, 'signed with another secret');
  });

  test('blocks a client after too many failures within a minute, then lets it back in', () => {
    const auth = createAuth({ password: 'p', sessionSecret: secret, maxFailuresPerMinute: 3 });
    for (let i = 0; i < 3; i += 1) {
      assert.equal(auth.isBlocked('1.2.3.4', 1000 + i), false);
      auth.recordFailure('1.2.3.4', 1000 + i);
    }
    assert.equal(auth.isBlocked('1.2.3.4', 2000), true);
    assert.equal(auth.isBlocked('5.6.7.8', 2000), false, 'other clients are unaffected');
    assert.equal(auth.isBlocked('1.2.3.4', 62_000), false, 'a minute later');
  });
});

describe('readCookie', () => {
  test('finds a named cookie among several', () => {
    assert.equal(readCookie('a=1; pr_review_session=tok.en; b=2', 'pr_review_session'), 'tok.en');
    assert.equal(readCookie('a=1', 'pr_review_session'), undefined);
    assert.equal(readCookie(undefined, 'a'), undefined);
  });
});
