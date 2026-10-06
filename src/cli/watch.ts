#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../loadEnv.js';

/**
 * Local PR watcher: polls GitHub for open PRs and runs the automated review
 * (src/cli/autoReview.ts, which posts without asking) once per PR head commit. Needs no public
 * URL or tunnel - just this process running alongside Ollama. Reviewed `pr#sha` pairs are kept in
 * .watch-state.json so a restart never re-reviews. On the very first start existing open PRs are
 * only recorded, not reviewed, unless --include-existing is passed.
 */
const POLL_MS = Number(process.env.WATCH_INTERVAL_MS) || 60_000;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const statePath = path.join(root, '.watch-state.json');

interface OpenPr {
  number: number;
  headSha: string;
}

function loadState(): Set<string> | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    return new Set(JSON.parse(readFileSync(statePath, 'utf8')) as string[]);
  } catch {
    return undefined;
  }
}

function saveState(seen: Set<string>): void {
  writeFileSync(statePath, JSON.stringify([...seen], null, 2));
}

async function listOpenPrs(owner: string, repo: string, token: string): Promise<OpenPr[]> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=50`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status} listing pull requests`);
  const prs = (await res.json()) as Array<{ number: number; head: { sha: string } }>;
  return prs.map((pr) => ({ number: pr.number, headSha: pr.head.sha }));
}

function runReview(owner: string, repo: string, pr: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(root, 'src', 'cli', 'autoReview.ts'), `--owner=${owner}`, `--repo=${repo}`, `--pr=${pr}`],
      { cwd: root, stdio: 'inherit' }
    );
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  loadDotEnv();
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!token || !owner || !repo) {
    console.error('GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO must be set (see .env.example).');
    process.exitCode = 1;
    return;
  }

  let seen = loadState();
  const firstRun = seen === undefined;
  seen ??= new Set<string>();
  console.log(`Watching ${owner}/${repo} every ${POLL_MS / 1000}s. Press Ctrl+C to stop.`);

  while (true) {
    try {
      const prs = await listOpenPrs(owner, repo, token);
      if (firstRun && seen.size === 0 && !process.argv.includes('--include-existing')) {
        prs.forEach((pr) => seen.add(`${pr.number}#${pr.headSha}`));
        saveState(seen);
        console.log(`First start: recorded ${prs.length} existing open PR(s) without reviewing them.`);
      }
      for (const pr of prs) {
        const key = `${pr.number}#${pr.headSha}`;
        if (seen.has(key)) continue;
        console.log(`New PR activity: #${pr.number} (${pr.headSha.slice(0, 7)}) - reviewing...`);
        const ok = await runReview(owner, repo, pr.number);
        // Only remember successes, so a failure (e.g. Ollama not running) is retried next poll.
        if (ok) {
          seen.add(key);
          saveState(seen);
        }
      }
    } catch (error) {
      console.error(`Poll failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await sleep(POLL_MS);
  }
}

main();
