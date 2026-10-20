import type { User, UserRole, UserStatus } from '@/auth/domain/user.ts';

export interface SafeguardCheckInput {
  readonly targetUser: User;
  readonly newRole?: UserRole | undefined;
  readonly newStatus?: UserStatus | undefined;
  readonly activeAdminCount: number;
}

/**
 * Domain invariant: cannot disable or demote the last active admin.
 */
export function canUpdateUserRoleOrStatus(input: SafeguardCheckInput): boolean {
  const { targetUser, newRole, newStatus, activeAdminCount } = input;

  const isCurrentlyActiveAdmin = targetUser.role === 'admin' && targetUser.status === 'active';
  if (!isCurrentlyActiveAdmin) {
    return true;
  }

  const isDemoted = newRole !== undefined && newRole !== 'admin';
  const isDisabled = newStatus !== undefined && newStatus !== 'active';

  if ((isDemoted || isDisabled) && activeAdminCount <= 1) {
    return false;
  }

  return true;
}
