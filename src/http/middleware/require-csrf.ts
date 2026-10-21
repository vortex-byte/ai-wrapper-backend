import type { MiddlewareHandler } from 'hono';
import type { Config } from '@/config/index.ts';
import { verifyCsrfToken } from '@/csrf.ts';
import { AppError } from '@/errors.ts';
import type { AppEnv } from '../types.ts';
import { isAllowedOrigin } from './cors.ts';

/** CSRF protection combining allowed Origin enforcement and X-CSRF-Token verification. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Enforces that non-safe requests arrive from an allowed origin. */
export function enforceOrigin(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      if (origin === undefined || !isAllowedOrigin(config, origin)) {
        throw new AppError('forbidden');
      }
    }
    await next();
  };
}

/** Steps 1 + 2 — origin and token. Used by every other mutating route. */
export function requireCsrf(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }

    const origin = c.req.header('origin');
    if (origin !== undefined && !isAllowedOrigin(config, origin)) {
      throw new AppError('forbidden');
    }

    const token = c.req.header('x-csrf-token');
    if (token === undefined || !verifyCsrfToken(config.SESSION_SECRET, token).ok) {
      throw new AppError('forbidden');
    }

    await next();
  };
}
