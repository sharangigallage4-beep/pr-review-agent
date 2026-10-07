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

const APPLIES_TO = /<!--\s*applies-to:\s*([^>]*?)\s*-->\s*/i;

/**
 * Reads the .md files in the conventions folder (override with PR_REVIEW_CONVENTIONS_DIR) and
 * returns them joined into one string, or '' if the folder is missing or empty - conventions are
 * optional.
 *
 * A file may start with `<!-- applies-to: .projection, .client -->`; it is then included only when
 * at least one of `changedFilenames` has one of those extensions, so a JavaScript PR never carries
 * another stack's rules (which would only confuse a small model and use up context). Files with no
 * such line always apply, and when `changedFilenames` is omitted nothing is filtered.
 *
 * The files are read from the reviewer's own checkout, never from the PR under review, so a
 * contributor cannot rewrite the rules they are being reviewed against. Output is capped at
 * PR_REVIEW_MAX_CONTEXT_CHARS (default 20000) so a large docs folder can't blow the model's
 * context window.
 */
export function loadConventions(
  dir: string = process.env.PR_REVIEW_CONVENTIONS_DIR || defaultConventionsDir(),
  changedFilenames?: string[]
): string {
  if (!existsSync(dir)) return '';

  const extensions = changedFilenames?.map((name) => path.extname(name).toLowerCase());
  const maxChars = Number(process.env.PR_REVIEW_MAX_CONTEXT_CHARS) || DEFAULT_MAX_CHARS;

  const parts = readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort()
    .map((name) => readFileSync(path.join(dir, name), 'utf8').trim())
    .filter((text) => text.length > 0)
    .flatMap((text) => {
      const match = APPLIES_TO.exec(text);
      if (!match) return [text];
      const body = text.replace(APPLIES_TO, '').trim();
      if (!extensions) return [body];
      const wanted = match[1].split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
      return extensions.some((ext) => wanted.includes(ext)) ? [body] : [];
    });

  const joined = parts.join('\n\n---\n\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n\n(conventions truncated)` : joined;
}
