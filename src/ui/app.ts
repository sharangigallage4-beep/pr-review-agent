import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { JobManager } from './jobs.js';

export interface PullRequestSummary {
  number: number;
  title: string;
  author: string | null;
  branch: string;
  baseBranch: string;
  updatedAt: string;
  url: string;
  draft: boolean;
}

export interface AppStatus {
  github: { configured: boolean; owner?: string; repo?: string };
  model: {
    /** 'ollama' when ANTHROPIC_BASE_URL points at a local/self-hosted server, else 'anthropic'. */
    kind: 'ollama' | 'anthropic';
    baseUrl?: string;
    name?: string;
    /** Only checked for Ollama; undefined means "not checked". */
    reachable?: boolean;
    modelInstalled?: boolean;
    installedModels?: string[];
  };
}

export interface BuildUiAppOptions {
  jobs: JobManager;
  listPullRequests: (owner: string, repo: string) => Promise<PullRequestSummary[]>;
  getStatus: () => Promise<AppStatus>;
  /** Folder with index.html and its assets. */
  publicDir: string;
  /**
   * Extra Host header values to accept besides localhost / 127.0.0.1 / [::1] (e.g. "reviews.corp:4500"
   * when the UI is deliberately shared on a network). Leave empty for a purely local tool.
   */
  allowedHosts?: string[];
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostWithoutPort(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
}

/**
 * Builds the (unstarted) Express app for the review web UI - `server.ts` is the only thing that
 * calls `.listen()`. Because this server can post comments to GitHub with the configured token, it
 * guards itself against other websites driving it from the user's own browser: the Host header is
 * allow-listed (DNS rebinding), cross-origin requests are rejected, and every write requires a JSON
 * body (which a plain cross-site form cannot send).
 */
export function buildUiApp(options: BuildUiAppOptions): Express {
  const { jobs } = options;
  const allowedHosts = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()));

  const app = express();
  app.disable('x-powered-by');

  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = (req.header('host') ?? '').toLowerCase();
    if (!LOCAL_HOSTS.has(hostWithoutPort(host)) && !allowedHosts.has(host)) {
      res.status(403).json({ error: 'This host name is not allowed.' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.header('origin');
      if (origin) {
        let originHost = '';
        try {
          originHost = new URL(origin).host.toLowerCase();
        } catch {
          // fall through - an unparseable Origin is rejected below
        }
        if (originHost !== host) {
          res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
          return;
        }
      }
      if (!req.is('application/json')) {
        res.status(415).json({ error: 'Send a JSON body (Content-Type: application/json).' });
        return;
      }
    }
    next();
  });

  app.use(express.json({ limit: '10kb' }));

  const parseRepoRef = (source: Record<string, unknown>): { owner: string; repo: string } | undefined => {
    const { owner, repo } = source;
    return typeof owner === 'string' && typeof repo === 'string' && NAME_PATTERN.test(owner) && NAME_PATTERN.test(repo)
      ? { owner, repo }
      : undefined;
  };

  const handle =
    (fn: (req: Request, res: Response) => Promise<void> | void) =>
    (req: Request, res: Response): void => {
      Promise.resolve(fn(req, res)).catch(() => {
        // Never echo internals (a thrown error could carry request details) - the real reason is
        // logged by whatever threw it.
        if (!res.headersSent) res.status(500).json({ error: 'Something went wrong on the server.' });
      });
    };

  app.get(
    '/api/status',
    handle(async (_req, res) => {
      res.json(await options.getStatus());
    })
  );

  app.get(
    '/api/prs',
    handle(async (req, res) => {
      const ref = parseRepoRef(req.query);
      if (!ref) {
        res.status(400).json({ error: 'owner and repo are required and may only contain letters, digits, ".", "_" and "-".' });
        return;
      }
      try {
        res.json({ ...ref, pullRequests: await options.listPullRequests(ref.owner, ref.repo) });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Could not list pull requests.';
        res.status(502).json({ error: message });
      }
    })
  );

  app.get('/api/jobs', (_req, res) => {
    res.json({ jobs: jobs.list() });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'No such review.' });
      return;
    }
    res.json(job);
  });

  app.post('/api/jobs', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ref = parseRepoRef(body);
    const pr = body.pr;
    if (!ref || typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0) {
      res.status(400).json({ error: 'owner, repo and a positive integer pr are required.' });
      return;
    }
    const job = jobs.start(ref.owner, ref.repo, pr, body.autoPost === true);
    res.status(202).json(job);
  });

  app.post('/api/jobs/:id/confirm', (req, res) => {
    const post = (req.body as { post?: unknown } | undefined)?.post;
    if (typeof post !== 'boolean') {
      res.status(400).json({ error: '"post" must be true or false.' });
      return;
    }
    if (!jobs.confirm(req.params.id, post)) {
      res.status(409).json({ error: 'This review is not waiting for a decision.' });
      return;
    }
    res.json({ ok: true });
  });

  app.use(express.static(options.publicDir));

  return app;
}
