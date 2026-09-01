import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Verifies a GitHub webhook's `X-Hub-Signature-256` header against the raw request body.
 *
 * `payload` MUST be the exact raw bytes GitHub sent, as a Buffer - re-serializing a parsed JSON
 * object can change key order or whitespace and silently produce a different byte sequence than
 * what GitHub actually signed, which would make a genuine webhook fail verification. The Express
 * route (`app.ts`) is responsible for capturing the raw body (via `express.raw()`) before any
 * JSON parsing happens.
 *
 * Uses `timingSafeEqual` rather than `===` so a byte-by-byte comparison can't leak how many
 * leading bytes matched through response-time differences - the whole point of HMAC
 * verification is defeated if the comparison itself is exploitable.
 */
export function verifyGitHubSignature(payload: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) return false;

  const expectedHex = createHmac('sha256', secret).update(payload).digest('hex');
  const expected = Buffer.from(expectedHex, 'utf8');
  const actual = Buffer.from(signatureHeader.slice(SIGNATURE_PREFIX.length), 'utf8');

  // timingSafeEqual throws on mismatched lengths rather than returning false - checking the
  // length first and returning false is not itself a timing leak, since the signature's length
  // isn't a secret (it's always a fixed-size hex digest for a given algorithm).
  if (expected.length !== actual.length) return false;

  return timingSafeEqual(expected, actual);
}
