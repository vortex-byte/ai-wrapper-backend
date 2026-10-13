import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuthService, type AuthService } from '@/auth/application/auth-service.ts';
import { BunPasswordHasher } from '@/auth/infrastructure/bun-password-hasher.ts';
import { DrizzleSessionRepository } from '@/auth/infrastructure/drizzle-session-repository.ts';
import { DrizzleUserRepository } from '@/auth/infrastructure/drizzle-user-repository.ts';
import { DrizzleAuditLogRepository } from '@/audit/infrastructure/drizzle-audit-log-repository.ts';
import { systemClock } from '@/clock/index.ts';
import { closePool, getPool } from '@/db/index.ts';
import { hashSessionToken } from '@/crypto.ts';
import type { UserRole } from '@/auth/domain/user.ts';
import { resetDatabase } from './helpers/reset.ts';

const users = new DrizzleUserRepository();
const sessions = new DrizzleSessionRepository();
const audit = new DrizzleAuditLogRepository();
const hasher = new BunPasswordHasher();
const auth: AuthService = createAuthService({
  users,
  sessions,
  hasher,
  audit,
  clock: systemClock,
  lockout: { maxFailures: 8, lockoutMinutes: 15 },
  sessionPolicy: { idleMinutes: 480, absoluteMinutes: 1440 },
  passwordPolicy: { minLength: 12 },
});

const meta = { ip: '10.0.0.1', userAgentHash: null, requestId: 'req-int' };
const PASSWORD = 'correct horse battery staple';

async function seedUser(options: { email?: string; role?: UserRole; mustChangePassword?: boolean; password?: string } = {}) {
  const password = options.password ?? PASSWORD;
  const user = await users.create({
    id: Bun.randomUUIDv7(),
    email: options.email ?? 'ada@corp.example',
    displayName: 'Ada L.',
    passwordHash: await hasher.hash(password),
    role: options.role ?? 'user',
    mustChangePassword: options.mustChangePassword ?? false,
  });
  return { user, password };
}

async function auditActions(): Promise<string[]> {
  const { rows } = await getPool().query<{ action: string }>(
    'SELECT action FROM audit_logs ORDER BY id',
  );
  return rows.map((row) => row.action);
}

async function expectUnauthenticated(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message?: string }> {
  try {
    await fn();
  } catch (error) {
    return error as { code?: string; message?: string };
  }
  throw new Error('expected the call to reject');
}

describe('auth (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('hashes with argon2id and verifies the round-trip', async () => {
    const hash = await hasher.hash(PASSWORD);
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await hasher.verify(PASSWORD, hash)).toBe(true);
    expect(await hasher.verify('wrong', hash)).toBe(false);
  });

  it('logs in, stores a hashed session and resets lockout state', async () => {
    const { user } = await seedUser();
    const result = await auth.login({ email: 'ada@corp.example', password: PASSWORD, meta });

    expect(result.user.id).toBe(user.id);
    expect(result.sessionId).toBe(hashSessionToken(result.token));

    const stored = await sessions.findById(result.sessionId);
    expect(stored).not.toBeNull();
    expect(stored?.revokedAt).toBeNull();

    const refreshed = await users.findById(user.id);
    expect(refreshed?.failedLoginAttempts).toBe(0);
    expect(refreshed?.lastLoginAt).not.toBeNull();

    expect(await auditActions()).toEqual(['login']);
  });

  it('rejects a wrong password generically and counts the failure', async () => {
    await seedUser();
    await expect(
      auth.login({ email: 'ada@corp.example', password: 'nope-nope-nope', meta }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });

    const { rows } = await getPool().query<{ failed_login_attempts: number; locked_until: string | null }>(
      'SELECT failed_login_attempts, locked_until FROM users WHERE email = $1',
      ['ada@corp.example'],
    );
    expect(rows[0]?.failed_login_attempts).toBe(1);
    expect(rows[0]?.locked_until).toBeNull();
    expect(await auditActions()).toEqual(['failed_login']);
  });

  it('locks the account after 8 consecutive failures', async () => {
    await seedUser();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(
        auth.login({ email: 'ada@corp.example', password: 'wrong-password', meta }),
      ).rejects.toMatchObject({ code: 'unauthenticated' });
    }

    const { rows } = await getPool().query<{ failed_login_attempts: number; locked_until: string | null }>(
      'SELECT failed_login_attempts, locked_until FROM users WHERE email = $1',
      ['ada@corp.example'],
    );
    expect(rows[0]?.failed_login_attempts).toBe(8);
    expect(rows[0]?.locked_until).not.toBeNull();

    await expect(
      auth.login({ email: 'ada@corp.example', password: PASSWORD, meta }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('resolves a valid session and revokes the session of a disabled user', async () => {
    const { user } = await seedUser();
    const { token } = await auth.login({ email: 'ada@corp.example', password: PASSWORD, meta });

    const resolved = await auth.resolveSession(token);
    expect(resolved?.user.id).toBe(user.id);

    await getPool().query('UPDATE users SET status = $1 WHERE id = $2', ['disabled', user.id]);

    expect(await auth.resolveSession(token)).toBeNull();
    const stored = await sessions.findById(hashSessionToken(token));
    expect(stored?.revokedAt).not.toBeNull();
  });

  it('changes the password: rotates the caller session and revokes the others', async () => {
    const { user } = await seedUser({ mustChangePassword: true });
    const first = await auth.login({ email: 'ada@corp.example', password: PASSWORD, meta });
    const second = await auth.login({ email: 'ada@corp.example', password: PASSWORD, meta });

    const result = await auth.changePassword({
      userId: user.id,
      sessionId: first.sessionId,
      currentPassword: PASSWORD,
      newPassword: 'a brand new passphrase',
      meta,
    });

    const refreshed = await users.findById(user.id);
    expect(refreshed?.mustChangePassword).toBe(false);
    expect(await hasher.verify('a brand new passphrase', refreshed?.passwordHash ?? '')).toBe(true);

    expect((await sessions.findById(first.sessionId))?.revokedAt).not.toBeNull();
    expect((await sessions.findById(second.sessionId))?.revokedAt).not.toBeNull();
    const rotated = await sessions.findById(result.sessionId);
    expect(rotated?.revokedAt).toBeNull();
    expect(rotated?.rotatedFrom).toBe(first.sessionId);

    await expect(
      auth.login({ email: 'ada@corp.example', password: PASSWORD, meta }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });

    expect(await auditActions()).toContain('password_change');
  });

  it('rejects an unknown email without writing an audit row', async () => {
    const error = await expectUnauthenticated(() =>
      auth.login({ email: 'ghost@corp.example', password: PASSWORD, meta }),
    );
    expect(error.message).toBe('Invalid email or password.');
    expect(await auditActions()).toEqual([]);
  });
});
