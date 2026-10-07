import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'pr_review_session';

export interface AuthOptions {
  /** The shared password people type on the login page. */
  password: string;
  /** Signs session cookies. Defaults to a fresh random value, so sessions end when the server restarts. */
  sessionSecret?: Buffer;
  /** How long a login lasts. Default 12 hours. */
  sessionMs?: number;
  /** Add the Secure flag to the cookie - set this when the UI is served over HTTPS (e.g. behind a proxy). */
  cookieSecure?: boolean;
  /** Failed logins allowed per client per minute before being blocked. Default 5. */
  maxFailuresPerMinute?: number;
}

export interface Auth {
  readonly secureCookie: boolean;
  readonly sessionMs: number;
  checkPassword(candidate: string): boolean;
  issueToken(now?: number): string;
  verifyToken(token: string | undefined, now?: number): boolean;
  /** True when this client has used up its failed-login allowance. */
  isBlocked(clientId: string, now?: number): boolean;
  recordFailure(clientId: string, now?: number): void;
}

function sign(secret: Buffer, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAuth(options: AuthOptions): Auth {
  const secret = options.sessionSecret ?? randomBytes(32);
  const sessionMs = options.sessionMs ?? 12 * 60 * 60_000;
  const maxFailures = options.maxFailuresPerMinute ?? 5;
  const failures = new Map<string, number[]>();

  // Hash both sides first so the comparison takes the same time whatever the lengths are.
  const digest = (value: string) => createHmac('sha256', secret).update(value).digest('base64url');
  const expected = digest(options.password);

  const recent = (clientId: string, now: number): number[] => {
    const kept = (failures.get(clientId) ?? []).filter((t) => now - t < 60_000);
    failures.set(clientId, kept);
    return kept;
  };

  return {
    secureCookie: options.cookieSecure === true,
    sessionMs,
    checkPassword: (candidate) => safeEqual(digest(candidate), expected),
    issueToken: (now = Date.now()) => {
      const payload = String(now + sessionMs);
      return `${payload}.${sign(secret, payload)}`;
    },
    verifyToken: (token, now = Date.now()) => {
      if (!token) return false;
      const [payload, signature] = token.split('.');
      if (!payload || !signature || !safeEqual(signature, sign(secret, payload))) return false;
      return Number(payload) > now;
    },
    isBlocked: (clientId, now = Date.now()) => recent(clientId, now).length >= maxFailures,
    recordFailure: (clientId, now = Date.now()) => {
      recent(clientId, now).push(now);
    },
  };
}

/** Reads one cookie out of a Cookie header (no cookie-parser dependency needed for this). */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}
