import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Cryptographic helpers used by more than one layer (platform module, AGENTS §3.7 —
 * importable by `http/`, `application/` and `infrastructure/`; never by `domain/`).
 *
 * Sessions: the cookie carries an opaque random value; the database stores only
 * `sha256(value)` (PRD §15.1), so a database leak does not yield usable sessions.
 */

const TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** 64 lowercase hex chars → fits `sessions.id char(64)`. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** User-agent is stored hashed — forensics without storing the raw header (PRD §15.1). */
export function hashUserAgent(userAgent: string | undefined | null): string | null {
  if (userAgent === undefined || userAgent === null || userAgent === '') return null;
  return createHash('sha256').update(userAgent, 'utf8').digest('hex');
}

/** Constant-time equality for equal-length secrets. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
