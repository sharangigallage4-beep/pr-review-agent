import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from './retry.js';

describe('withRetry', () => {
  test('returns the result on the first successful attempt without retrying', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls += 1;
      return 'ok';
    });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  test('retries on failure and succeeds once the underlying function does', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error(`fail ${calls}`);
        return 'eventually ok';
      },
      { retries: 3, delayMs: 1 }
    );
    assert.equal(result, 'eventually ok');
    assert.equal(calls, 3);
  });

  test('throws the last error once every attempt is exhausted', async () => {
    let calls = 0;
    await assert.rejects(
      () =>
        withRetry(
          async () => {
            calls += 1;
            throw new Error(`fail ${calls}`);
          },
          { retries: 2, delayMs: 1 }
        ),
      /fail 3/
    );
    assert.equal(calls, 3); // 1 initial attempt + 2 retries
  });

  test('calls onRetry with the 1-based attempt number, but not before the first try', async () => {
    const retryAttempts: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('fail');
        return 'ok';
      },
      { retries: 3, delayMs: 1, onRetry: (attempt) => retryAttempts.push(attempt) }
    );
    assert.deepEqual(retryAttempts, [1, 2]);
  });

  test('defaults to 2 retries (3 attempts total) when no options are given', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls += 1;
        throw new Error('always fails');
      }, { delayMs: 1 })
    );
    assert.equal(calls, 3);
  });
});
