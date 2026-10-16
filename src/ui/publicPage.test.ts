import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The page's whole script is one block: a single typo in it stops everything (no PR list, no rules, no
// status chips), and nothing else in the test suite would notice - so it is at least compiled here.
test('the web page script is valid JavaScript', () => {
  const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string);
  assert.ok(scripts.length > 0, 'the page has an inline script');
  for (const source of scripts) {
    assert.doesNotThrow(() => new vm.Script(source), 'the inline script must compile');
  }
});

// A second function with an existing name silently replaces the first (the later one wins), which once made the
// header chips disappear. Nothing else would notice, so duplicates are refused here.
test('the web page script declares every function name only once', () => {
  const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
  const source = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] as string).join('\n');
  const names = [...source.matchAll(/^\s*function (\w+)\(/gm)].map((m) => m[1] as string);
  const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  assert.deepEqual(duplicates, []);
});
