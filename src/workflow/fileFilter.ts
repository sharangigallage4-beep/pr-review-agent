// Decides which changed files are worth sending to Claude at all. Kept as a standalone, pure
// module (string in, boolean out) so the ignore rules can be unit tested and extended without
// touching the orchestrator.

const IGNORED_EXACT_FILENAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

// Matched against any path segment, case-insensitively - catches "node_modules/x.js",
// "packages/foo/dist/index.js", "server/build/main.js", etc., not just top-level directories.
const IGNORED_PATH_SEGMENTS = new Set(['node_modules', 'dist', 'build', 'generated']);

// Common generated-code conventions that don't live under a "generated/" directory.
const GENERATED_FILENAME_PATTERNS: RegExp[] = [
  /\.min\.(js|css)$/i,
  /\.generated\.[^./]+$/i,
  /\.pb\.go$/i,
  /_pb2\.py$/i,
  /\.g\.dart$/i,
];

// Extension-based binary detection. Not exhaustive by design - it covers the common cases
// (images, fonts, archives, compiled artifacts, media, databases) without trying to be a full
// MIME sniffer; add to this list as new binary types show up in practice.
const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'zip', 'tar', 'gz', 'tgz', '7z', 'rar',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'war',
  'mp3', 'mp4', 'mov', 'avi', 'wav', 'flac',
  'pdf',
  'db', 'sqlite', 'sqlite3',
]);

export function shouldIgnoreFile(filename: string): boolean {
  const normalized = filename.replace(/\\/g, '/');
  const basename = normalized.split('/').pop() ?? normalized;
  const basenameLower = basename.toLowerCase();

  if (IGNORED_EXACT_FILENAMES.has(basenameLower)) return true;

  const segments = normalized.toLowerCase().split('/');
  if (segments.some((segment) => IGNORED_PATH_SEGMENTS.has(segment))) return true;

  if (GENERATED_FILENAME_PATTERNS.some((pattern) => pattern.test(normalized))) return true;

  const dotIndex = basenameLower.lastIndexOf('.');
  const extension = dotIndex >= 0 ? basenameLower.slice(dotIndex + 1) : '';
  if (BINARY_EXTENSIONS.has(extension)) return true;

  return false;
}

export function filterReviewableFiles<T extends { filename: string }>(files: T[]): T[] {
  return files.filter((file) => !shouldIgnoreFile(file.filename));
}
