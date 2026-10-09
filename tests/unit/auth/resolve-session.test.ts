import { describe, expect, it } from 'vitest';
import { resolveSession } from '@/auth/application/resolve-session.ts';
import { computeExpiry } from '@/auth/domain/session.ts';
import { hashSessionToken } from '@/crypto.ts';
import { createHarness, makeUser, type TestHarness } from './fakes.ts';

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

/** Seed a session keyed by the real hash of `token`, so `resolveSession(token)` finds it. */
async function seedSessionForToken(
  harness: TestHarness,
  token: string,
  options: { expiresAt?: Date; lastSeenAt?: Date; createdAt?: Date; revokedAt?: Date } = {},
): Promise<string> {
  const now = harness.clock.now();
  const id = hashSessionToken(token);
  await harness.sessions.insert({
    id,
    userId: 'user-1',
    createdAt: options.createdAt ?? new Date(now.getTime() - 60_000),
    lastSeenAt: options.lastSeenAt ?? now,
    expiresAt: options.expiresAt ?? new Date(now.getTime() + EIGHT_HOURS_MS),
    rotatedFrom: null,
    ip: null,
    userAgentHash: null,
  });
  if (options.revokedAt) {
    await harness.sessions.revoke(id, options.revokedAt);
  }
  return id;
}

describe('resolveSession', () => {
  it('returns the user and session for a valid token', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser());
    const id = await seedSessionForToken(harness, 'valid-token');

    const resolved = await resolveSession(harness.deps, 'valid-token');
    expect(resolved).not.toBeNull();
    expect(resolved?.user.id).toBe('user-1');
    expect(resolved?.session.id).toBe(id);
  });

  it('returns null for an unknown token', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser());
    expect(await resolveSession(harness.deps, 'never-issued')).toBeNull();
  });

  it('returns null for an expired session without revoking it', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser());
    const id = await seedSessionForToken(harness, 'expired-token', {
      expiresAt: new Date('2026-05-01T09:00:00Z'),
    });

    expect(await resolveSession(harness.deps, 'expired-token')).toBeNull();
    expect(harness.sessions.rows.get(id)?.revokedAt).toBeNull();
  });

  it('returns null for a revoked session', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser());
    await seedSessionForToken(harness, 'revoked-token', {
      revokedAt: new Date('2026-05-01T09:30:00Z'),
    });
    expect(await resolveSession(harness.deps, 'revoked-token')).toBeNull();
  });

  it('revokes and rejects the session of a disabled user', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser({ status: 'disabled' }));
    const id = await seedSessionForToken(harness, 'disabled-user-token');

    expect(await resolveSession(harness.deps, 'disabled-user-token')).toBeNull();
    expect(harness.sessions.rows.get(id)?.revokedAt).not.toBeNull();
  });

  it('touches a stale session and slides the idle window', async () => {
    const harness = createHarness();
    harness.users.seed(makeUser());
    const now = harness.clock.now();
    const createdAt = new Date(now.getTime() - 60_000);
    const id = await seedSessionForToken(harness, 'stale-token', {
      createdAt,
      lastSeenAt: new Date(now.getTime() - 120_000),
    });

    const resolved = await resolveSession(harness.deps, 'stale-token');
    expect(resolved).not.toBeNull();

    const stored = harness.sessions.rows.get(id);
    expect(stored?.lastSeenAt.getTime()).toBe(now.getTime());
    expect(stored?.expiresAt.getTime()).toBe(
      computeExpiry(createdAt, now, harness.deps.sessionPolicy).getTime(),
    );
    // idle (8h) is earlier than the absolute (24h) window → 18:00Z
    expect(stored?.expiresAt.toISOString()).toBe('2026-05-01T18:00:00.000Z');
  });
});
