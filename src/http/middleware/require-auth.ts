import type { MiddlewareHandler } from 'hono';
import { AppError } from '@/errors.ts';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { AppEnv } from '../types.ts';
import { readSessionToken } from './session-cookie.ts';
import type { Config } from '@/config/index.ts';

/** Authenticates session cookie and attaches authenticated context to request environment. */
export function requireAuth(auth: AuthService, config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = readSessionToken(c, config);
    if (token === undefined) {
      throw new AppError('unauthenticated');
    }

    const resolved = await auth.resolveSession(token);
    if (resolved === null) {
      throw new AppError('unauthenticated');
    }

    c.set('auth', { user: resolved.user, session: resolved.session });
    await next();
  };
}
