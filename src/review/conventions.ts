import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MAX_CHARS = 20_000;

/** Folder holding the team's coding-convention .md files, relative to the project root. */
function defaultConventionsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // <root>/src/review in dev (tsx), <root>/dist/review once built - both two levels below the root.
  return path.join(here, '..', '..', 'docs', 'conventions');
}

/**
 * Reads every .md file in the conventions folder (override with PR_REVIEW_CONVENTIONS_DIR) and
 * returns them joined into one string, or '' if the folder is missing or empty - conventions are
 * optional. The files are read from the reviewer's own checkout, never from the PR under review,
 * so a contributor cannot rewrite the rules they are being reviewed against. Output is capped at
 * PR_REVIEW_MAX_CONTEXT_CHARS (default 20000) so a large docs folder can't blow the model's
 * context window.
 */
export function loadConventions(dir: string = process.env.PR_REVIEW_CONVENTIONS_DIR || defaultConventionsDir()): string {
  if (!existsSync(dir)) return '';

  const maxChars = Number(process.env.PR_REVIEW_MAX_CONTEXT_CHARS) || DEFAULT_MAX_CHARS;
  const parts = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort()
    .map((name) => readFileSync(path.join(dir, name), 'utf8').trim())
    .filter((text) => text.length > 0);

  const joined = parts.join('\n\n---\n\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n\n(conventions truncated)` : joined;
}
