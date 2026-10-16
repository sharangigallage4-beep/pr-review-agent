import { withRetry } from '../webhook/retry.js';
import { isTransientRead } from '../workflow/githubRetry.js';
import { LocalInputError, type LoadedInput } from './localInput.js';
import { readZip, ZipError, type ZipLimits } from './zip.js';
import { UPLOAD_LIMITS } from './uploadInput.js';

export interface BranchInfo {
  name: string;
  isDefault: boolean;
}

const TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const UNREACHABLE = 'Could not reach GitHub. Check your internet connection and try again.';

/** A branch name that is safe to put in a URL and cannot be a path trick. */
export const BRANCH_PATTERN = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

async function githubGet(url: string, token: string, fetchFn: typeof fetch, accept: string, timeoutMs: number): Promise<Response> {
  try {
    return await withRetry(
      async () => {
        const response = await fetchFn(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: accept, 'User-Agent': 'pr-review-agent' },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) {
          throw Object.assign(new Error(`GitHub returned ${response.status}`), { status: response.status });
        }
        return response;
      },
      { retries: 3, delayMs: 500, shouldRetry: isTransientRead }
    );
  } catch (err) {
    if (isTransientRead(err)) throw new LocalInputError(UNREACHABLE);
    throw err;
  }
}

function explain(res: Response, owner: string, repo: string, what: string): LocalInputError {
  if (res.status === 404) return new LocalInputError(`${what}: ${owner}/${repo} was not found, or the token cannot see it.`);
  if (res.status === 401 || res.status === 403) return new LocalInputError('GitHub rejected the token (check GITHUB_TOKEN and its permissions).');
  return new LocalInputError(`${what}: GitHub returned ${res.status}.`);
}

/** The branches of a repository, the default one first. */
export async function listBranches(owner: string, repo: string, token: string, fetchFn: typeof fetch = fetch): Promise<BranchInfo[]> {
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const accept = 'application/vnd.github+json';

  const repoRes = await githubGet(base, token, fetchFn, accept, TIMEOUT_MS);
  if (!repoRes.ok) throw explain(repoRes, owner, repo, 'Could not read the repository');
  const defaultBranch = ((await repoRes.json()) as { default_branch?: string }).default_branch;

  const names: string[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const res = await githubGet(`${base}/branches?per_page=100&page=${page}`, token, fetchFn, accept, TIMEOUT_MS);
    if (!res.ok) throw explain(res, owner, repo, 'Could not list the branches');
    const batch = (await res.json()) as Array<{ name: string }>;
    names.push(...batch.map((b) => b.name));
    if (batch.length < 100) break;
  }
  return names
    .map((name) => ({ name, isDefault: name === defaultBranch }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

/** Reads a response body but gives up once it is larger than `maxBytes`, so a huge repository cannot fill the memory. */
async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new LocalInputError(`This branch is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, which is not accepted. Choose a smaller repository or compare with files from your computer.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The files of one branch, downloaded as GitHub's ZIP of the branch and unpacked in memory only. */
export async function loadBranch(
  owner: string,
  repo: string,
  branch: string,
  token: string,
  fetchFn: typeof fetch = fetch,
  limits: { maxDownloadBytes: number; zip: ZipLimits } = { maxDownloadBytes: UPLOAD_LIMITS.zip.maxTotalBytes, zip: UPLOAD_LIMITS.zip }
): Promise<LoadedInput> {
  if (!BRANCH_PATTERN.test(branch)) throw new LocalInputError('That branch name is not valid.');
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zipball/${branch.split('/').map(encodeURIComponent).join('/')}`;
  const res = await githubGet(url, token, fetchFn, 'application/vnd.github+json', DOWNLOAD_TIMEOUT_MS);
  if (!res.ok) throw explain(res, owner, repo, `Could not download the branch "${branch}"`);
  const zip = await readLimited(res, limits.maxDownloadBytes);
  try {
    const { files, skipped } = readZip(zip, limits.zip);
    return { files, notes: skipped.map((s) => `Skipped ${s.name} (${s.reason}).`) };
  } catch (err) {
    if (err instanceof ZipError) throw new LocalInputError(`The branch "${branch}" could not be read: ${err.message}`);
    throw err;
  }
}
