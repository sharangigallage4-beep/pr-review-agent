const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_PORT = 4500;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** True when running on a hosting service that fronts the app with its own HTTPS proxy. */
export function isHostedPlatform(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.RENDER || env.RAILWAY_ENVIRONMENT || env.FLY_APP_NAME);
}

/**
 * The address to listen on. PR_REVIEW_UI_HOST wins; on a hosting service the default is 0.0.0.0
 * (the service's proxy must be able to reach the app - on 127.0.0.1 it reports "no open ports"),
 * and everywhere else it is 127.0.0.1 so a normal install stays private to the machine.
 */
export function resolveHost(env: NodeJS.ProcessEnv): string {
  return env.PR_REVIEW_UI_HOST || (isHostedPlatform(env) ? '0.0.0.0' : '127.0.0.1');
}

/** Whether the login cookie gets the Secure flag: explicit setting first, else on for hosting services (they serve HTTPS). */
export function resolveCookieSecure(env: NodeJS.ProcessEnv): boolean {
  const explicit = (env.PR_REVIEW_UI_COOKIE_SECURE ?? '').trim().toLowerCase();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  return isHostedPlatform(env);
}

/** Number of proxies in front of the app: explicit setting first, else 1 on a hosting service, else none. */
export function resolveTrustProxy(env: NodeJS.ProcessEnv): number | string | undefined {
  const raw = (env.PR_REVIEW_UI_TRUST_PROXY ?? '').trim();
  if (raw === '') return isHostedPlatform(env) ? 1 : undefined;
  // "true"/"false" are not addresses (Express would crash on them at start-up): true means one proxy.
  if (/^true$/i.test(raw)) return 1;
  if (/^false$/i.test(raw)) return undefined;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
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
  const host = resolveHost(env);
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
