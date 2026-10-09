import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { listenErrorMessage } from './listenError.js';

const err = (code: string, message = 'boom'): NodeJS.ErrnoException => Object.assign(new Error(message), { code });

describe('listenErrorMessage', () => {
  test('a port reserved by Windows (EACCES) explains the cause and how to pick another port', () => {
    const text = listenErrorMessage(err('EACCES'), '127.0.0.1', 4500);
    assert.match(text, /127\.0\.0\.1:4500/);
    assert.match(text, /reserves some port ranges/);
    assert.match(text, /netsh int ipv4 show excludedportrange/);
    assert.match(text, /PR_REVIEW_UI_PORT/);
  });

  test('a port already in use (EADDRINUSE) mentions another copy still running', () => {
    const text = listenErrorMessage(err('EADDRINUSE'), '127.0.0.1', 4500);
    assert.match(text, /port 4500 is already in use/);
    assert.match(text, /another terminal window/i);
  });

  test('a bad host address and unknown errors are still reported with their detail', () => {
    assert.match(listenErrorMessage(err('EADDRNOTAVAIL'), '10.9.9.9', 4500), /no address 10\.9\.9\.9/);
    assert.match(listenErrorMessage(err('EWHATEVER', 'strange failure'), 'localhost', 80), /localhost:80: strange failure/);
  });
});
