import type { ReviewIssue } from '../review/types.js';
import { reviewPullRequest as defaultReview } from '../review/reviewService.js';
import { filterReviewableFiles } from '../workflow/fileFilter.js';
import { findIfsIssues as defaultFindIfsIssues, isCoveredByIfsChecks } from '../workflow/ifsCheck.js';
import { findSyntaxErrors as defaultFindSyntaxErrors } from '../workflow/syntaxCheck.js';
import { unifiedDiff } from './lineDiff.js';

export interface VersionReviewInput {
  /** The version being checked: unpacked files by relative path. */
  newFiles: Map<string, Buffer>;
  /** The previous version. Without it every file counts as new, which is noisy for an existing solution. */
  oldFiles?: Map<string, Buffer>;
  /** Shown in the results, e.g. the folder or ZIP name. */
  label: string;
  /** False = rule checks only (fast); true = also ask the AI model, in batches. */
  useAi: boolean;
  /** Notes from loading the input (e.g. entries that were skipped), shown with the results. */
  notes?: string[];
}

export interface VersionReviewDeps {
  log: (message: string) => void;
  review?: typeof defaultReview;
  findIfsIssues?: typeof defaultFindIfsIssues;
  findSyntaxErrors?: typeof defaultFindSyntaxErrors;
  /** Most characters of diff sent to the model in one request. Default 18000 (fits a 16k-token window). */
  maxBatchChars?: number;
  /** Most AI requests per run, so a huge change set cannot run for hours. Default 40. */
  maxBatches?: number;
}

export interface VersionReviewResult {
  summary: string;
  findings: ReviewIssue[];
}

interface ChangedFile {
  filename: string;
  status: 'added' | 'modified';
  patch: string;
  content: string;
  additions: number;
  deletions: number;
  truncated?: boolean;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const TRUNCATION_NOTE = '\n(diff truncated - the rest of this file was not shown to the AI)';

function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8000));
  return !sample.includes(0);
}

/** If every path shares one top-level folder (a wrapper folder added when zipping), drop it. */
export function stripCommonRoot(files: Map<string, Buffer>): Map<string, Buffer> {
  const names = [...files.keys()];
  if (names.length === 0 || !names.every((n) => n.includes('/'))) return files;
  const root = names[0].split('/')[0];
  if (!names.every((n) => n.startsWith(`${root}/`))) return files;
  return new Map(names.map((n) => [n.slice(root.length + 1), files.get(n) as Buffer]));
}

/**
 * Lines up the paths of two versions. A ZIP often has a wrapper folder the other version lacks
 * (customer-solution/purch/... vs purch/...), but a real top-level component folder must NOT be
 * stripped - and which is which cannot be told from one version alone. So each combination of
 * stripping is tried and the one where the most paths match wins (no stripping on a tie).
 */
export function alignVersions(oldFiles: Map<string, Buffer>, newFiles: Map<string, Buffer>): { oldFiles: Map<string, Buffer>; newFiles: Map<string, Buffer> } {
  const strippedOld = stripCommonRoot(oldFiles);
  const strippedNew = stripCommonRoot(newFiles);
  const candidates = [
    { oldFiles, newFiles },
    { oldFiles: strippedOld, newFiles },
    { oldFiles, newFiles: strippedNew },
    { oldFiles: strippedOld, newFiles: strippedNew },
  ];
  const overlap = (c: { oldFiles: Map<string, Buffer>; newFiles: Map<string, Buffer> }) => [...c.newFiles.keys()].filter((name) => c.oldFiles.has(name)).length;
  let best = candidates[0];
  for (const candidate of candidates) if (overlap(candidate) > overlap(best)) best = candidate;
  return best;
}

function countLines(patch: string, prefix: '+' | '-'): number {
  return patch.split('\n').filter((l) => l.startsWith(prefix) && !l.startsWith('@@')).length;
}

function truncatePatch(patch: string, limit: number): string {
  if (patch.length <= limit) return patch;
  const cut = patch.lastIndexOf('\n', limit);
  return patch.slice(0, cut > 0 ? cut : limit) + TRUNCATION_NOTE;
}

/** Splits files into groups whose patches fit one model request each. */
function batchFiles(files: ChangedFile[], maxChars: number): ChangedFile[][] {
  const batches: ChangedFile[][] = [];
  let current: ChangedFile[] = [];
  let size = 0;
  for (const file of files) {
    const length = Math.min(file.patch.length, maxChars) + file.filename.length + 40;
    if (current.length > 0 && size + length > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Compares two versions of a solution and reviews only what changed - entirely in memory and on
 * this machine; nothing is written to disk or sent to GitHub. The deterministic rule
 * checks cover every changed file; the AI model, if enabled, reviews the diffs in batches sized to its
 * context window. A failed AI batch is reported but does not discard the rule-check findings.
 */
export async function runVersionReview(input: VersionReviewInput, deps: VersionReviewDeps): Promise<VersionReviewResult> {
  const { log } = deps;
  const review = deps.review ?? defaultReview;
  const findIfsIssues = deps.findIfsIssues ?? defaultFindIfsIssues;
  const findSyntaxErrors = deps.findSyntaxErrors ?? defaultFindSyntaxErrors;
  const maxBatchChars = deps.maxBatchChars ?? 18_000;
  const maxBatches = deps.maxBatches ?? 40;

  // A wrapper folder added when zipping must not make every path differ between the versions.
  const { oldFiles, newFiles } = input.oldFiles ? alignVersions(input.oldFiles, input.newFiles) : { oldFiles: undefined, newFiles: input.newFiles };
  const warnings: string[] = [...(input.notes ?? [])];

  const removed = oldFiles ? [...oldFiles.keys()].filter((n) => !newFiles.has(n)).length : 0;
  const candidates = filterReviewableFiles([...newFiles.keys()].map((filename) => ({ filename })));
  const changed: ChangedFile[] = [];
  let unchanged = 0;
  for (const { filename } of candidates) {
    const data = newFiles.get(filename) as Buffer;
    if (!looksLikeText(data)) continue;
    if (data.length > MAX_TEXT_FILE_BYTES) {
      warnings.push(`Skipped ${filename} (over ${MAX_TEXT_FILE_BYTES / 1024} KB - too large to review as text).`);
      continue;
    }
    const before = oldFiles?.get(filename);
    if (before && before.equals(data)) {
      unchanged += 1;
      continue;
    }
    const content = data.toString('utf8');
    const patch = unifiedDiff(before ? before.toString('utf8') : '', content);
    if (patch === '') {
      unchanged += 1; // only line endings differed
      continue;
    }
    changed.push({
      filename,
      status: before ? 'modified' : 'added',
      patch,
      content,
      additions: countLines(patch, '+'),
      deletions: countLines(patch, '-'),
    });
  }
  changed.sort((a, b) => a.filename.localeCompare(b.filename));
  const added = changed.filter((f) => f.status === 'added').length;
  log(`${changed.length} changed file(s) to review (${added} new, ${changed.length - added} modified, ${unchanged} unchanged, ${removed} removed)`);

  if (changed.length === 0) {
    return { summary: `No reviewable changes found in ${input.label}. ${warnings.join(' ')}`.trim(), findings: [] };
  }

  // --- rule checks: every changed file, no model involved
  log('Running the rule checks');
  const ruleFindings: ReviewIssue[] = [
    ...findIfsIssues(changed.map((f) => ({ filename: f.filename, status: f.status, patch: f.patch, content: f.content }))),
    ...findSyntaxErrors(changed.map((f) => ({ filename: f.filename, content: f.content }))),
  ];
  log(`Rule checks found ${ruleFindings.length} finding(s)`);

  // --- AI review: batches that fit the model's context window
  const aiFindings: ReviewIssue[] = [];
  let aiNote = 'AI review: off (rule checks only).';
  if (input.useAi) {
    const forModel = changed.map((f) => ({ ...f, truncated: f.patch.length > maxBatchChars, patch: truncatePatch(f.patch, maxBatchChars) }));
    for (const f of forModel) if (f.truncated) warnings.push(`${f.filename}: only the first part of its diff went to the AI (rule checks covered all of it).`);
    const all = batchFiles(forModel, maxBatchChars);
    const batches = all.slice(0, maxBatches);
    if (all.length > batches.length) warnings.push(`The AI reviewed the first ${batches.length} of ${all.length} batches; narrow the change set to cover the rest.`);

    let failed = 0;
    for (let i = 0; i < batches.length; i += 1) {
      const files = batches[i];
      log(`AI is reviewing batch ${i + 1} of ${batches.length} (${files.length} file${files.length === 1 ? '' : 's'})`);
      try {
        const result = await review({
          pullRequest: { repository: input.label, number: 0, title: `Changes in ${input.label}`, description: '', author: null, baseRef: 'previous version', headRef: 'new version' },
          diff: files.map((f) => `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch}`).join('\n'),
          changedFiles: files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: f.patch })),
        });
        const known = new Set(files.map((f) => f.filename));
        // A file the model invented cannot be a real finding; keep only those about this batch's files.
        // ...and on IFS files, claims the rule checks already cover exactly (often wrong from a small model).
        aiFindings.push(...result.issues.filter((issue) => known.has(issue.file) && !isCoveredByIfsChecks(issue)));
      } catch (err) {
        failed += 1;
        log(`AI batch ${i + 1} failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }
    aiNote = `AI review: ${aiFindings.length} finding(s) from ${batches.length - failed} of ${batches.length} batch(es)` + (failed ? ` (${failed} failed - is the AI model running?)` : '') + '.';
  }

  const findings = [...ruleFindings, ...aiFindings].sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || a.file.localeCompare(b.file) || a.line - b.line
  );
  const summary = [
    `Compared ${input.label}${oldFiles ? '' : ' (no previous version given - every file counts as new)'}: ${changed.length} changed file(s) (${added} new, ${changed.length - added} modified${removed ? `, ${removed} removed` : ''}).`,
    `Rule checks: ${ruleFindings.length} finding(s).`,
    aiNote,
    ...warnings.slice(0, 8),
    warnings.length > 8 ? `…and ${warnings.length - 8} more notes.` : '',
  ].filter(Boolean).join(' ');
  return { summary, findings };
}
