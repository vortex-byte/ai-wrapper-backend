import type { MiddlewareHandler } from 'hono';
import { getLogger } from '@/observability/logger.ts';
import type { AppEnv } from '../types.ts';

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
