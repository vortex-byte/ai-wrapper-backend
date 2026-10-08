import { Hono } from 'hono';
import type { Config } from '../config/index.ts';
import type { Services } from '../services.ts';
import { authRoutes } from '../auth/http/routes.ts';
import { meRoutes } from '../auth/http/me-routes.ts';
import type { AppEnv } from './types.ts';

/**
 * The `/api` tree (unversioned — API_CONTRACTS §17). Feature routers are mounted here
 * as their milestones land; until then unknown paths fall through to the global 404.
 *
 * Mounting order per tree:
 *   requestId → requestLogger → securityHeaders → cors  (in `app.ts`)
 *   → per-route: requireCsrf (mutations) → requireAuth → requirePasswordChanged
 */
export function apiRouter(config: Config, services: Services): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  api.route('/', authRoutes({ auth: services.auth, config }));
  api.route('/', meRoutes({ auth: services.auth, config }));

  return api;
}
