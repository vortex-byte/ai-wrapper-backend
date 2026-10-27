import { Hono } from 'hono';
import type { Config } from '../config/index.ts';
import type { Services } from '../services.ts';
import { authRoutes } from '../auth/http/routes.ts';
import { meRoutes } from '../auth/http/me-routes.ts';
import { adminRoutes } from '../admin/http/routes.ts';
import { registryAdminRoutes } from '../providers/http/admin-routes.ts';
import { modelRoutes } from '../providers/http/model-routes.ts';
import { conversationRoutes } from '../conversations/http/routes.ts';
import { generationRoutes } from '../generations/http/routes.ts';
import { quotaRoutes } from '../quota/http/routes.ts';
import { attachmentRoutes } from '../attachments/http/routes.ts';
import { reportingRoutes } from '../reporting/http/routes.ts';
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
  api.route('/', modelRoutes({ registry: services.registry, auth: services.auth, config }));
  api.route(
    '/',
    conversationRoutes({
      conversations: services.conversations,
      send: services.send,
      files: services.attachments,
      auth: services.auth,
      config,
      rateLimiter: services.rateLimiter,
    }),
  );
  api.route(
    '/',
    generationRoutes({
      generations: services.generationRepository,
      conversations: services.conversationRepository,
      orchestrator: services.orchestrator,
      finalizer: services.finalizer,
      auth: services.auth,
      config,
      rateLimiter: services.rateLimiter,
    }),
  );
  api.route('/admin', adminRoutes({ admin: services.admin, auth: services.auth, config }));
  api.route(
    '/',
    attachmentRoutes({
      service: services.attachments,
      auth: services.auth,
      config,
      rateLimiter: services.rateLimiter,
    }),
  );
  api.route(
    '/',
    quotaRoutes({
      quota: services.quotaService,
      usage: services.usageService,
      audit: services.audit,
      auth: services.auth,
      config,
    }),
  );
  api.route(
    '/admin',
    registryAdminRoutes({
      registryAdmin: services.registryAdmin,
      auth: services.auth,
      config,
    }),
  );
  api.route(
    '/admin',
    reportingRoutes({
      reporting: services.reporting,
      auth: services.auth,
      config,
    }),
  );

  return api;
}
