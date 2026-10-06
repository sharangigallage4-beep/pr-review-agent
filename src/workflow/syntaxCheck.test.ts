import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findSyntaxErrors, isSyntaxCheckable } from './syntaxCheck.js';

describe('isSyntaxCheckable', () => {
  test('accepts js/mjs/cjs and rejects everything else', () => {
    for (const f of ['a.js', 'b.mjs', 'c.cjs', 'src/D.JS']) assert.equal(isSyntaxCheckable(f), true, f);
    for (const f of ['a.ts', 'b.json', 'c.md', 'd.jsx.bak']) assert.equal(isSyntaxCheckable(f), false, f);
  });
});

describe('findSyntaxErrors', () => {
  test('returns nothing for valid ESM, valid CommonJS, and non-JS files', () => {
    const issues = findSyntaxErrors([
      { filename: 'ok.js', content: "import fs from 'node:fs';\nexport const a = fs;\n" },
      { filename: 'ok.cjs', content: "const fs = require('node:fs');\nmodule.exports = { fs };\n" },
      { filename: 'notes.md', content: 'this ( is not code' },
    ]);
    assert.deepEqual(issues, []);
  });

  test('reports a missing closing brace as a critical finding with file and line', () => {
    const [issue, ...rest] = findSyntaxErrors([
      { filename: 'src/config.js', content: 'export function loadConfig() {\n  return { a: 1 };\n\nexport const x = 1;\n' },
    ]);
    assert.equal(rest.length, 0);
    assert.equal(issue.severity, 'critical');
    assert.equal(issue.file, 'src/config.js');
    assert.equal(issue.title, 'Syntax error');
    assert.ok(Number.isInteger(issue.line) && issue.line > 0);
    assert.match(issue.explanation, /parser rejects/i);
  });

  test('flags only the broken file when several are given', () => {
    const issues = findSyntaxErrors([
      { filename: 'good.js', content: 'export const a = 1;\n' },
      { filename: 'bad.js', content: 'const b = (1 + 2;\n' },
    ]);
    assert.deepEqual(issues.map((i) => i.file), ['bad.js']);
  });

  test('never executes the code it checks', () => {
    const issues = findSyntaxErrors([{ filename: 'danger.js', content: "throw new Error('should not run');\n" }]);
    assert.deepEqual(issues, []);
  });
});
