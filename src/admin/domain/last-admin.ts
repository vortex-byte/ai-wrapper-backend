export type SafeguardRole = 'user' | 'admin' | 'super_admin';
export type SafeguardStatus = 'active' | 'disabled';

export interface SafeguardTargetUser {
  readonly role: SafeguardRole;
  readonly status: SafeguardStatus;
}

export interface SafeguardCheckInput {
  readonly targetUser: SafeguardTargetUser;
  readonly newRole?: SafeguardRole | undefined;
  readonly newStatus?: SafeguardStatus | undefined;
  readonly activeSuperAdminCount: number;
}

/**
 * Domain invariant: cannot disable or demote the last active super_admin.
 */
export function canUpdateUserRoleOrStatus(input: SafeguardCheckInput): boolean {
  const { targetUser, newRole, newStatus, activeSuperAdminCount } = input;

  const isCurrentlyActiveSuperAdmin =
    targetUser.role === 'super_admin' && targetUser.status === 'active';
  if (!isCurrentlyActiveSuperAdmin) {
    return true;
  }

  const isDemoted = newRole !== undefined && newRole !== 'super_admin';
  const isDisabled = newStatus !== undefined && newStatus !== 'active';

  if ((isDemoted || isDisabled) && activeSuperAdminCount <= 1) {
    return false;
  }

  return true;
}
