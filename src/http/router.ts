import { Hono } from 'hono';
import type { Config } from '../config/index.ts';
import type { Services } from '../services.ts';
import { authRoutes } from '../auth/http/routes.ts';
import { meRoutes } from '../auth/http/me-routes.ts';
import { adminRoutes } from '../admin/http/routes.ts';
import type { AppEnv } from './types.ts';

export function apiRouter(config: Config, services: Services): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  api.route(
    '/',
    authRoutes({
      auth: services.auth,
      config,
      rateLimiter: services.rateLimiter,
      audit: services.audit,
    }),
  );
  api.route('/', meRoutes({ auth: services.auth, config }));
  api.route('/admin', adminRoutes({ admin: services.admin, auth: services.auth, config }));

  return api;
}
