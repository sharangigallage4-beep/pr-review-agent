const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_PORT = 4500;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * The port the UI listens on. PR_REVIEW_UI_PORT always wins. A hosting service (Render, Railway, ...)
 * tells the app which port to use in PORT, so that is used - but only when the UI is listening on a
 * non-loopback address, because a developer's .env commonly has an unrelated PORT (the webhook
 * server's) that must not move the local UI.
 */
export function resolvePort(env: NodeJS.ProcessEnv): number {
  const explicit = Number(env.PR_REVIEW_UI_PORT);
  if (explicit) return explicit;
  const host = env.PR_REVIEW_UI_HOST || '127.0.0.1';
  const fromPlatform = Number(env.PORT);
  if (fromPlatform && !isLoopbackHost(host)) return fromPlatform;
  return DEFAULT_PORT;
}

/**
 * Public host names hosting services announce through their own variables, so the UI accepts the
 * address people actually type without anyone having to copy it into PR_REVIEW_UI_ALLOWED_HOSTS
 * (which cannot be known before the service has been created).
 */
export function platformHosts(env: NodeJS.ProcessEnv): string[] {
  const hosts = [
    env.RENDER_EXTERNAL_HOSTNAME, // Render
    env.RAILWAY_PUBLIC_DOMAIN, // Railway
    env.FLY_APP_NAME ? `${env.FLY_APP_NAME}.fly.dev` : undefined, // Fly.io
  ];
  return hosts.map((h) => (h ?? '').trim()).filter(Boolean);
}
