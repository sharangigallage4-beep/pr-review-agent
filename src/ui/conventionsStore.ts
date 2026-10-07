import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CONVENTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}\.md$/;
export const MAX_CONVENTION_CHARS = 60_000;

export interface ConventionDoc {
  name: string;
  /** File extensions from the `<!-- applies-to: ... -->` line, or null when the document always applies. */
  appliesTo: string[] | null;
  /** Number of numbered rules ("- N1.", "- CM3." ...) in the document. */
  ruleCount: number;
  chars: number;
  content: string;
}

/** A problem with a request that is safe to show the user as-is. */
export class ConventionError extends Error {}

function describe(name: string, content: string): ConventionDoc {
  const applies = /<!--\s*applies-to:\s*([^>]*?)\s*-->/i.exec(content);
  return {
    name,
    appliesTo: applies ? applies[1].split(',').map((e) => e.trim()).filter(Boolean) : null,
    ruleCount: (content.match(/^\s*-\s+[A-Z]{1,3}\d+\./gm) ?? []).length,
    chars: content.length,
    content,
  };
}

/** Lists the convention documents the reviewer will load (the same folder loadConventions() reads). */
export function listConventionDocs(dir: string): ConventionDoc[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => CONVENTION_NAME.test(name))
    .sort()
    .map((name) => describe(name, readFileSync(path.join(dir, name), 'utf8')));
}

function checkName(name: string): void {
  if (!CONVENTION_NAME.test(name)) {
    throw new ConventionError('The file name must be letters, digits, "-" or "_" and end in .md (for example my-rules.md).');
  }
}

export function saveConventionDoc(dir: string, name: string, content: string): ConventionDoc {
  checkName(name);
  if (content.trim().length === 0) throw new ConventionError('The document is empty.');
  if (content.length > MAX_CONVENTION_CHARS) {
    throw new ConventionError(`The document is too long (${content.length} characters; the limit is ${MAX_CONVENTION_CHARS}).`);
  }
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, target);
  return describe(name, content);
}

/** Returns false when there was no such document. */
export function deleteConventionDoc(dir: string, name: string): boolean {
  checkName(name);
  const target = path.join(dir, name);
  if (!existsSync(target)) return false;
  rmSync(target);
  return true;
}
