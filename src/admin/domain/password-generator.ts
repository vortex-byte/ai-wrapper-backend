import { randomBytes } from 'node:crypto';

const CHARS = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
const BLOCK_SIZE = 4;
const BLOCKS = 3;

/**
 * Uniform random index in `[0, CHARS.length)` with no modulo bias: bytes at or above the
 * largest multiple of the alphabet size are rejected and re-drawn.
 */
function uniformIndex(): number {
  const limit = 256 - (256 % CHARS.length);
  for (;;) {
    const byte = randomBytes(1)[0];
    if (byte !== undefined && byte < limit) {
      return byte % CHARS.length;
    }
  }
}

function getBlock(): string {
  let str = '';
  for (let i = 0; i < BLOCK_SIZE; i++) {
    str += CHARS[uniformIndex()];
  }
  return str;
}

/**
 * Generates a readable, secure random temporary password.
 * Format: 3 blocks of 4 alphanumeric chars joined by hyphens, e.g. "kX9a-7mP2-vQ4w".
 */
export function generateTemporaryPassword(): string {
  return Array.from({ length: BLOCKS }, getBlock).join('-');
}
