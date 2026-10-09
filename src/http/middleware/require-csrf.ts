import type { MiddlewareHandler } from 'hono';
import type { Config } from '@/config/index.ts';
import { verifyCsrfToken } from '@/csrf.ts';
import { AppError } from '@/errors.ts';
import type { AppEnv } from '../types.ts';
import { isAllowedOrigin } from './cors.ts';

/**
 * CSRF protection for state-changing requests. Two independent
 * checks:
 *
 * 1. `Origin` — when present it must be an allowed SPA origin; this alone blocks the
 *    classic cross-site form post / fetch, because a browser always attaches `Origin`
 *    to cross-origin non-GET requests and our session cookie is `SameSite=Lax`.
 * 2. `X-CSRF-Token` — a valid, unexpired signature made with `SESSION_SECRET`.
 *
 * `POST /api/auth/login` cannot carry a token yet (it is what issues it), so that route
 * uses `enforceOrigin` only — a deliberate "login CSRF" trade-off bounded by the
 * same-site `SameSite=Lax` cookie and the strict origin allow-list. Because that is the
 * sole defense there, an *absent* `Origin` is rejected on the login path too.
 *
 * Safe methods (GET/HEAD/OPTIONS) are always exempt. Failures are `403 forbidden` and
 * never reveal which check failed.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Step 1 only — origin validation. Used by the login route.
 *
 * Login cannot carry a CSRF token (it issues one), so the `Origin` check is the whole
 * defense. A missing `Origin` on a non-GET request is therefore rejected, not waved
 * through: browsers always attach `Origin` to cross-origin non-GET requests, so a
 * well-behaved SPA never trips this, while a cross-site form post (which may omit the
 * header) is blocked. `OPTIONS`/`GET`/`HEAD` stay exempt.
 */
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
