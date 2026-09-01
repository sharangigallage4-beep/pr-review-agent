import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from './args.js';

describe('parseCliArgs', () => {
  test('parses --owner=/--repo=/--pr= into a typed args object', () => {
    const result = parseCliArgs(['--owner=my-org', '--repo=my-repo', '--pr=123']);
    assert.deepEqual(result, { ok: true, args: { owner: 'my-org', repo: 'my-repo', pr: 123 } });
  });

  test('ignores flag order', () => {
    const result = parseCliArgs(['--pr=7', '--repo=widgets', '--owner=acme']);
    assert.deepEqual(result, { ok: true, args: { owner: 'acme', repo: 'widgets', pr: 7 } });
  });

  test('reports every missing required argument at once', () => {
    const result = parseCliArgs([]);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /owner/);
      assert.match(result.error, /repo/);
      assert.match(result.error, /pr/);
      assert.match(result.error, /npm run review/);
    }
  });

  test('reports only the arguments that are actually missing', () => {
    const result = parseCliArgs(['--owner=acme', '--repo=widgets']);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /Missing required argument\(s\): pr/);
    }
  });

  test('rejects a non-numeric --pr', () => {
    const result = parseCliArgs(['--owner=acme', '--repo=widgets', '--pr=abc']);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /positive integer/);
  });

  test('rejects a zero or negative --pr', () => {
    for (const pr of ['0', '-5']) {
      const result = parseCliArgs(['--owner=acme', '--repo=widgets', `--pr=${pr}`]);
      assert.equal(result.ok, false);
    }
  });

  test('ignores unrelated argv entries', () => {
    const result = parseCliArgs(['node', 'review.js', '--owner=acme', '--repo=widgets', '--pr=1', '--verbose']);
    assert.deepEqual(result, { ok: true, args: { owner: 'acme', repo: 'widgets', pr: 1 } });
  });
});
