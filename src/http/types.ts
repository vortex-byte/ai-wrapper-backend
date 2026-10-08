import type { Logger } from '../observability/logger.ts';
import type { SessionRecord } from '../auth/domain/session.ts';
import type { User, UserRole } from '../auth/domain/user.ts';

/**
 * Hono environment for this app. `Variables` are per-request values set by
 * middleware. Keep this list small and explicit.
 */
export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
    /** Set by the auth middleware once a valid session cookie is resolved. */
    auth?: AuthContext;
  };
}

/**
 * The authenticated caller, attached to the request context after the session cookie
 * is validated. Every repository call takes a user id from here so a user can only
 * ever reach their own rows (AGENTS §5).
 */
export interface AuthContext {
  readonly user: User;
  readonly session: SessionRecord;
}

export function hasAnyRole(auth: AuthContext, roles: readonly UserRole[]): boolean {
  return roles.includes(auth.user.role);
}
