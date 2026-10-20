import type { MiddlewareHandler } from 'hono';
import type { Config } from '@/config/index.ts';
import type { AppEnv } from '../types.ts';

/**
 * CORS for the cross-origin SPA: the session cookie rides along, so the origin must be matched
 * exactly against `ALLOWED_ORIGINS` (never `*`) and `Vary: Origin` keeps caches from mixing
 * responses. A disallowed origin gets no CORS headers (the browser blocks it) but is not rejected
 * here — that check belongs to `requireCsrf`.
 */

const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, X-CSRF-Token, Idempotency-Key, X-Request-Id';
const MAX_AGE_SECONDS = '600';

function resolveOrigin(config: Config, origin: string | undefined): string | null {
  if (origin === undefined || origin === '') return null;
  return config.ALLOWED_ORIGINS.includes(origin) ? origin : null;
}

export function cors(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const allowed = resolveOrigin(config, c.req.header('origin'));

    c.header('Vary', 'Origin');

    if (allowed !== null) {
      c.header('Access-Control-Allow-Origin', allowed);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Expose-Headers', 'X-Request-Id, RateLimit-Remaining');
    }

    if (c.req.method === 'OPTIONS') {
      if (allowed !== null) {
        c.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
        c.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        c.header('Access-Control-Max-Age', MAX_AGE_SECONDS);
      }
      return c.body(null, 204);
    }

    await next();
  };
}

export function isAllowedOrigin(config: Config, origin: string | undefined): boolean {
  return resolveOrigin(config, origin) !== null;
}
