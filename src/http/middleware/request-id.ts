import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../types.ts';

/**
 * Correlates a request across logs and responses. A client-supplied id is honored
 * only when it is well-formed (API_CONTRACTS §1); otherwise the server generates one.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const supplied = c.req.header('x-request-id');
    const id = supplied !== undefined && REQUEST_ID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
    c.set('requestId', id);
    c.header('X-Request-Id', id);
    await next();
  };
}
