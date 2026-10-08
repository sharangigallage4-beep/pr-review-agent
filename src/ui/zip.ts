import { inflateRawSync } from 'node:zlib';

/** A problem with the ZIP itself, safe to show the user as-is. */
export class ZipError extends Error {}

export interface ZipLimits {
  /** Most entries (files + folders) accepted. */
  maxEntries: number;
  /** Largest single file once unpacked. */
  maxFileBytes: number;
  /** Largest total once unpacked - the guard against a "zip bomb". */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
};

export interface ZipContents {
  /** Unpacked files by normalized path (forward slashes, no leading "./" or "/"). Held in memory only. */
  files: Map<string, Buffer>;
  /** Entries that were left out, with the reason - shown to the user instead of being silently dropped. */
  skipped: Array<{ name: string; reason: string }>;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** Turns an entry name into a safe relative path, or undefined if it tries to leave the archive. */
export function normalizeEntryName(raw: string): string | undefined {
  const name = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (name === '' || /^[A-Za-z]:/.test(name) || name.includes('\0')) return undefined;
  if (name.split('/').some((segment) => segment === '..')) return undefined;
  return name;
}

function findEndOfCentralDirectory(buf: Buffer): number {
  // The record is at the very end, followed only by an optional comment of up to 65535 bytes.
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= lowest; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new ZipError('This does not look like a ZIP file (no end-of-archive record was found).');
}

/**
 * Reads a ZIP held in memory. Nothing is written to disk, so a hostile archive cannot place a file
 * anywhere; sizes are checked against the limits BEFORE and while unpacking, so a "zip bomb" cannot
 * exhaust memory. Supports stored and deflated entries (what Windows Explorer and zip tools produce);
 * encrypted entries and ZIP64 archives are reported instead of guessed at.
 */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipContents {
  const eocd = findEndOfCentralDirectory(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);

  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported. Re-create the ZIP without ZIP64 (files under 4 GB).');
  }
  if (entryCount > limits.maxEntries) throw new ZipError(`The ZIP has too many entries (${entryCount}; the limit is ${limits.maxEntries}).`);
  if (centralOffset + centralSize > buf.length) throw new ZipError('The ZIP is damaged (its file list points outside the file).');

  const files = new Map<string, Buffer>();
  const skipped: ZipContents['skipped'] = [];
  let total = 0;
  let pos = centralOffset;

  for (let n = 0; n < entryCount; n += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_SIGNATURE) throw new ZipError('The ZIP is damaged (its file list is unreadable).');

    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const rawName = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;

    if (rawName.endsWith('/')) continue; // a folder
    const name = normalizeEntryName(rawName);
    if (!name) {
      skipped.push({ name: rawName, reason: 'unsafe path' });
      continue;
    }
    if (flags & 0x1) {
      skipped.push({ name, reason: 'password protected' });
      continue;
    }
    if (method !== 0 && method !== 8) {
      skipped.push({ name, reason: `unsupported compression method ${method}` });
      continue;
    }
    if (size > limits.maxFileBytes) {
      skipped.push({ name, reason: `larger than ${Math.round(limits.maxFileBytes / 1024 / 1024)} MB` });
      continue;
    }
    total += size;
    if (total > limits.maxTotalBytes) throw new ZipError(`The ZIP unpacks to more than ${Math.round(limits.maxTotalBytes / 1024 / 1024)} MB, which is not accepted.`);

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) throw new ZipError(`The ZIP is damaged (cannot find the data for ${name}).`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > buf.length) throw new ZipError(`The ZIP is damaged (the data for ${name} is cut off).`);
    const stored = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(stored);
    } else {
      try {
        // maxOutputLength makes a header that understates the real size fail instead of growing.
        data = inflateRawSync(stored, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new ZipError(`The ZIP is damaged or inconsistent (${name} could not be unpacked).`);
      }
    }
    if (data.length !== size) throw new ZipError(`The ZIP is damaged or inconsistent (${name} is not the size it claims).`);
    files.set(name, data);
  }
  return { files, skipped };
}
