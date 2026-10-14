import { withRetry } from '../webhook/retry.js';
import { isTransientRead } from '../workflow/githubRetry.js';
import { listProviders, ollamaBaseUrl } from '../review/providers.js';
import type { ProviderId } from '../review/providers.js';
import type { AppStatus, PullRequestSummary } from './app.js';

const GITHUB_TIMEOUT_MS = 15_000;

const UNREACHABLE =
  'Could not reach GitHub. Check your internet connection (a DNS problem is the usual cause) and press the button again.';

/**
 * Lists open pull requests for a repo, newest activity first. A brief network failure (a DNS hiccup,
 * a dropped connection) or a temporary GitHub error is retried a few times before giving up, and a
 * lasting one is reported in plain words instead of the bare "fetch failed".
 */
export async function listOpenPullRequests(
  owner: string,
  repo: string,
  token: string,
  fetchFn: typeof fetch = fetch,
  retry: { delayMs?: number } = {}
): Promise<PullRequestSummary[]> {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=50`;
  let res: Response;
  try {
    res = await withRetry(
      async () => {
        const response = await fetchFn(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        });
        // Temporary GitHub errors are thrown so they are retried like a network failure.
        if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) {
          throw Object.assign(new Error(`GitHub returned ${response.status}`), { status: response.status });
        }
        return response;
      },
      { retries: 3, delayMs: retry.delayMs ?? 500, shouldRetry: isTransientRead }
    );
  } catch (err) {
    if (isTransientRead(err)) throw new Error(UNREACHABLE);
    throw err;
  }
  if (res.status === 404) throw new Error(`Repository ${owner}/${repo} was not found, or the token cannot see it.`);
  if (res.status === 401 || res.status === 403) {
    throw new Error('GitHub rejected the token (check GITHUB_TOKEN and its permissions).');
  }
  if (!res.ok) throw new Error(`GitHub returned ${res.status} while listing pull requests.`);

  const prs = (await res.json()) as Array<{
    number: number;
    title: string;
    user: { login: string } | null;
    head: { ref: string; sha: string };
    base: { ref: string };
    updated_at: string;
    html_url: string;
    draft?: boolean;
  }>;
  return prs.map((pr) => ({
    number: pr.number,
    title: pr.title,
    author: pr.user?.login ?? null,
    branch: pr.head.ref,
    baseBranch: pr.base.ref,
    updatedAt: pr.updated_at,
    url: pr.html_url,
    draft: pr.draft === true,
    headSha: pr.head.sha,
  }));
}

async function probeOllama(baseUrl: string, name: string | undefined, fetchFn: typeof fetch, github: AppStatus['github']): Promise<AppStatus> {
  try {
    const res = await fetchFn(`${baseUrl.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { github, model: { kind: 'ollama', baseUrl, name, reachable: false } };
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    const installedModels = (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
    const modelInstalled = name ? installedModels.some((m) => m === name || m === `${name}:latest`) : undefined;
    return { github, model: { kind: 'ollama', baseUrl, name, reachable: true, modelInstalled, installedModels } };
  } catch {
    return { github, model: { kind: 'ollama', baseUrl, name, reachable: false } };
  }
}

/**
 * Reports what the review will talk to: GitHub config, and the AI. With `providerId` (the one chosen in the
 * UI) that provider is described: Ollama is probed (is it up, is the chosen model pulled), Claude is not
 * (a probe would cost money) - only whether a key is configured. Without it (older callers), an
 * ANTHROPIC_BASE_URL in the environment means Ollama, otherwise the hosted Anthropic API.
 */
export async function readStatus(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch, providerId?: ProviderId): Promise<AppStatus> {
  const github: AppStatus['github'] = {
    configured: Boolean(env.GITHUB_TOKEN),
    owner: env.GITHUB_OWNER || undefined,
    repo: env.GITHUB_REPO || undefined,
  };

  if (providerId) {
    const info = listProviders(env).find((p) => p.id === providerId);
    if (providerId === 'claude') {
      return { github, model: { kind: 'anthropic', name: info?.model, reachable: info?.available ? undefined : false } };
    }
    return probeOllama(ollamaBaseUrl(env), info?.model, fetchFn, github);
  }

  const baseUrl = env.ANTHROPIC_BASE_URL || undefined;
  const name = env.ANTHROPIC_MODEL || undefined;
  if (!baseUrl) return { github, model: { kind: 'anthropic', name } };
  return probeOllama(baseUrl, name, fetchFn, github);
}
