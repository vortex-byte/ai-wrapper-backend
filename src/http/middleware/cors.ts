import type { MiddlewareHandler } from 'hono';
import type { Config } from '../../config/index.ts';
import type { AppEnv } from '../types.ts';

/**
 * CORS for the cross-origin SPA (PRD §15.7). The SPA and API are different subdomains
 * of the same site, so the browser sends the session cookie but the origin still has to
 * be allowed explicitly.
 *
 * Rules enforced here:
 * - exact origin matching from `ALLOWED_ORIGINS` — never `*`;
 * - `Access-Control-Allow-Credentials: true` so the cookie rides along;
 * - `Vary: Origin` so caches never mix responses across origins;
 * - preflight (`OPTIONS`) answered with the allowed methods/headers and a 600 s cache.
 *
 * A disallowed origin receives no CORS headers (the browser blocks it). It is *not*
 * rejected here — the `Origin` check for CSRF (§1) happens in `requireCsrf`.
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

    // Vary on every response (even without an Origin) so shared caches stay correct.
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

/** True when `origin` is one of the configured SPA origins. */
export function isAllowedOrigin(config: Config, origin: string | undefined): boolean {
  return resolveOrigin(config, origin) !== null;
}
