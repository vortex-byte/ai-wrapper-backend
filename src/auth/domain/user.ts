export type UserRole = 'user' | 'admin' | 'auditor';
export type UserStatus = 'active' | 'disabled';

export const USER_ROLES = ['user', 'admin', 'auditor'] as const satisfies readonly UserRole[];
export const USER_STATUSES = ['active', 'disabled'] as const satisfies readonly UserStatus[];

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
