import type { MiddlewareHandler } from 'hono';
import { AppError } from '@/errors.ts';
import type { AppEnv } from '../types.ts';

/**
 * Enforces the forced-password-change gate. While
 * `must_change_password` is true, every endpoint except the ones that let the user
 * inspect their account, fix it, or sign out is refused with
 * `403 password_change_required`.
 *
 * Mount it **after** `requireAuth` (it reads the caller from the context) on any route
 * tree that is not itself exempt. The exempt routes simply never mount it.
 */
export function requirePasswordChanged(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (auth !== undefined && auth.user.mustChangePassword) {
      throw new AppError('password_change_required');
    }
    await next();
  };
}
