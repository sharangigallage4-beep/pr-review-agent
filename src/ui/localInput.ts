import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { readZip, DEFAULT_ZIP_LIMITS } from './zip.js';
import type { ZipLimits } from './zip.js';

/** A problem with the chosen input that is safe to show the user as-is. */
export class LocalInputError extends Error {}

export interface LocalInputEntry {
  name: string;
  kind: 'folder' | 'zip';
}

export interface LoadedInput {
  files: Map<string, Buffer>;
  /** Things left out while loading (skipped entries, oversized files), shown with the results. */
  notes: string[];
}

const SKIPPED_FOLDERS = new Set(['.git', 'node_modules']);

/**
 * The folders and .zip files sitting directly inside the local-input folder. The web UI can only
 * ever offer, and read, these - never an arbitrary path - so it cannot be used to read other files
 * on the machine. Hidden entries and symbolic links are ignored.
 */
export function listLocalInputs(root: string): LocalInputEntry[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const entries: LocalInputEntry[] = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const info = lstatSync(path.join(root, name));
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) entries.push({ name, kind: 'folder' });
    else if (info.isFile() && /\.zip$/i.test(name)) entries.push({ name, kind: 'zip' });
  }
  return entries;
}

function readFolder(dir: string, limits: ZipLimits): LoadedInput {
  const files = new Map<string, Buffer>();
  const notes: string[] = [];
  let total = 0;
  let count = 0;

  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        notes.push(`Skipped ${prefix}${entry.name} (symbolic link).`);
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(path.join(current, entry.name), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.isFile()) continue;
      count += 1;
      if (count > limits.maxEntries) throw new LocalInputError(`The folder has too many files (more than ${limits.maxEntries}).`);
      const full = path.join(current, entry.name);
      const size = lstatSync(full).size;
      if (size > limits.maxFileBytes) {
        notes.push(`Skipped ${prefix}${entry.name} (larger than ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB).`);
        continue;
      }
      total += size;
      if (total > limits.maxTotalBytes) throw new LocalInputError(`The folder is larger than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB, which is not accepted.`);
      files.set(`${prefix}${entry.name}`, readFileSync(full));
    }
  };
  walk(dir, '');
  return { files, notes };
}

/**
 * Loads one entry of the local-input folder, by name, into memory. The name must be exactly one of
 * the entries listLocalInputs() returns; anything else (a path, "..", a missing name) is refused.
 */
export function loadLocalInput(root: string, name: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): LoadedInput {
  const entry = listLocalInputs(root).find((candidate) => candidate.name === name);
  if (!entry) throw new LocalInputError(`"${name}" is not in the local-input folder.`);
  const full = path.join(root, entry.name);
  if (entry.kind === 'folder') return readFolder(full, limits);

  const { files, skipped } = readZip(readFileSync(full), limits);
  return { files, notes: skipped.map((s) => `Skipped ${s.name} (${s.reason}).`) };
}
