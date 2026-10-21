import type { MiddlewareHandler } from 'hono';
import { AppError } from '@/errors.ts';
import type { AppEnv } from '../types.ts';

/** Enforces password change when user.mustChangePassword is set. */
export function requirePasswordChanged(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (auth !== undefined && auth.user.mustChangePassword) {
      throw new AppError('password_change_required');
    }
    await next();
  };
}
