/**
 * Audit action names (PRD §15.1 lists login/logout/failed_login/password_change and
 * admin password_reset). Kept as constants so tests and queries never drift on strings.
 */
export const AUDIT_ACTIONS = {
  login: 'login',
  logout: 'logout',
  failedLogin: 'failed_login',
  passwordChange: 'password_change',
  passwordChangeFailed: 'password_change_failed',
  passwordReset: 'password_reset',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
