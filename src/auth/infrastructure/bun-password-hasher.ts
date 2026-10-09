import type { PasswordHasher } from '../ports/password-hasher.ts';

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
      return false;
    }
  }
}
