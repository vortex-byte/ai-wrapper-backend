import type { PasswordHasher } from '../ports/password-hasher.ts';

/**
 * argon2id via `Bun.password` (PRD §15.1). `memoryCost` is in KiB, so 65536 = 64 MiB —
 * the documented floor. `Bun.password.verify` is constant-time.
 */
const ARGON2_OPTIONS = {
  algorithm: 'argon2id',
  memoryCost: 65_536,
  timeCost: 3,
  hashLength: 32,
} as const;

export class BunPasswordHasher implements PasswordHasher {
  async hash(password: string): Promise<string> {
    return Bun.password.hash(password, ARGON2_OPTIONS);
  }

  async verify(password: string, hash: string): Promise<boolean> {
    try {
      return await Bun.password.verify(password, hash);
    } catch {
      // A malformed stored hash must not throw into the request path.
      return false;
    }
  }
}
