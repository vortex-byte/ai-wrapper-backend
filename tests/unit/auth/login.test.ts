import { describe, expect, it } from 'vitest';
import { login } from '../../../src/auth/application/login.ts';
import { AppError } from '../../../src/errors.ts';
import { createHarness, makeUser } from './fakes.ts';

const meta = { ip: '10.0.0.1', userAgentHash: 'ua-hash', requestId: 'req-1' };
const CORRECT = 'correct horse battery staple';

async function expectUnauthenticated(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('unauthenticated');
    return appError;
  }
  throw new Error('expected the call to reject');
}

describe('login', () => {
  it('rejects an unknown email generically and writes no audit', async () => {
    const harness = createHarness();
    const error = await expectUnauthenticated(() =>
      login(harness.deps, { email: 'nobody@corp.example', password: 'whatever', meta }),
    );
    expect(error.message).toBe('Invalid email or password.');
    expect(harness.audit.entries).toHaveLength(0);
  });

  it('rejects a wrong password, counts the failure and audits it', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser({ failedLoginAttempts: 0 }));
    await expectUnauthenticated(() =>
      login(harness.deps, { email: 'ada@corp.example', password: 'wrong password', meta }),
    );
    expect(harness.users.rows.get('user-1')?.failedLoginAttempts).toBe(1);
    expect(harness.audit.actions()).toEqual(['failed_login']);
  });

  it('locks the account on the 8th consecutive failure', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser({ failedLoginAttempts: 7 }));
    await expectUnauthenticated(() =>
      login(harness.deps, { email: 'ada@corp.example', password: 'wrong password', meta }),
    );
    const user = harness.users.rows.get('user-1');
    expect(user?.failedLoginAttempts).toBe(8);
    expect(user?.lockedUntil?.toISOString()).toBe('2026-05-01T10:15:00.000Z');
    expect(harness.audit.entries[0]?.after).toEqual({ locked: true, attempts: 8 });
  });

  it('refuses a locked account even with the correct password', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser({ lockedUntil: new Date('2026-05-01T10:05:00Z') }));
    await expectUnauthenticated(() =>
      login(harness.deps, { email: 'ada@corp.example', password: CORRECT, meta }),
    );
    expect(harness.audit.entries[0]?.after).toEqual({ reason: 'locked' });
    expect(harness.sessions.rows.size).toBe(0);
  });

  it('refuses a disabled account', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser({ status: 'disabled' }));
    await expectUnauthenticated(() =>
      login(harness.deps, { email: 'ada@corp.example', password: CORRECT, meta }),
    );
    expect(harness.audit.entries[0]?.after).toEqual({ reason: 'disabled' });
  });

  it('is case-insensitive on the email (citext semantics)', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser());
    const result = await login(harness.deps, {
      email: 'ADA@Corp.Example',
      password: CORRECT,
      meta,
    });
    expect(result.user.id).toBe('user-1');
  });

  it('creates a session and resets the failure counter on success', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser({ failedLoginAttempts: 5 }));
    const result = await login(harness.deps, { email: 'ada@corp.example', password: CORRECT, meta });

    expect(result.token).toBeTruthy();
    expect(harness.sessions.rows.get(result.sessionId)).toBeDefined();
    expect(harness.users.rows.get('user-1')?.failedLoginAttempts).toBe(0);
    expect(harness.users.rows.get('user-1')?.lastLoginAt?.getTime()).toBe(harness.clock.now().getTime());
    expect(harness.audit.actions()).toEqual(['login']);
    // idle 480 min from now → 18:00Z
    expect(result.expiresAt.toISOString()).toBe('2026-05-01T18:00:00.000Z');
  });
});
