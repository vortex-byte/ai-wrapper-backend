import type { MiddlewareHandler } from 'hono';
import type { Config } from '../../config/index.ts';
import type { AppEnv } from '../types.ts';

/**
 * Baseline security headers for every response (PRD §15.7). HSTS is only meaningful
 * behind TLS, so it is added in production only. JSON API responses are never cached.
 */
export function securityHeaders(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();

    const headers = c.res.headers;
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');

    if (config.NODE_ENV === 'production') {
      headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }

    if (c.req.path.startsWith('/api') || c.req.path === '/metrics') {
      headers.set('Cache-Control', 'no-store');
    }
  };
}
