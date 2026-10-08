import type { ReviewIssue, Severity } from '../review/types.js';

/**
 * Deterministic checks for the IFS Cloud customization rules (docs/conventions/ifs-*.md) that a
 * program can verify exactly: file names, comment tag format and pairing, `@Overtake`, and the
 * declaration naming rules. A small local model misses these inconsistently, so they are checked
 * here and merged into the review - the model keeps the judgement calls. Every finding names its
 * rule number so it can be traced back to the documentation.
 *
 * Marble declarations are matched line by line with simple patterns, so naming findings are "low"
 * and say that an override or reuse of a core element is the one legitimate exception.
 */

export interface IfsFile {
  filename: string;
  status: string;
  /** GitHub's unified-diff patch for this file, if it generated one. */
  patch: string | null | undefined;
  /** Full file content at the PR head. Optional: tag pairing and "untagged" checks use it when given. */
  content?: string;
}

const IFS_EXTENSION = /\.(projection|client|fragment|plsvc|plsql)$/i;

export function isIfsFile(filename: string): boolean {
  return IFS_EXTENSION.test(filename);
}

interface Line {
  n: number;
  text: string;
  added: boolean;
}

/** Parses a unified-diff patch into new-file line numbers, keeping context lines for look-behind. */
export function parsePatchLines(patch: string): Line[] {
  const lines: Line[] = [];
  let n = 0;
  for (const raw of patch.split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      n = Number(hunk[1]);
    } else if (raw.startsWith('+')) {
      lines.push({ n, text: raw.slice(1), added: true });
      n += 1;
    } else if (raw.startsWith('-') || raw.startsWith('\\')) {
      // removed line, or "\ No newline at end of file" - neither exists in the new file
    } else {
      lines.push({ n, text: raw.slice(1), added: false });
      n += 1;
    }
  }
  return lines;
}

const TAG_LINE = /^\s*(\/\/|--)\s*\((\+|-|-\/\+)\)/;
const TAG_STRICT =
  /^\s*(\/\/|--)\((\+|-|-\/\+)\)\s*(\d{6})\s+(\S+)\s+(M-[A-Za-z0-9]+-[A-Za-z0-9]+-\d+-\d+)\s*\((start|finish)\)\s*$/i;
// Real customer code mostly uses an older, looser tag style - "--(+) 260522 12gDilshW M122 (Start)",
// "M-128", "M092.D1", "(START)" - than the documented M-[CRIM-ID]-[JIRA-ID]-[N] one. Those tags still
// open and close blocks correctly, so they are accepted for pairing and reported once per file.
const TAG_LOOSE = /^\s*(\/\/|--)\s*\((\+|-|-\/\+)\)\s*(\d{6})\s+(\S+)\s+(\S+)\s*\((start|finish)\)\s*$/i;
const COMMENT_OR_BLANK = /^\s*($|\/\/|--|\/\*|\*)/;
const OVERRIDE_MARKER = /^\s*@(Override|Overtake)\b/i;
const DECLARATION =
  /^\s*(entityset|entity|query|reference|array|enumeration|structure|virtual|singleton|summary|attribute|list|dialog|assistant|group|card|command|selector|chart)\s+([A-Za-z_]\w*)/;

/** Kinds whose line also appears as a plain *use* of an existing element, so only blocks count. */
const BLOCK_ONLY_KINDS = new Set(['list', 'dialog', 'assistant', 'group', 'card', 'command', 'selector', 'chart', 'singleton']);

const REQUIRED_SUFFIX: Record<string, string> = {
  reference: 'Ref',
  array: 'Array',
  enumeration: 'Enum',
  structure: 'Structure',
  virtual: 'Virtual',
  singleton: 'Singleton',
  summary: 'Summary',
  list: 'List',
  dialog: 'Dialog',
  assistant: 'Assistant',
  group: 'Group',
  card: 'Card',
  command: 'Command',
  selector: 'Selector',
  chart: 'Chart',
};

const hasCPrefix = (name: string): boolean => /^C[A-Z]/.test(name);
const baseName = (filename: string): string => filename.split('/').pop() ?? filename;
const extensionOf = (filename: string): string => (/\.([a-z]+)$/i.exec(filename)?.[1] ?? '').toLowerCase();

function issue(severity: Severity, file: string, line: number, title: string, explanation: string, suggestedFix: string): ReviewIssue {
  return { severity, file, line, title, explanation, suggestedFix };
}

function checkFileName(file: IfsFile, firstAddedLine: number): ReviewIssue[] {
  const name = baseName(file.filename);
  const isModelFile = /\.(projection|client|fragment)$/i.test(name);
  if (name.includes('-Cust') || hasCPrefix(name)) {
    // A new C-prefixed projection must end in Handling (or Service, for integrations).
    if (file.status === 'added' && !name.includes('-Cust') && extensionOf(name) === 'projection' && !/(Handling|Service)\.projection$/i.test(name)) {
      return [
        issue('low', file.filename, 1, 'NM9/NM11: projection file name', `The projection file "${name}" should be named C[ClientName]Handling.projection (or end in Service for an integration projection).`, `Rename it, e.g. ${name.replace(/\.projection$/i, '')}Handling.projection.`),
      ];
    }
    return [];
  }
  if (file.status === 'modified') {
    return [
      issue('high', file.filename, firstAddedLine, 'BP1: core file changed', `"${name}" has neither the "-Cust" suffix nor a C prefix, so this looks like a core file. Core files must never be changed; customizations belong in a customization-layer file whose name contains -Cust.`, `Move the change into ${name.replace(/(\.[a-z]+)$/i, '-Cust$1')}.`),
    ];
  }
  if (file.status === 'added' && isModelFile) {
    return [
      issue('low', file.filename, 1, 'NM9: file name needs the C prefix', `"${name}" is a new customization file, but its name starts with neither a C prefix (e.g. CCustomerCrm...) nor the -Cust layer suffix.`, `Rename it with the C prefix, e.g. C${name}.`),
    ];
  }
  return [];
}

interface TagInfo {
  key: string;
  phase: 'start' | 'finish';
  /** True when the ID follows the documented M-[CRIM-ID]-[JIRA-ID]-[N] format. */
  documented: boolean;
}

function parseTag(text: string): TagInfo | undefined {
  const strict = TAG_STRICT.exec(text);
  const m = strict ?? TAG_LOOSE.exec(text);
  if (!m) return undefined;
  return {
    key: `${m[2]}|${m[3]}|${m[4].toLowerCase()}|${m[5].toUpperCase()}`,
    phase: m[6].toLowerCase() as 'start' | 'finish',
    documented: strict !== null,
  };
}

function checkTags(file: IfsFile, patchLines: Line[]): { issues: ReviewIssue[]; insideBlock: Set<number> } {
  const issues: ReviewIssue[] = [];
  const insideBlock = new Set<number>();
  const expectedPrefix = /\.(plsvc|plsql)$/i.test(file.filename) ? '--' : '//';

  let lines: Line[] = patchLines;
  if (file.content !== undefined) {
    const addedNumbers = new Set(patchLines.filter((l) => l.added).map((l) => l.n));
    lines = file.content.split(/\r?\n/).map((text, i) => ({ n: i + 1, text, added: addedNumbers.has(i + 1) }));
  }

  const stack: Array<{ key: string; n: number; added: boolean }> = [];
  const olderStyle: number[] = [];
  const wrongPrefix: number[] = [];
  for (const line of lines) {
    if (!TAG_LINE.test(line.text)) {
      if (stack.length > 0) insideBlock.add(line.n);
      continue;
    }

    const tag = parseTag(line.text);
    if (!tag) {
      if (line.added) {
        issues.push(issue('low', file.filename, line.n, 'CM3: tag line is malformed', 'This tag does not follow //(+) [YYMMDD] [Sign] M-[CRIM-ID]-[JIRA-ID]-[N](start|finish), e.g. //(+)230203 damilk M-M001-LPS-2345-1(start).', 'Rewrite the tag in the documented format.'));
      }
      continue;
    }
    if (line.added && line.text.trimStart().slice(0, 2) !== expectedPrefix) wrongPrefix.push(line.n);

    if (line.added && !tag.documented) olderStyle.push(line.n);

    if (tag.phase === 'start') {
      stack.push({ key: tag.key, n: line.n, added: line.added });
    } else if (file.content !== undefined) {
      const open = stack.pop();
      if (!open) {
        if (line.added) issues.push(issue('medium', file.filename, line.n, 'CM3: finish tag without a start tag', 'Every (finish) tag needs a matching (start) tag above it.', 'Add the missing start tag, or remove this one.'));
      } else if (open.key !== tag.key && (line.added || open.added)) {
        issues.push(issue('medium', file.filename, line.n, 'CM7: finish tag does not match its start tag', `The start tag on line ${open.n} and this finish tag must repeat the same change type, date, sign and ID.`, 'Make the finish tag identical to the start tag (apart from start/finish).'));
      }
    }
  }
  if (wrongPrefix.length > 0) {
    issues.push(issue('low', file.filename, wrongPrefix[0], 'CM4: wrong comment prefix in tags', `${wrongPrefix.length} added tag line(s) do not start with "${expectedPrefix}", which is what tags in ${extensionOf(file.filename)} files use.`, `Start these tag lines with ${expectedPrefix}.`));
  }
  if (olderStyle.length > 0) {
    issues.push(issue('low', file.filename, olderStyle[0], 'CM3: tags do not use the documented ID format', `${olderStyle.length} added tag line(s) use an older style of ID (for example "M122 (Start)") instead of the documented //(+) [YYMMDD] [Sign] M-[CRIM-ID]-[JIRA-ID]-[N](start|finish). They still open and close their blocks correctly.`, 'Use the documented ID format for new tags, e.g. //(+)230203 damilk M-M001-LPS-2345-1(start).'));
  }
  if (file.content !== undefined) {
    for (const open of stack) {
      if (open.added) issues.push(issue('medium', file.filename, open.n, 'CM3: start tag is never closed', 'This (start) tag has no matching (finish) tag, so the tagged section never ends.', 'Add the matching finish tag after the last line of the customized code.'));
    }
  }
  return { issues, insideBlock };
}

function checkAddedLines(file: IfsFile, patchLines: Line[]): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  const ext = extensionOf(file.filename);
  // Marble declarations only exist in model files; in PL/SQL a line like "group by ..." is SQL.
  if (ext === 'plsvc' || ext === 'plsql') return issues;
  const fileHasCPrefix = hasCPrefix(baseName(file.filename));

  patchLines.forEach((line, index) => {
    if (!line.added) return;

    if (/^\s*@Overtake\b/i.test(line.text)) {
      issues.push(issue('medium', file.filename, line.n, 'BP4: @Overtake used', '@Overtake copies the standard code into the customization, and you then have to keep that copy updated through every future release and service update.', 'Use @Override instead if at all possible.'));
      return;
    }

    const decl = DECLARATION.exec(line.text);
    if (!decl) return;
    const [, kind, name] = decl;
    const trimmed = line.text.trim();
    if (BLOCK_ONLY_KINDS.has(kind) && !(trimmed.endsWith('{') || / (for|using) /.test(trimmed))) return;

    // An @Override/@Overtake directly above means this redeclares a core element, whose name is fixed.
    let previous: Line | undefined;
    for (let i = index - 1; i >= 0; i -= 1) {
      if (patchLines[i].text.trim() !== '') {
        previous = patchLines[i];
        break;
      }
    }
    if (previous && OVERRIDE_MARKER.test(previous.text)) return;

    const exception = ' (Ignore this if the line overrides or reuses an existing core element.)';
    const wanted = REQUIRED_SUFFIX[kind];
    if (wanted && !name.endsWith(wanted)) {
      issues.push(issue('low', file.filename, line.n, `NM: ${kind} name should end with ${wanted}`, `The ${kind} "${name}" does not end with the required suffix "${wanted}".${exception}`, `Rename it to ${name}${wanted}.`));
    }
    if ((kind === 'entity' || kind === 'entityset' || kind === 'query') && /(^(Lov|Query|Entity|Qry)(?=[A-Z])|(Lov|Query|Entity|Qry)s?$)/.test(name)) {
      issues.push(issue('low', file.filename, line.n, 'NM2: avoid LOV/Query/Entity/Qry in the name', `"${name}" uses a technical prefix or suffix (Lov, Query, Entity, Qry); the name should be a meaningful one derived from the entity.${exception}`, 'Use a business name, e.g. CUserAllowedCompany instead of CompanyLov.'));
    }
    if ((ext === 'projection' || ext === 'client') && !fileHasCPrefix && !hasCPrefix(name)) {
      issues.push(issue('low', file.filename, line.n, `NM: ${kind} name needs the C prefix`, `New ${kind} "${name}" customizes a core projection/client, so its name needs the C prefix (only elements inside a new C-prefixed projection or client are exempt).${exception}`, `Rename it to C${name}.`));
    }
  });
  return issues;
}

function checkUntagged(file: IfsFile, patchLines: Line[], insideBlock: Set<number>): ReviewIssue[] {
  // Only for edits to an existing file: a brand-new file is covered by the header-comment rule.
  if (file.status !== 'modified') return [];
  const addedCode = patchLines.filter((l) => l.added && !COMMENT_OR_BLANK.test(l.text) && !TAG_LINE.test(l.text));
  const untagged =
    file.content !== undefined
      ? addedCode.filter((l) => !insideBlock.has(l.n))
      : patchLines.some((l) => l.added && TAG_LINE.test(l.text))
        ? []
        : addedCode;
  if (untagged.length === 0) return [];
  return [
    issue('medium', file.filename, untagged[0].n, 'CM3: new code is not wrapped in tag lines', `${untagged.length} added line(s) are outside any start/finish tag block. All new customized code must be tagged: //(+)[YYMMDD] [Sign] M-[CRIM-ID]-[JIRA-ID]-[N](start) ... (finish) (use -- in .plsvc/.plsql files).`, 'Wrap the new code in (+) start and finish tag lines (or (-/+) when modifying existing code).'),
  ];
}

function checkHeader(file: IfsFile, patchLines: Line[]): ReviewIssue[] {
  if (file.status !== 'added' || !/\.(projection|client|plsvc)$/i.test(file.filename)) return [];
  const head = (file.content !== undefined ? file.content.split(/\r?\n/) : patchLines.map((l) => l.text)).slice(0, 15).join('\n');
  if (/Logical unit:|IFS Developer Studio Template/i.test(head)) return [];
  return [
    issue('low', file.filename, 1, 'CM1: header comment is missing', 'New Projection, Client and PLSVC files should keep the header comment generated from cust plsvc (logical unit, component, template version, history line).', 'Add the generated header comment at the top of the file.'),
  ];
}

/**
 * True when a finding the AI model reported on an IFS file is about something the code above already
 * checks exactly (comment tags, header comment, @Overtake, core-file changes, C prefix / suffix
 * naming). A small model gets these wrong - e.g. "missing tags" on a file that has them - so on IFS
 * files its claims in those categories are dropped in favour of the code's own findings.
 */
export function isCoveredByIfsChecks(issue: ReviewIssue): boolean {
  if (!isIfsFile(issue.file)) return false;
  const text = `${issue.title} ${issue.explanation}`;
  return /\b(start|finish)\b.{0,25}\btags?\b|\btags?\b.{0,25}\b(start|finish|missing|incorrect|wrong|malformed)\b|\bcomment tags?\b|\bheader comment\b|@overtake|\bcore file\b|\bC prefix\b|\bsuffix\b|^incorrect naming/i.test(text);
}

/** Runs every deterministic IFS check over the changed IFS files and returns the findings. */
export function findIfsIssues(files: IfsFile[]): ReviewIssue[] {
  const issues: ReviewIssue[] = [];
  for (const file of files) {
    if (!isIfsFile(file.filename) || file.status === 'removed') continue;
    const patchLines = file.patch ? parsePatchLines(file.patch) : [];

    issues.push(...checkFileName(file, patchLines.find((l) => l.added)?.n ?? 1));
    const tags = checkTags(file, patchLines);
    issues.push(...tags.issues);
    issues.push(...checkAddedLines(file, patchLines));
    issues.push(...checkUntagged(file, patchLines, tags.insideBlock));
    issues.push(...checkHeader(file, patchLines));
  }
  return issues;
}
