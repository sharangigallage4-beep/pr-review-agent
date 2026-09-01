// Deliberately separate from ../config.ts (GitHub) and ../review/config.ts (Anthropic) - same
// pattern as the rest of this codebase: each subsystem validates only the env vars it actually
// needs, so none of them can accidentally depend on the others being configured.

export interface WebhookConfig {
  webhookSecret: string;
  port: number;
}

const DEFAULT_PORT = 4300;

/**
 * Loads and validates the webhook server's own config. Throws if GITHUB_WEBHOOK_SECRET is
 * missing, so the server fails fast at startup rather than accepting requests it can never
 * actually verify.
 */
export function loadWebhookConfig(): WebhookConfig {
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    throw new Error(
      'Missing required environment variable: GITHUB_WEBHOOK_SECRET. See .env.example for what it is for.'
    );
  }

  const portRaw = process.env.PORT;
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`PORT must be a positive integer, got "${portRaw}".`);
  }

  return { webhookSecret, port };
}
