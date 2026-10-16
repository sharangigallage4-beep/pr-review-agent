import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { JobManager } from './jobs.js';
import type { FeedbackVote } from './jobs.js';
import { SESSION_COOKIE, readCookie } from './auth.js';
import type { Auth } from './auth.js';
import type { AutoReviewer } from './autoReview.js';
import { LocalInputError, listLocalInputs, loadLocalInput } from './localInput.js';
import { UPLOAD_LIMITS, loadUpload } from './uploadInput.js';
import { runVersionReview } from './versionReview.js';
import { ProviderError } from '../review/providers.js';
import type { ProviderSettings } from './providerSettings.js';
import type { UsageSummary } from './usage.js';
import { ConventionError, deleteConventionDoc, listConventionDocs, saveConventionDoc } from './conventionsStore.js';

export interface PullRequestSummary {
  number: number;
  title: string;
  author: string | null;
  branch: string;
  baseBranch: string;
  updatedAt: string;
  url: string;
  draft: boolean;
  /** The commit the PR currently points at - a new commit means it needs a new review. */
  headSha: string;
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
  /** When set, every /api route except login needs a signed-in session. */
  auth?: Auth;
  /** Which AI (Ollama or Claude) new reviews use, with the UI's switch. */
  providers?: ProviderSettings;
  /** What Claude has been used for this month (tokens, estimated cost, cap), for the usage chip. */
  usage?: () => UsageSummary;
  /** Enables the "auto-review new PRs" switch. */
  auto?: AutoReviewer;
  /** The folder whose sub-folders and .zip files can be reviewed from the page (never any other path). */
  localInputDir?: string;
  /** Lets people choose files, a folder or a ZIP in the browser and have them reviewed. Default true. */
  uploads?: boolean;
  /** Injectable for tests - defaults to the real version comparison and review. */
  versionReview?: typeof runVersionReview;
  /**
   * Origins (e.g. "https://my-site.netlify.app") of a separate website that fronts this server and
   * forwards its /api calls here. Their requests carry that website's Origin and possibly its Host,
   * which would otherwise be refused; listing them here accepts exactly those and nothing else.
   */
  allowedOrigins?: string[];
  /**
   * Set this when the UI sits behind a reverse proxy (e.g. Caddy): the number of proxies in front of
   * it, or a subnet list. Express then reads the real client address from X-Forwarded-For, so the
   * login throttle counts each person separately instead of treating everyone as the proxy. Leave
   * it unset when there is no proxy - a client could otherwise fake the header.
   */
  trustProxy?: boolean | number | string;
  /** Folder of convention .md files (the one the reviewer loads). Enables the rules editor. */
  conventionsDir?: string;
}

const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const UPLOAD_PATH = '/api/local-uploads';
// Base64 makes the upload about a third bigger than the files themselves (both versions together must fit).
const UPLOAD_BODY_LIMIT = `${Math.ceil((UPLOAD_LIMITS.maxTotalBytes * 4) / 3 / 1024 / 1024) + 2}mb`;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const OPEN_API_PATHS = new Set(['/api/login', '/api/logout', '/api/session']);

function hostWithoutPort(host: string): string {
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
}

/**
 * Builds the (unstarted) Express app for the review web UI - `server.ts` is the only thing that
 * calls `.listen()`. Because this server can post comments to GitHub with the configured token, it
 * guards itself against other websites driving it from the user's own browser: the Host header is
 * allow-listed (DNS rebinding), cross-origin requests are rejected, and every write requires a JSON
 * body (which a plain cross-site form cannot send). With `auth` set, it also needs a login.
 */
export function buildUiApp(options: BuildUiAppOptions): Express {
  const { jobs, auth } = options;
  const allowedHosts = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const originHosts = new Set<string>();
  for (const origin of options.allowedOrigins ?? []) {
    try {
      originHosts.add(new URL(origin).host.toLowerCase());
    } catch {
      // an unparseable entry simply allows nothing
    }
  }

  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy !== undefined) app.set('trust proxy', options.trustProxy);

  // For a hosting service's health check: before the host and login checks, because the checker calls
  // the container directly (by its own address, without a password). It reveals nothing.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const host = (req.header('host') ?? '').toLowerCase();
    if (!LOCAL_HOSTS.has(hostWithoutPort(host)) && !allowedHosts.has(host) && !originHosts.has(host)) {
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
        if (originHost !== host && !originHosts.has(originHost)) {
          res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
          return;
        }
      }
      // Checked on the header itself: req.is() reports "no match" for a request with no body at all
      // (e.g. DELETE), and a cross-site form can never set this content type.
      if (!(req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        res.status(415).json({ error: 'Send a JSON body (Content-Type: application/json).' });
        return;
      }
    }
    next();
  });

  const smallJson = express.json({ limit: '100kb' });
  // The upload route reads a much bigger body, but only after the login check (see below).
  app.use((req: Request, res: Response, next: NextFunction) => (req.path === UPLOAD_PATH ? next() : smallJson(req, res, next)));

  const isSignedIn = (req: Request): boolean => !auth || auth.verifyToken(readCookie(req.header('cookie'), SESSION_COOKIE));

  app.get('/api/session', (req, res) => {
    res.json({ authRequired: Boolean(auth), authenticated: isSignedIn(req) });
  });

  app.post('/api/login', (req, res) => {
    if (!auth) {
      res.json({ ok: true });
      return;
    }
    const client = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    if (auth.isBlocked(client)) {
      res.status(429).json({ error: 'Too many wrong passwords. Wait a minute and try again.' });
      return;
    }
    const password = (req.body as { password?: unknown } | undefined)?.password;
    if (typeof password !== 'string' || !auth.checkPassword(password)) {
      auth.recordFailure(client);
      res.status(401).json({ error: 'Wrong password.' });
      return;
    }
    const secure = auth.secureCookie ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${auth.issueToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(auth.sessionMs / 1000)}${secure}`);
    res.json({ ok: true });
  });

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // Everything else under /api needs a session when a password is configured.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (OPEN_API_PATHS.has(req.baseUrl + req.path) || isSignedIn(req)) {
      next();
      return;
    }
    res.status(401).json({ error: 'Please sign in.' });
  });

  const parseRepoRef = (source: Record<string, unknown>): { owner: string; repo: string } | undefined => {
    const { owner, repo } = source;
    return typeof owner === 'string' && typeof repo === 'string' && NAME_PATTERN.test(owner) && NAME_PATTERN.test(repo)
      ? { owner, repo }
      : undefined;
  };

  const handle =
    (fn: (req: Request, res: Response) => Promise<void> | void) =>
    (req: Request, res: Response): void => {
      // Starting from a resolved promise also turns a synchronous throw into a rejection, so it is
      // handled here instead of reaching Express's default error page (which would show a stack trace).
      Promise.resolve().then(() => fn(req, res)).catch((err: unknown) => {
        if (res.headersSent) return;
        if (err instanceof ConventionError || err instanceof LocalInputError || err instanceof ProviderError) {
          res.status(400).json({ error: err.message });
          return;
        }
        // Never echo internals (a thrown error could carry request details) - the real reason is
        // logged by whatever threw it.
        res.status(500).json({ error: 'Something went wrong on the server.' });
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

  app.post('/api/jobs/:id/feedback', (req, res) => {
    const { index, vote } = (req.body ?? {}) as { index?: unknown; vote?: unknown };
    const validVote = vote === 'up' || vote === 'down' || vote === null;
    if (typeof index !== 'number' || !validVote) {
      res.status(400).json({ error: 'index must be a number and vote must be "up", "down" or null.' });
      return;
    }
    if (!jobs.setFeedback(req.params.id, index, vote as FeedbackVote | null)) {
      res.status(404).json({ error: 'No such review or finding.' });
      return;
    }
    res.json({ ok: true, summary: jobs.feedbackSummary() });
  });

  const localInputDir = options.localInputDir;
  const versionReview = options.versionReview ?? runVersionReview;

  app.get('/api/local-inputs', (_req, res) => {
    res.json(localInputDir ? { available: true, entries: listLocalInputs(localInputDir) } : { available: false, entries: [] });
  });

  app.post(
    '/api/local-reviews',
    handle((req, res) => {
      if (!localInputDir) {
        res.status(404).json({ error: 'Reviewing local folders is not available.' });
        return;
      }
      const { newName, oldName, useAi } = (req.body ?? {}) as Record<string, unknown>;
      if (typeof newName !== 'string' || (oldName !== undefined && oldName !== null && oldName !== '' && typeof oldName !== 'string')) {
        res.status(400).json({ error: 'Choose the new version (and optionally the old one).' });
        return;
      }
      const previous = typeof oldName === 'string' && oldName !== '' ? oldName : undefined;
      // Only names that are really entries of the local-input folder are accepted, checked now so
      // a bad choice is an immediate error rather than a failed job later.
      const known = new Set(listLocalInputs(localInputDir).map((e) => e.name));
      if (!known.has(newName) || (previous !== undefined && !known.has(previous))) {
        res.status(400).json({ error: 'Pick folders or ZIP files from the list.' });
        return;
      }
      if (previous === newName) {
        res.status(400).json({ error: 'The old and the new version are the same - pick two different ones.' });
        return;
      }
      const label = previous ? `${newName} (compared with ${previous})` : newName;
      const job = jobs.startLocal(label, async (log, context) => {
        log('Loading the files');
        const next = loadLocalInput(localInputDir, newName);
        const prev = previous ? loadLocalInput(localInputDir, previous) : undefined;
        return versionReview(
          { newFiles: next.files, oldFiles: prev?.files, label, useAi: useAi !== false, notes: [...next.notes, ...(prev?.notes ?? [])] },
          { log, ...(useAi !== false ? { review: context.reviewer() } : {}) }
        );
      });
      res.status(202).json(job);
    })
  );

  const uploadsEnabled = options.uploads !== false;
  const bigJson = express.json({ limit: UPLOAD_BODY_LIMIT });

  app.get('/api/uploads', (_req, res) => {
    res.json(uploadsEnabled ? { available: true, maxTotalBytes: UPLOAD_LIMITS.maxTotalBytes, maxFiles: UPLOAD_LIMITS.maxFiles } : { available: false });
  });

  app.post(
    UPLOAD_PATH,
    bigJson,
    handle((req, res) => {
      if (!uploadsEnabled) {
        res.status(404).json({ error: 'Uploading files for review is not available on this server.' });
        return;
      }
      const { newVersion, oldVersion, useAi, name } = (req.body ?? {}) as Record<string, unknown>;
      const next = loadUpload(newVersion, 'new version');
      const prev = oldVersion ? loadUpload(oldVersion, 'previous version') : undefined;
      const shownName = (typeof name === 'string' ? name : '').replace(/\p{Cc}/gu, ' ').trim().slice(0, 80) || 'Uploaded files';
      const label = prev ? `${shownName} (compared with the previous version)` : shownName;
      const ai = useAi !== false;
      const job = jobs.startLocal(label, async (log, context) => {
        log(`Reviewing ${next.files.size} uploaded file(s)`);
        return versionReview(
          { newFiles: next.files, oldFiles: prev?.files, label, useAi: ai, notes: [...next.notes, ...(prev?.notes ?? [])] },
          { log, ...(ai ? { review: context.reviewer() } : {}) }
        );
      });
      res.status(202).json(job);
    })
  );

  const providerState = () =>
    options.providers
      ? { available: true, selected: options.providers.get(), providers: options.providers.list() }
      : { available: false, selected: null, providers: [] };

  // Only names, models and whether each can be used - never a key.
  app.get('/api/usage', (_req, res) => {
    res.json(options.usage ? options.usage() : { available: false });
  });

  app.get('/api/provider', (_req, res) => {
    res.json(providerState());
  });

  app.post(
    '/api/provider',
    handle((req, res) => {
      if (!options.providers) {
        res.status(404).json({ error: 'Choosing the AI is not available on this server.' });
        return;
      }
      options.providers.set((req.body as { id?: unknown } | undefined)?.id);
      res.json(providerState());
    })
  );

  app.get('/api/feedback', (_req, res) => {
    res.json(jobs.feedbackSummary());
  });

  app.get('/api/auto', (_req, res) => {
    res.json(options.auto ? { available: true, ...options.auto.status() } : { available: false });
  });

  app.post('/api/auto', (req, res) => {
    if (!options.auto) {
      res.status(404).json({ error: 'Auto-review is not available.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const key of ['enabled', 'autoPost', 'owner', 'repo']) if (key in body) next[key] = body[key];
    const error = options.auto.configure(next);
    if (error) {
      res.status(400).json({ error });
      return;
    }
    res.json({ available: true, ...options.auto.status() });
  });

  const conventionsDir = options.conventionsDir;

  app.get(
    '/api/conventions',
    handle((_req, res) => {
      if (!conventionsDir) {
        res.status(404).json({ error: 'The rules editor is not available.' });
        return;
      }
      res.json({ docs: listConventionDocs(conventionsDir) });
    })
  );

  app.put(
    '/api/conventions/:name',
    handle((req, res) => {
      if (!conventionsDir) {
        res.status(404).json({ error: 'The rules editor is not available.' });
        return;
      }
      const content = (req.body as { content?: unknown } | undefined)?.content;
      if (typeof content !== 'string') {
        res.status(400).json({ error: 'content must be text.' });
        return;
      }
      res.json(saveConventionDoc(conventionsDir, String(req.params.name), content));
    })
  );

  app.delete(
    '/api/conventions/:name',
    handle((req, res) => {
      if (!conventionsDir) {
        res.status(404).json({ error: 'The rules editor is not available.' });
        return;
      }
      if (!deleteConventionDoc(conventionsDir, String(req.params.name))) {
        res.status(404).json({ error: 'No such document.' });
        return;
      }
      res.json({ ok: true });
    })
  );

  app.use(express.static(options.publicDir));

  return app;
}
