import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A problem with the build settings, written for the person reading the Netlify build log. */
export class NetlifyBuildError extends Error {}

/**
 * Checks the backend address given in API_URL and returns it without a trailing slash. It is the
 * address of the running review UI server (for example https://pr-review-agent-ui.onrender.com):
 * the Netlify site forwards every /api/... request there, so the page and the API look like one
 * site to the browser.
 */
export function normalizeApiUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) {
    throw new NetlifyBuildError(
      'API_URL is not set. In Netlify: Site configuration -> Environment variables -> add API_URL = the address of your backend (for example https://pr-review-agent-ui.onrender.com), then trigger a deploy.'
    );
  }
  if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(value)) {
    throw new NetlifyBuildError(`API_URL "${value}" is not a valid address. It must look like https://your-backend.example.com (no spaces, no ? and no #).`);
  }
  const trimmed = value.replace(/\/+$/, '');
  if (/\/api$/i.test(trimmed)) {
    throw new NetlifyBuildError('API_URL must not end with /api - give only the backend address, e.g. https://your-backend.example.com');
  }
  return trimmed;
}

export interface NetlifyBuildOptions {
  apiUrl: string | undefined;
  /** The review page (index.html) to publish. */
  publicDir: string;
  /** Where the site is written; it is emptied first. */
  outDir: string;
}

/**
 * Builds the static Netlify site: the review page plus a `_redirects` file that proxies /api/* to
 * the backend, and a `_headers` file with basic security headers. Throws NetlifyBuildError for bad
 * settings so the build fails with a clear reason instead of publishing a page that cannot work.
 */
export function buildNetlifySite({ apiUrl, publicDir, outDir }: NetlifyBuildOptions): void {
  const backend = normalizeApiUrl(apiUrl);
  if (!existsSync(path.join(publicDir, 'index.html'))) {
    throw new NetlifyBuildError(`The review page was not found in ${publicDir}.`);
  }
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(publicDir, outDir, { recursive: true });
  // Status 200 makes this a proxy (the address in the browser does not change); the "!" applies it
  // even though no file with that name exists.
  writeFileSync(path.join(outDir, '_redirects'), `/api/*  ${backend}/api/:splat  200!\n`);
  writeFileSync(
    path.join(outDir, '_headers'),
    ['/*', '  X-Content-Type-Options: nosniff', '  X-Frame-Options: DENY', '  Referrer-Policy: same-origin', ''].join('\n')
  );
}

// Run as a script: `npx tsx src/ui/netlifyBuild.ts` (what netlify.toml does).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  try {
    buildNetlifySite({
      apiUrl: process.env.API_URL,
      publicDir: path.join(here, 'public'),
      outDir: path.join(here, '..', '..', 'netlify-dist'),
    });
    console.log(`Netlify site built: /api/* is forwarded to ${normalizeApiUrl(process.env.API_URL)}`);
  } catch (err) {
    console.error(err instanceof NetlifyBuildError ? err.message : err);
    process.exitCode = 1;
  }
}
