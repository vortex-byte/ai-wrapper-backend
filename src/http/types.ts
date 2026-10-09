import type { Logger } from '../observability/logger.ts';
import type { SessionRecord } from '../auth/domain/session.ts';
import type { User, UserRole } from '../auth/domain/user.ts';

export interface AppEnv {
  Variables: {
    requestId: string;
    logger: Logger;
    auth?: AuthContext;
  };
}

export interface AuthContext {
  readonly user: User;
  readonly session: SessionRecord;
}

export function hasAnyRole(auth: AuthContext, roles: readonly UserRole[]): boolean {
  return roles.includes(auth.user.role);
}
