import { Hono } from 'hono';
import type { Config } from './config/index.ts';
import { onError, notFound } from './http/error-handler.ts';
import { requestId } from './http/middleware/request-id.ts';
import { requestLogger } from './http/middleware/request-logger.ts';
import { securityHeaders } from './http/middleware/security-headers.ts';
import { apiRouter } from './http/router.ts';
import type { AppEnv } from './http/types.ts';
import { healthRoutes } from './health/routes.ts';

/**
 * Composition root (AGENTS §3.7). Wires middleware, the `/api` tree and the raw ops
 * routes. No business logic lives here.
 */
export function createApp(config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requestId());
  app.use('*', requestLogger());
  app.use('*', securityHeaders(config));

  app.onError(onError(config));
  app.notFound(notFound);

  // Raw ops endpoints (root level, not enveloped).
  app.route('/', healthRoutes(config));

  // Versioned-free product API.
  app.route('/api', apiRouter());

  return app;
}
