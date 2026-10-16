import { LocalInputError, type LoadedInput } from './localInput.js';
import { normalizeEntryName, readZip, ZipError, type ZipLimits } from './zip.js';

/**
 * Files chosen in the browser (loose files, a whole folder, or one ZIP) arrive as JSON, each file's content
 * base64 encoded. They are checked here and unpacked into memory only - nothing is written to disk.
 */
export interface UploadedFile {
  /** The path inside the folder (for a folder pick) or just the file name. */
  path: string;
  /** The content, base64 encoded. */
  data: string;
}

export interface UploadLimits {
  /** Most files in one version. */
  maxFiles: number;
  /** A loose file larger than this is skipped with a note. */
  maxFileBytes: number;
  /** Largest total after decoding. */
  maxTotalBytes: number;
  zip: ZipLimits;
}

export const UPLOAD_LIMITS: UploadLimits = {
  maxFiles: 3000,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalBytes: 10 * 1024 * 1024,
  zip: { maxEntries: 5000, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 30 * 1024 * 1024 },
};

const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);
const mb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`;

function decodedSize(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Turns one uploaded version into files held in memory; throws a LocalInputError that is safe to show. */
export function loadUpload(upload: unknown, what: string, limits: UploadLimits = UPLOAD_LIMITS): LoadedInput {
  const files = (upload as { files?: unknown } | null | undefined)?.files;
  if (!Array.isArray(files) || files.length === 0) throw new LocalInputError(`Choose the ${what} files first.`);
  if (files.length > limits.maxFiles) throw new LocalInputError(`The ${what} has too many files (more than ${limits.maxFiles}). Choose a smaller folder.`);

  const entries: Array<{ name: string; data: string }> = [];
  for (const file of files) {
    const { path: rawPath, data } = (file ?? {}) as Partial<UploadedFile>;
    if (typeof rawPath !== 'string' || typeof data !== 'string') throw new LocalInputError(`The ${what} upload is not in the expected format.`);
    entries.push({ name: rawPath, data });
  }

  // A single .zip is unpacked like a folder.
  if (entries.length === 1 && /\.zip$/i.test(entries[0].name)) {
    if (decodedSize(entries[0].data) > limits.maxTotalBytes) throw new LocalInputError(`The ${what} ZIP is larger than ${mb(limits.maxTotalBytes)}, which is not accepted.`);
    try {
      const { files: unpacked, skipped } = readZip(Buffer.from(entries[0].data, 'base64'), limits.zip);
      return { files: unpacked, notes: skipped.map((s) => `Skipped ${s.name} (${s.reason}).`) };
    } catch (err) {
      if (err instanceof ZipError) throw new LocalInputError(`The ${what} ZIP could not be read: ${err.message}`);
      throw err;
    }
  }

  const result = new Map<string, Buffer>();
  const notes: string[] = [];
  let total = 0;
  for (const { name, data } of entries) {
    const normalized = normalizeEntryName(name);
    if (normalized === undefined) {
      notes.push(`Skipped "${name.slice(0, 60)}" (not a usable file path).`);
      continue;
    }
    if (normalized.split('/').some((part) => SKIPPED_FOLDERS.has(part))) continue;
    if (decodedSize(data) > limits.maxFileBytes) {
      notes.push(`Skipped ${normalized} (larger than ${mb(limits.maxFileBytes)}).`);
      continue;
    }
    const content = Buffer.from(data, 'base64');
    total += content.length;
    if (total > limits.maxTotalBytes) throw new LocalInputError(`The ${what} is larger than ${mb(limits.maxTotalBytes)}, which is not accepted.`);
    result.set(normalized, content);
  }
  if (result.size === 0) throw new LocalInputError(`No usable files were found in the ${what}.${notes.length ? ' ' + notes[0] : ''}`);
  return { files: result, notes };
}
