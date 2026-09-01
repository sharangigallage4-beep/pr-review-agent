// The diff-line mapping system: turns a unified diff patch into a precise per-line map, so a
// Claude-reported {file, line} can be checked against what was ACTUALLY changed - not just
// "somewhere near a hunk" - before it's ever allowed to become an inline GitHub comment.
//
// GitHub's classic review-comment API is line-position-based: each line shown in a file's diff
// has a 1-based "position" counted from the first hunk header, and only positions that exist in
// that count are valid places to comment. This module reconstructs that position for every line,
// which is also what makes it possible to tell a genuinely-changed line apart from a context line
// that merely happens to share a line number with one.

export type DiffLineType = 'add' | 'del' | 'context';

export interface DiffPositionEntry {
  /** 1-based position within this file's diff text, counting from the first hunk header. */
  position: number;
  type: DiffLineType;
  /** Line number in the OLD (base) version of the file, or null for a pure addition. */
  oldLine: number | null;
  /** Line number in the NEW (head) version of the file, or null for a pure deletion. */
  newLine: number | null;
}

export interface FileDiffMap {
  entries: DiffPositionEntry[];
  /** New-file line number -> entry, for every line that exists in the new file (add + context). */
  byNewLine: Map<number, DiffPositionEntry>;
  /** Old-file line number -> entry, for every line that exists in the old file (del + context). */
  byOldLine: Map<number, DiffPositionEntry>;
}

// e.g. "@@ -12,7 +15,9 @@ function foo() {" -> old side starts at 12, new side starts at 15.
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a single file's unified-diff patch (as returned by GitHub's changed-files API) into a
 * full line-by-line map. Ignores any `diff --git` / `---` / `+++` header lines if present (a raw
 * GitHub `patch` field doesn't include them, but this stays correct if given a fuller diff text)
 * and any content before the first hunk header.
 */
export function parseFileDiff(patch: string | null | undefined): FileDiffMap {
  const entries: DiffPositionEntry[] = [];
  const byNewLine = new Map<number, DiffPositionEntry>();
  const byOldLine = new Map<number, DiffPositionEntry>();

  if (!patch) return { entries, byNewLine, byOldLine };

  let oldLine = 0;
  let newLine = 0;
  let position = 0;
  let inHunk = false;

  for (const rawLine of patch.split('\n')) {
    const hunkMatch = HUNK_HEADER_RE.exec(rawLine);
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      inHunk = true;
      position += 1; // the "@@ ... @@" line itself counts toward the position sequence
      continue;
    }

    if (!inHunk) continue;

    if (rawLine.startsWith('diff --git') || rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) {
      continue; // not part of any hunk's line count if present at all
    }

    if (rawLine.startsWith('\\')) {
      // e.g. "\ No newline at end of file" - occupies a position but isn't a real source line.
      position += 1;
      continue;
    }

    position += 1;
    const marker = rawLine.charAt(0);

    if (marker === '+') {
      const entry: DiffPositionEntry = { position, type: 'add', oldLine: null, newLine };
      entries.push(entry);
      byNewLine.set(newLine, entry);
      newLine += 1;
    } else if (marker === '-') {
      const entry: DiffPositionEntry = { position, type: 'del', oldLine, newLine: null };
      entries.push(entry);
      byOldLine.set(oldLine, entry);
      oldLine += 1;
    } else {
      // A context line - GitHub always prefixes it with a space, but treat anything else
      // (including a genuinely blank line) the same way rather than silently dropping it.
      const entry: DiffPositionEntry = { position, type: 'context', oldLine, newLine };
      entries.push(entry);
      byOldLine.set(oldLine, entry);
      byNewLine.set(newLine, entry);
      oldLine += 1;
      newLine += 1;
    }
  }

  return { entries, byNewLine, byOldLine };
}

export type LineMapping =
  | { mapped: true; side: 'RIGHT'; line: number; position: number }
  | { mapped: false; reason: 'no_diff' | 'line_not_in_diff' | 'line_not_changed' };

/**
 * Maps a Claude-reported line number (always against the new/head version of the file) to a
 * validated, safely-commentable diff position - or explains exactly why it can't be.
 *
 * Deliberately stricter than "is this line shown somewhere in a hunk": a line that exists in the
 * new file within a hunk but was never actually touched (pure context, shown only for
 * surrounding readability) is reported as `line_not_changed`, not accepted. Only lines Claude
 * could plausibly be reviewing - ones the diff actually added - are considered safe to place an
 * inline comment on.
 */
export function mapLineToDiffPosition(patch: string | null | undefined, line: number): LineMapping {
  const diff = parseFileDiff(patch);
  if (diff.entries.length === 0) return { mapped: false, reason: 'no_diff' };

  const entry = diff.byNewLine.get(line);
  if (!entry) return { mapped: false, reason: 'line_not_in_diff' };
  if (entry.type !== 'add') return { mapped: false, reason: 'line_not_changed' };

  return { mapped: true, side: 'RIGHT', line, position: entry.position };
}
