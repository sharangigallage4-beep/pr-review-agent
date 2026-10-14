#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '../loadEnv.js';
import { defaultConventionsDir } from '../review/conventions.js';
import { buildUiApp } from './app.js';
import { createAuth } from './auth.js';
import { AutoReviewer } from './autoReview.js';
import { JobManager } from './jobs.js';
import { ProviderSettings } from './providerSettings.js';
import { resolveProvider, reviewerFor } from '../review/providers.js';
import { isLoopbackHost, platformHosts, resolveCookieSecure, resolveHost, resolvePort, resolveTrustProxy } from './hostConfig.js';
import { listenErrorMessage } from './listenError.js';
import { listOpenPullRequests, readStatus } from './services.js';

/**
 * Starts the review web UI (`npm run ui`). Listens on 127.0.0.1 only by default - the page can post
 * comments to GitHub with the configured token. To share it on a network set PR_REVIEW_UI_HOST,
 * PR_REVIEW_UI_ALLOWED_HOSTS and PR_REVIEW_UI_PASSWORD; the server refuses to listen on a
 * non-loopback address without a password, and you should still put it behind HTTPS.
 */
function main(): void {
  loadDotEnv();

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('GITHUB_TOKEN is not set - see .env.example. The UI needs it to read and review pull requests.');
    process.exitCode = 1;
    return;
  }

  const port = resolvePort(process.env);
  const host = resolveHost(process.env);
  const password = process.env.PR_REVIEW_UI_PASSWORD || '';
  if (!isLoopbackHost(host) && !password) {
    console.error(
      `Refusing to listen on ${host} without a password: anyone who can reach this page could post to GitHub with your token. ` +
        'Set PR_REVIEW_UI_PASSWORD (see .env.example), or leave PR_REVIEW_UI_HOST unset to keep it local.'
    );
    process.exitCode = 1;
    return;
  }
  // PR_REVIEW_UI_TRUST_PROXY=1 when exactly one reverse proxy (Caddy, nginx) is in front of the UI;
  // on a hosting service (Render, Railway, Fly.io) that is the default.
  const trustProxy = resolveTrustProxy(process.env);
  const allowedHosts = [
    ...(process.env.PR_REVIEW_UI_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    // A hosting service announces its public address itself (see hostConfig.ts).
    ...platformHosts(process.env),
  ];

  // Separate websites (a Netlify site) allowed to front this server, e.g. https://my-site.netlify.app
  const allowedOrigins = (process.env.PR_REVIEW_UI_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, '..', '..');
  // Where the review history and auto-review state are kept. Defaults to the project folder; a
  // container sets PR_REVIEW_DATA_DIR to a mounted volume so they survive the container being replaced.
  const dataDir = process.env.PR_REVIEW_DATA_DIR || root;
  const providers = new ProviderSettings(process.env, path.join(dataDir, '.ui-provider.json'));
  const jobs = new JobManager({
    historyFile: path.join(dataDir, '.review-history.json'),
    // Each review asks whichever AI is selected when it starts (the dropdown in the page).
    defaultProvider: () => providers.get(),
    reviewerFor: (id) => reviewerFor(resolveProvider(id, process.env)),
  });
  const listPullRequests = (owner: string, repo: string) => listOpenPullRequests(owner, repo, token);

  const app = buildUiApp({
    jobs,
    listPullRequests,
    getStatus: () => readStatus(process.env, fetch, providers.get()),
    providers,
    publicDir: path.join(here, 'public'),
    allowedHosts,
    allowedOrigins,
    trustProxy,
    auth: password ? createAuth({ password, cookieSecure: resolveCookieSecure(process.env) }) : undefined,
    auto: new AutoReviewer({ jobs, listPullRequests, stateFile: path.join(dataDir, '.ui-auto-state.json') }),
    conventionsDir: process.env.PR_REVIEW_CONVENTIONS_DIR || defaultConventionsDir(),
    localInputDir: process.env.PR_REVIEW_LOCAL_INPUT_DIR || path.join(root, 'local-input'),
  });

  app.listen(port, host, (error?: Error) => {
    // Express 5 reports a failed listen here instead of throwing; without this check a port Windows
    // had reserved made the server print "running" and then exit without a word.
    if (error) {
      console.error(listenErrorMessage(error, host, port));
      process.exitCode = 1;
      return;
    }
    console.log(`PR review UI running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}  (Ctrl+C to stop)`);
    if (password) console.log('Password protection is ON.');
  });
}

main();
