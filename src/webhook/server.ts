#!/usr/bin/env node
import { loadDotEnv } from '../loadEnv.js';
import { loadWebhookConfig } from './config.js';
import { buildWebhookApp } from './app.js';
import { consoleLogger } from '../workflow/logger.js';

function main(): void {
  loadDotEnv();

  // Fails fast if GITHUB_WEBHOOK_SECRET is missing, before opening a port - a webhook endpoint
  // that starts successfully but can never verify a real request is worse than one that refuses
  // to start at all.
  const { webhookSecret, port } = loadWebhookConfig();
  const app = buildWebhookApp({ webhookSecret, logger: consoleLogger });

  app.listen(port, () => {
    // Confirms a secret was loaded without ever printing it.
    consoleLogger.info(`GitHub webhook server listening on port ${port}`, { webhookSecretConfigured: true });
  });
}

main();
