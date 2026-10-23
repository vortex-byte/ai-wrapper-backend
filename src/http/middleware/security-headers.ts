import type { MiddlewareHandler } from 'hono';
import type { Config } from '@/config/index.ts';
import type { AppEnv } from '../types.ts';

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'camera=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'payment=()',
  'usb=()',
].join(', ');

export function securityHeaders(config: Config): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();

    const headers = c.res.headers;
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Permissions-Policy', PERMISSIONS_POLICY);
    headers.set('X-Permitted-Cross-Domain-Policies', 'none');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');

    if (headers.get('Content-Security-Policy') === null) {
      headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    }

    if (config.NODE_ENV === 'production') {
      headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }

    if (c.req.path.startsWith('/api') && headers.get('Cache-Control') === null) {
      headers.set('Cache-Control', 'no-store');
    }
  };
}
