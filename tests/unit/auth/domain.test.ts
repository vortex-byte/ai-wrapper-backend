import { describe, expect, it } from 'vitest';
import {
  computeExpiry,
  isSessionExpired,
  shouldTouch,
  TOUCH_THROTTLE_MS,
} from '@/auth/domain/session.ts';
import { passwordProblemMessage, validatePassword } from '@/auth/domain/password-policy.ts';
import {
  authenticationBlock,
  hasRole,
  isActive,
  isLocked,
  nextFailureState,
} from '@/auth/domain/user.ts';

const t = (iso: string): Date => new Date(iso);

describe('user domain', () => {
  it('treats a future lockedUntil as locked', () => {
    expect(isLocked({ lockedUntil: t('2026-05-01T10:10:00Z') }, t('2026-05-01T10:00:00Z'))).toBe(true);
    expect(isLocked({ lockedUntil: t('2026-05-01T09:59:00Z') }, t('2026-05-01T10:00:00Z'))).toBe(false);
    expect(isLocked({ lockedUntil: null }, t('2026-05-01T10:00:00Z'))).toBe(false);
  });

  it('is active only when status is active and not soft-deleted', () => {
    expect(isActive({ status: 'active', deletedAt: null })).toBe(true);
    expect(isActive({ status: 'disabled', deletedAt: null })).toBe(false);
    expect(isActive({ status: 'active', deletedAt: t('2026-01-01T00:00:00Z') })).toBe(false);
  });

  it('reports the authentication block reason', () => {
    expect(authenticationBlock({ status: 'active', deletedAt: null, lockedUntil: null }, t('2026-05-01T10:00:00Z'))).toBeNull();
    expect(
      authenticationBlock({ status: 'disabled', deletedAt: null, lockedUntil: null }, t('2026-05-01T10:00:00Z')),
    ).toBe('disabled');
    expect(
      authenticationBlock(
        { status: 'active', deletedAt: null, lockedUntil: t('2026-05-01T10:05:00Z') },
        t('2026-05-01T10:00:00Z'),
      ),
    ).toBe('locked');
  });

  it('locks exactly on the threshold failure', () => {
    const policy = { maxFailures: 8, lockoutMinutes: 15 };
    const now = t('2026-05-01T10:00:00Z');
    expect(nextFailureState(6, policy, now)).toEqual({
      failedLoginAttempts: 7,
      lockedUntil: null,
      lockedNow: false,
    });
    const locked = nextFailureState(7, policy, now);
    expect(locked.failedLoginAttempts).toBe(8);
    expect(locked.lockedNow).toBe(true);
    expect(locked.lockedUntil?.toISOString()).toBe('2026-05-01T10:15:00.000Z');
  });

  it('checks roles', () => {
    expect(hasRole({ role: 'admin' }, 'admin')).toBe(true);
    expect(hasRole({ role: 'user' }, 'admin')).toBe(false);
    expect(hasRole({ role: 'admin' }, 'admin', 'user')).toBe(true);
  });
});

describe('session domain', () => {
  it('takes the earlier of the idle and absolute windows', () => {
    const created = t('2026-05-01T00:00:00Z');
    const policy = { idleMinutes: 480, absoluteMinutes: 1440 };
    expect(computeExpiry(created, t('2026-05-01T00:00:00Z'), policy).toISOString()).toBe(
      '2026-05-01T08:00:00.000Z',
    );
    expect(computeExpiry(created, t('2026-05-01T20:00:00Z'), policy).toISOString()).toBe(
      '2026-05-02T00:00:00.000Z',
    );
  });

  it('treats revoked or past-expiry sessions as expired', () => {
    const now = t('2026-05-01T10:00:00Z');
    expect(isSessionExpired({ expiresAt: t('2026-05-01T09:00:00Z'), revokedAt: null }, now)).toBe(true);
    expect(isSessionExpired({ expiresAt: t('2026-05-01T11:00:00Z'), revokedAt: null }, now)).toBe(false);
    expect(
      isSessionExpired({ expiresAt: t('2026-05-01T11:00:00Z'), revokedAt: now }, now),
    ).toBe(true);
  });

  it('throttles last-seen writes to once per minute', () => {
    const now = t('2026-05-01T10:00:00Z');
    expect(shouldTouch({ lastSeenAt: new Date(now.getTime() - TOUCH_THROTTLE_MS + 1) }, now)).toBe(false);
    expect(shouldTouch({ lastSeenAt: new Date(now.getTime() - TOUCH_THROTTLE_MS) }, now)).toBe(true);
  });
});

describe('password policy', () => {
  it('rejects short passwords and explains why', () => {
    expect(validatePassword('short', { minLength: 12 })).toBe('too_short');
    expect(passwordProblemMessage('too_short', { minLength: 12 })).toContain('12');
  });

  it('accepts a password at the minimum length', () => {
    expect(validatePassword('twelve chars', { minLength: 12 })).toBeNull();
  });

  it('rejects absurdly long passwords', () => {
    expect(validatePassword('x'.repeat(2000), { minLength: 12 })).toBe('too_long');
  });
});
