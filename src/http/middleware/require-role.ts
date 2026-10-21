import type { MiddlewareHandler } from 'hono';
import type { UserRole } from '@/auth/domain/user.ts';
import { AppError } from '@/errors.ts';
import type { AppEnv } from '../types.ts';

/** Enforces required user roles for authenticated requests. */
export function requireRole(...roles: readonly UserRole[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (auth === undefined) throw new AppError('unauthenticated');
    if (!roles.includes(auth.user.role)) throw new AppError('forbidden');
    await next();
  };
}

/** Shorthand for division administrators and super administrators (e.g. user management). */
export function requireAdmin(): MiddlewareHandler<AppEnv> {
  return requireRole('admin', 'super_admin');
}

/** Shorthand for system-wide super administrator routes. */
export function requireSuperAdmin(): MiddlewareHandler<AppEnv> {
  return requireRole('super_admin');
}
