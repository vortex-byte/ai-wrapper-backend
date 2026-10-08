import type { MiddlewareHandler } from 'hono';
import { getLogger } from '../../observability/logger.ts';
import type { AppEnv } from '../types.ts';

/**
 * Attaches a per-request child logger and emits one completion line. The path is
 * logged; query strings, bodies and headers are not (PRD §15.10 / §21).
 */
export function requestLogger(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const logger = getLogger().child({ requestId: c.get('requestId') });
    c.set('logger', logger);
    const start = performance.now();
    await next();
    const durationMs = Math.round(performance.now() - start);
    logger.info(
      { method: c.req.method, path: c.req.path, status: c.res.status, durationMs },
      'request',
    );
  };
}
