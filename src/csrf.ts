import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 12 h — at most the absolute session lifetime, usually far less. */
export const CSRF_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const NONCE_BYTES = 16;

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');
}

export interface CsrfTokenOptions {
  readonly now?: Date;
}

/** Mint a fresh token. Never throws for a valid secret. */
export function issueCsrfToken(secret: string, options: CsrfTokenOptions = {}): string {
  const issuedAt = (options.now ?? new Date()).getTime();
  const nonce = randomBytes(NONCE_BYTES).toString('base64url');
  const payload = `${nonce}:${issuedAt}`;
  return `${nonce}.${issuedAt}.${sign(secret, payload)}`;
}

export type CsrfVerifyFailure = 'malformed' | 'bad_signature' | 'expired';

export interface CsrfVerifyResult {
  readonly ok: boolean;
  readonly reason?: CsrfVerifyFailure;
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Verify a token's signature and age. Returns `{ok:false, reason}` for anything wrong
 * so callers (and tests) can distinguish a malformed token from an expired one.
 */
export function verifyCsrfToken(
  secret: string,
  token: string,
  options: CsrfTokenOptions = {},
): CsrfVerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [nonce, issuedAtRaw, signature] = parts as [string, string, string];
  if (nonce.length === 0 || signature.length === 0) return { ok: false, reason: 'malformed' };

  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || !Number.isInteger(issuedAt)) {
    return { ok: false, reason: 'malformed' };
  }

  const expected = sign(secret, `${nonce}:${issuedAt}`);
  if (!constantTimeEqual(signature, expected)) return { ok: false, reason: 'bad_signature' };

  const now = (options.now ?? new Date()).getTime();
  const age = now - issuedAt;
  
  if (age < -60_000) return { ok: false, reason: 'expired' };
  if (age > CSRF_TOKEN_MAX_AGE_MS) return { ok: false, reason: 'expired' };

  return { ok: true };
}
