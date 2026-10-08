import { describe, expect, it } from 'vitest';
import { changePassword } from '../../../src/auth/application/change-password.ts';
import { AppError } from '../../../src/errors.ts';
import { createHarness, makeUser, type TestHarness } from './fakes.ts';

const meta = { ip: null, userAgentHash: null, requestId: 'req-2' };
const CORRECT = 'correct horse battery staple';
const NEW = 'a brand new passphrase';

async function expectAppError(fn: () => Promise<unknown>): Promise<AppError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected the call to reject');
}

async function seedCallerSession(harness: TestHarness, id = 'caller-session'): Promise<string> {
  const now = harness.clock.now();
  await harness.sessions.insert({
    id,
    userId: 'user-1',
    createdAt: now,
    lastSeenAt: now,
    expiresAt: new Date(now.getTime() + 8 * 60 * 60 * 1000),
    rotatedFrom: null,
    ip: null,
    userAgentHash: null,
  });
  return id;
}

describe('changePassword', () => {
  it('rejects a wrong current password and audits the failure', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser({ mustChangePassword: true }));
    const sessionId = await seedCallerSession(harness);

    await expect(
      changePassword(harness.deps, {
        userId: 'user-1',
        sessionId,
        currentPassword: 'not the password',
        newPassword: NEW,
        meta,
      }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });

    expect(harness.users.rows.get('user-1')?.passwordHash).toBe(`plain$${CORRECT}`);
    expect(harness.audit.actions()).toEqual(['password_change_failed']);
  });

  it('enforces the password policy', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser());
    const sessionId = await seedCallerSession(harness);

    const error = await expectAppError(() =>
      changePassword(harness.deps, {
        userId: 'user-1',
        sessionId,
        currentPassword: CORRECT,
        newPassword: 'short',
        meta,
      }),
    );

    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('12');
  });

  it('refuses a new password identical to the current one', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser());
    const sessionId = await seedCallerSession(harness);

    await expect(
      changePassword(harness.deps, {
        userId: 'user-1',
        sessionId,
        currentPassword: CORRECT,
        newPassword: CORRECT,
        meta,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rotates the caller session, revokes the others, clears the gate and audits', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser({ mustChangePassword: true }));
    const callerId = await seedCallerSession(harness);
    const otherId = await seedCallerSession(harness, 'other-session');

    const result = await changePassword(harness.deps, {
      userId: 'user-1',
      sessionId: callerId,
      currentPassword: CORRECT,
      newPassword: NEW,
      meta,
    });

    const user = harness.users.rows.get('user-1');
    expect(user?.passwordHash).toBe(`plain$${NEW}`);
    expect(user?.mustChangePassword).toBe(false);

    expect(harness.sessions.rows.get(callerId)?.revokedAt).not.toBeNull();
    expect(harness.sessions.rows.get(otherId)?.revokedAt).not.toBeNull();

    const rotated = harness.sessions.rows.get(result.sessionId);
    expect(rotated).toBeDefined();
    expect(rotated?.rotatedFrom).toBe(callerId);
    expect(rotated?.revokedAt).toBeNull();
    expect(result.token).toBeTruthy();
    expect(harness.audit.actions()).toEqual(['password_change']);
  });
});
