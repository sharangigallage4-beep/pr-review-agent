import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ReviewIssue } from '../review/types.js';

export interface SourceFile {
  filename: string;
  content: string;
}

const CHECK_TIMEOUT_MS = 10_000;

/** File extensions Node can syntax-check on its own. TypeScript is left to the model and CI's tsc. */
export function isSyntaxCheckable(filename: string): boolean {
  return /\.(c|m)?js$/i.test(filename);
}

/**
 * Runs `node --check` over each JavaScript file and returns one critical finding per file that
 * fails to parse. A parser is deterministic where a language model is not - a small local model
 * routinely misses a single missing bracket - so syntax errors are detected here and merged into
 * the review rather than left to the model. The file is only parsed, never executed.
 */
export function findSyntaxErrors(files: SourceFile[]): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'syntax-check-'));
  try {
    for (const file of files) {
      if (!isSyntaxCheckable(file.filename)) continue;

      // .cjs stays CommonJS; everything else is parsed as an ES module (as this stack uses), where
      // `import`/`export` are valid and CommonJS `require`/`module.exports` still parse fine.
      const target = path.join(dir, /\.cjs$/i.test(file.filename) ? 'check.cjs' : 'check.mjs');
      writeFileSync(target, file.content);
      const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS });
      if (result.status === 0 || result.error) continue;

      const stderr = result.stderr ?? '';
      const lineMatch = /:(\d+)\r?\n/.exec(stderr);
      const messageMatch = /^(?:\w+)?Error: (.+)$/m.exec(stderr);
      const line = lineMatch ? Number(lineMatch[1]) : 1;
      const message = messageMatch ? messageMatch[1].trim() : 'the file could not be parsed';

      issues.push({
        severity: 'critical',
        file: file.filename,
        line,
        title: 'Syntax error',
        explanation: `The JavaScript parser rejects this file: ${message}. The file will fail to load, so everything that imports it will crash. The parser reports where it noticed the problem, which can be a line or two after the real mistake.`,
        suggestedFix:
          'Fix the syntax at or just above this line - most often a missing or extra closing bracket, brace, parenthesis or quote.',
      });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return issues;
}
