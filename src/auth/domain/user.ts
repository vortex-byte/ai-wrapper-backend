/**
 * Pure user rules (AGENTS §3.3: real logic lives in `domain`, not in services).
 * No I/O, no Drizzle, no framework — see the `domain-is-pure` dependency-cruiser rule.
 */

export type UserRole = 'user' | 'admin' | 'auditor';
export type UserStatus = 'active' | 'disabled';

export const USER_ROLES: readonly UserRole[] = ['user', 'admin', 'auditor'];
export const USER_STATUSES: readonly UserStatus[] = ['active', 'disabled'];

export interface User {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly passwordHash: string;
  readonly passwordUpdatedAt: Date;
  readonly mustChangePassword: boolean;
  readonly failedLoginAttempts: number;
  readonly lockedUntil: Date | null;
  readonly role: UserRole;
  readonly status: UserStatus;
  readonly divisionId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastLoginAt: Date | null;
  readonly deletedAt: Date | null;
}

/** Lockout thresholds, injected from config (LOGIN_MAX_FAILURES / LOGIN_LOCKOUT_MINUTES). */
export interface LockoutPolicy {
  readonly maxFailures: number;
  readonly lockoutMinutes: number;
}

export function isLocked(user: Pick<User, 'lockedUntil'>, now: Date): boolean {
  return user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
}

export function isActive(user: Pick<User, 'status' | 'deletedAt'>): boolean {
  return user.status === 'active' && user.deletedAt === null;
}

export function hasRole(user: Pick<User, 'role'>, ...roles: UserRole[]): boolean {
  return roles.includes(user.role);
}

export type AuthenticationBlock = 'disabled' | 'locked';

/**
 * Whether a row may even attempt to authenticate. Credentials are checked only when
 * this returns `ok` — a locked or disabled account always yields a generic failure
 * to the caller (no user enumeration).
 */
export function authenticationBlock(
  user: Pick<User, 'status' | 'deletedAt' | 'lockedUntil'>,
  now: Date,
): AuthenticationBlock | null {
  if (!isActive(user)) return 'disabled';
  if (isLocked(user, now)) return 'locked';
  return null;
}

export interface FailureOutcome {
  readonly failedLoginAttempts: number;
  readonly lockedUntil: Date | null;
  readonly lockedNow: boolean;
}

/** Increment the failure counter and lock the account once the threshold is reached. */
export function nextFailureState(
  currentFailures: number,
  policy: LockoutPolicy,
  now: Date,
): FailureOutcome {
  const failedLoginAttempts = currentFailures + 1;
  if (failedLoginAttempts >= policy.maxFailures) {
    return {
      failedLoginAttempts,
      lockedUntil: new Date(now.getTime() + policy.lockoutMinutes * 60_000),
      lockedNow: true,
    };
  }
  return { failedLoginAttempts, lockedUntil: null, lockedNow: false };
}
