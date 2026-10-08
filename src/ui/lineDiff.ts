/**
 * A small unified-diff generator, so two versions of a file can be compared without git: the output
 * has the same shape as the `patch` GitHub returns for a pull-request file ("@@ -a,b +c,d @@" hunks),
 * which is what the rest of the review pipeline (IFS checks, line mapping, the model prompt) reads.
 */

type Op = { kind: ' ' | '-' | '+'; text: string; oldIndex: number; newIndex: number };

/** Above this many cells the exact diff is skipped and the changed middle is shown as replaced. */
const MAX_DP_CELLS = 4_000_000;

function toLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop(); // a final newline is not an extra empty line
  return lines;
}

/** Edit script for the part of the files that differs, as ops over the whole files' line indexes. */
function diffMiddle(a: string[], b: string[], aOffset: number, bOffset: number): Op[] {
  const n = a.length;
  const m = b.length;
  const ops: Op[] = [];

  if (n === 0 || m === 0 || (n + 1) * (m + 1) > MAX_DP_CELLS) {
    a.forEach((text, i) => ops.push({ kind: '-', text, oldIndex: aOffset + i, newIndex: bOffset }));
    b.forEach((text, j) => ops.push({ kind: '+', text, oldIndex: aOffset + n, newIndex: bOffset + j }));
    return ops;
  }

  // Longest-common-subsequence table, filled from the end so the walk below runs forwards.
  const width = m + 1;
  const lcs = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i], oldIndex: aOffset + i, newIndex: bOffset + j });
      i += 1;
      j += 1;
    } else if (i < n && (j === m || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) {
      // Removals come before the matching additions, as in git's output.
      ops.push({ kind: '-', text: a[i], oldIndex: aOffset + i, newIndex: bOffset + j });
      i += 1;
    } else {
      ops.push({ kind: '+', text: b[j], oldIndex: aOffset + i, newIndex: bOffset + j });
      j += 1;
    }
  }
  return ops;
}

/** Returns the unified diff from `oldText` to `newText`, or '' when they have the same lines. */
export function unifiedDiff(oldText: string, newText: string, context = 3): string {
  const a = toLines(oldText);
  const b = toLines(newText);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  if (start === a.length && start === b.length) return '';

  const ops: Op[] = [];
  for (let k = 0; k < start; k += 1) ops.push({ kind: ' ', text: a[k], oldIndex: k, newIndex: k });
  ops.push(...diffMiddle(a.slice(start, endA), b.slice(start, endB), start, start));
  for (let k = 0; k < a.length - endA; k += 1) ops.push({ kind: ' ', text: a[endA + k], oldIndex: endA + k, newIndex: endB + k });

  // Group changed ops with `context` unchanged lines around them; nearby groups share one hunk.
  const changed = ops.map((op, index) => (op.kind === ' ' ? -1 : index)).filter((index) => index >= 0);
  const hunks: Array<[number, number]> = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = hunks[hunks.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }

  const out: string[] = [];
  for (const [from, to] of hunks) {
    const slice = ops.slice(from, to + 1);
    const oldLength = slice.filter((op) => op.kind !== '+').length;
    const newLength = slice.filter((op) => op.kind !== '-').length;
    const first = slice[0];
    // A side with no lines is numbered as the line before the change, as git does.
    const oldStart = oldLength === 0 ? first.oldIndex : first.oldIndex + 1;
    const newStart = newLength === 0 ? first.newIndex : first.newIndex + 1;
    out.push(`@@ -${oldStart},${oldLength} +${newStart},${newLength} @@`);
    for (const op of slice) out.push(`${op.kind}${op.text}`);
  }
  return out.join('\n');
}
