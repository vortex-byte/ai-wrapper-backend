import { Hono } from 'hono';
import type { Config } from './config/index.ts';
import { createServices } from './services.ts';
import { onError, notFound } from './http/error-handler.ts';
import { cors } from './http/middleware/cors.ts';
import { requestId } from './http/middleware/request-id.ts';
import { requestLogger } from './http/middleware/request-logger.ts';
import { securityHeaders } from './http/middleware/security-headers.ts';
import { rateLimit } from './http/middleware/rate-limit.ts';
import { apiRouter } from './http/router.ts';
import type { AppEnv } from './http/types.ts';
import { healthRoutes } from './health/routes.ts';

import type { Services } from './services.ts';

export function createApp(config: Config, customServices?: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const services = customServices ?? createServices(config);

  app.use('*', requestId());
  app.use('*', requestLogger());
  app.use('*', securityHeaders(config));
  app.use('/api/*', cors(config));
  app.use(
    '/api/*',
    rateLimit(config, services.rateLimiter, {
      name: 'api',
      scope: 'ip',
      limit: config.RATE_LIMIT_API_IP_REQUESTS,
      windowSeconds: config.RATE_LIMIT_WINDOW_SECONDS,
    }),
  );
  app.onError(onError(config));
  app.notFound(notFound);
  app.route('/', healthRoutes(config));
  app.route('/api', apiRouter(config, services));

  return app;
}
