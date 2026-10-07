#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../loadEnv.js';
import { buildUiApp } from './app.js';
import { JobManager } from './jobs.js';
import { listOpenPullRequests, readStatus } from './services.js';

/**
 * Starts the review web UI (`npm run ui`). Listens on 127.0.0.1 only by default - the page can post
 * comments to GitHub with the configured token, so it is a local tool unless you deliberately
 * change PR_REVIEW_UI_HOST (and then set PR_REVIEW_UI_ALLOWED_HOSTS and put it behind your own
 * authentication, e.g. a reverse proxy - the app has no login of its own).
 */
function main(): void {
  loadDotEnv();

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('GITHUB_TOKEN is not set - see .env.example. The UI needs it to read and review pull requests.');
    process.exitCode = 1;
    return;
  }

  const port = Number(process.env.PR_REVIEW_UI_PORT) || 4500;
  const host = process.env.PR_REVIEW_UI_HOST || '127.0.0.1';
  const allowedHosts = (process.env.PR_REVIEW_UI_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  const app = buildUiApp({
    jobs: new JobManager(),
    listPullRequests: (owner, repo) => listOpenPullRequests(owner, repo, token),
    getStatus: () => readStatus(process.env),
    publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'),
    allowedHosts,
  });

  app.listen(port, host, () => {
    console.log(`PR review UI running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}  (Ctrl+C to stop)`);
  });
}

main();
