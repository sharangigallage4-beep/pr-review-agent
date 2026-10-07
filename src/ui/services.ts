import type { AppStatus, PullRequestSummary } from './app.js';

const GITHUB_TIMEOUT_MS = 15_000;

/** Lists open pull requests for a repo, newest activity first. */
export async function listOpenPullRequests(
  owner: string,
  repo: string,
  token: string,
  fetchFn: typeof fetch = fetch
): Promise<PullRequestSummary[]> {
  const res = await fetchFn(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=50`,
    {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    }
  );
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

/**
 * Reports what the review will talk to: GitHub config, and the model. When ANTHROPIC_BASE_URL is
 * set the model is treated as an Ollama server and probed (is it up, is the chosen model pulled);
 * otherwise it is the hosted Anthropic API, which is not probed.
 */
export async function readStatus(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch): Promise<AppStatus> {
  const github: AppStatus['github'] = {
    configured: Boolean(env.GITHUB_TOKEN),
    owner: env.GITHUB_OWNER || undefined,
    repo: env.GITHUB_REPO || undefined,
  };

  const baseUrl = env.ANTHROPIC_BASE_URL || undefined;
  const name = env.ANTHROPIC_MODEL || undefined;
  if (!baseUrl) return { github, model: { kind: 'anthropic', name } };

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
