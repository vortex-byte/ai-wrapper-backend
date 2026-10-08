export { createAuthService, type AuthService } from './application/auth-service.ts';
export type {
  AuthDeps,
  ChangePasswordInput,
  ChangePasswordSuccess,
  LoginInput,
  LoginSuccess,
  LogoutInput,
  ResolvedSession,
} from './application/auth-service.ts';

export type { LockoutPolicy, User, UserRole, UserStatus } from './domain/user.ts';
export { authenticationBlock, hasRole, isActive, isLocked, nextFailureState } from './domain/user.ts';
export type { SessionPolicy, SessionRecord } from './domain/session.ts';
export { computeExpiry, isSessionExpired, shouldTouch } from './domain/session.ts';
export type { PasswordPolicy } from './domain/password-policy.ts';
export { validatePassword, passwordProblemMessage } from './domain/password-policy.ts';

export type { PasswordHasher } from './ports/password-hasher.ts';
export type { SessionRepository } from './ports/session-repository.ts';
export type { UserRepository } from './ports/user-repository.ts';

export { BunPasswordHasher } from './infrastructure/bun-password-hasher.ts';
export { DrizzleUserRepository } from './infrastructure/drizzle-user-repository.ts';
export { DrizzleSessionRepository } from './infrastructure/drizzle-session-repository.ts';
