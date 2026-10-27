export const AUDIT_ACTIONS = {
  login: 'login',
  logout: 'logout',
  failedLogin: 'failed_login',
  passwordChange: 'password_change',
  passwordChangeFailed: 'password_change_failed',
  passwordReset: 'password_reset',
  userCreate: 'user.create',
  userUpdate: 'user.update',
  userDelete: 'user.delete',
  loginRateLimited: 'user.login_rate_limited',
  divisionCreate: 'division.create',
  divisionUpdate: 'division.update',
  divisionDelete: 'division.delete',
  providerCreate: 'provider.create',
  providerUpdate: 'provider.update',
  modelCreate: 'model.create',
  modelUpdate: 'model.update',
  modelPriceSet: 'model.price_set',
  settingsUpdate: 'settings.update',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];
