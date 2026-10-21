import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** 64 lowercase hex chars → fits `sessions.id char(64)`. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** User-agent is stored hashed — forensics without storing the raw header. */
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

const PASSWORD_CHARS = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
const PASSWORD_BLOCK_SIZE = 4;
const PASSWORD_BLOCKS = 3;

function uniformPasswordIndex(): number {
  const limit = 256 - (256 % PASSWORD_CHARS.length);
  for (;;) {
    const byte = randomBytes(1)[0];
    if (byte !== undefined && byte < limit) {
      return byte % PASSWORD_CHARS.length;
    }
  }
}

function getPasswordBlock(): string {
  let str = '';
  for (let i = 0; i < PASSWORD_BLOCK_SIZE; i++) {
    str += PASSWORD_CHARS[uniformPasswordIndex()];
  }
  return str;
}

export function generateTemporaryPassword(): string {
  return Array.from({ length: PASSWORD_BLOCKS }, getPasswordBlock).join('-');
}
