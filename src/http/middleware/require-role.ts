import type { MiddlewareHandler } from 'hono';
import type { UserRole } from '@/auth/domain/user.ts';
import { AppError } from '@/errors.ts';
import type { AppEnv } from '../types.ts';

/**
 * Role-based access control. Mount **after** `requireAuth`:
 * the caller is read from the request context, never from a header or the body.
 *
 * A missing caller (middleware mis-ordered) is `401`; a known caller whose role is not
 * in the allow-list is `403 forbidden`. The role set comes from the user's DB row, so a
 * role change takes effect on the next request (no cache — same policy as sessions).
 */
export function requireRole(...roles: readonly UserRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (auth === undefined) throw new AppError('unauthenticated');
    if (!roles.includes(auth.user.role)) throw new AppError('forbidden');
    await next();
  };
}

/** Shorthand for the (currently) only privileged role. */
export function requireAdmin(): MiddlewareHandler<AppEnv> {
  return requireRole('admin');
}
