import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import { verifyGitHubSignature } from './verifySignature.js';
import { parsePullRequestEvent } from './parsePullRequestEvent.js';
import { processReviewEvent } from './processReviewEvent.js';
import { ReviewStatusStore } from './reviewStatusStore.js';
import { reviewPullRequest } from '../workflow/reviewPullRequestWorkflow.js';
import { consoleLogger, toSafeLogFields } from '../workflow/logger.js';
import type { WorkflowLogger } from '../workflow/logger.js';

export interface BuildWebhookAppOptions {
  webhookSecret: string;
  /** Injectable for tests - defaults to the real end-to-end review workflow. */
  runReview?: typeof reviewPullRequest;
  logger?: WorkflowLogger;
  statusStore?: ReviewStatusStore;
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Builds the (unstarted) Express app - `server.ts` is the only thing that calls `.listen()` on
 * it. Splitting these apart is what makes the app testable with a real ephemeral HTTP server in
 * app.test.ts, without needing GITHUB_TOKEN/ANTHROPIC_API_KEY or any other real config.
 */
export function buildWebhookApp(options: BuildWebhookAppOptions): Express {
  const log = options.logger ?? consoleLogger;
  const statusStore = options.statusStore ?? new ReviewStatusStore();
  const runReview = options.runReview ?? reviewPullRequest;

  const app = express();
  app.disable('x-powered-by');

  app.post(
    '/webhooks/github',
    // Raw bytes, not parsed JSON - see verifySignature.ts for why re-serialization would break
    // signature verification. GitHub's default webhook content type is application/json.
    express.raw({ type: 'application/json', limit: '5mb' }),
    (req: Request, res: Response) => {
      const deliveryId = req.header('x-github-delivery') ?? undefined;
      const eventName = req.header('x-github-event');
      const signature = req.header('x-hub-signature-256');
      const rawBody = req.body as unknown;

      if (!Buffer.isBuffer(rawBody)) {
        log.warn('Webhook request had no body', { deliveryId, eventName });
        res.status(400).json({ error: 'Missing request body.' });
        return;
      }

      if (!verifyGitHubSignature(rawBody, signature, options.webhookSecret)) {
        log.warn('Webhook signature verification failed - rejecting request', { deliveryId, eventName });
        res.status(401).json({ error: 'Invalid signature.' });
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString('utf8'));
      } catch {
        log.warn('Webhook payload was not valid JSON', { deliveryId, eventName });
        res.status(400).json({ error: 'Invalid JSON payload.' });
        return;
      }

      const parsed = parsePullRequestEvent(eventName, payload);

      if (!parsed.handled) {
        log.info('Ignoring webhook event', { deliveryId, eventName, reason: parsed.reason });
        res.status(200).json({ ignored: true, reason: parsed.reason });
        return;
      }

      // Return quickly: the actual review (a Claude API call plus several GitHub API calls) runs
      // AFTER the response is sent, so a slow review can never make GitHub's webhook delivery
      // time out and retry a request that already succeeded.
      res.status(202).json({ accepted: true, ...parsed.event });

      processReviewEvent(parsed.event, {
        runReview,
        statusStore,
        logger: log,
        retries: options.retries,
        retryDelayMs: options.retryDelayMs,
      }).catch((err: unknown) => {
        // processReviewEvent() catches everything internally and should never reject - this is a
        // last-resort net against a genuine bug in it, so that can never crash the process.
        log.error('Unexpected error processing webhook event', { deliveryId, ...toSafeLogFields(err) });
      });
    }
  );

  app.get('/webhooks/status', (_req: Request, res: Response) => {
    res.status(200).json(statusStore.list());
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found.' });
  });

  // Last-resort error handler (4-arg signature is what makes Express treat this as one) - never
  // echoes the caught error back to the client, only a generic message.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error('Unhandled error in webhook app', toSafeLogFields(err));
    res.status(500).json({ error: 'Internal server error.' });
  });

  return app;
}
