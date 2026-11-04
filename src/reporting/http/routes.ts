import { Hono } from 'hono';
import type { z } from 'zod';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { Config } from '@/config/index.ts';
import { AppError } from '@/errors.ts';
import { ok } from '@/http/envelope.ts';
import { requireCsrf } from '@/http/middleware/require-csrf.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requirePasswordChanged } from '@/http/middleware/require-password-changed.ts';
import { requireSuperAdmin } from '@/http/middleware/require-role.ts';
import { rateLimit } from '@/http/middleware/rate-limit.ts';
import type { RateLimiter } from '@/http/ports/rate-limiter.ts';
import type { AppEnv } from '@/http/types.ts';
import type { ReportingService } from '../application/reporting-service.ts';
import {
  AuditSearchQuerySchema,
  ErrorExplorerQuerySchema,
  UsageQuerySchema,
  UsageWindowQuerySchema,
} from './schemas.ts';

export interface ReportingRoutesDeps {
  readonly reporting: ReportingService;
  readonly auth: AuthService;
  readonly config: Config;
  readonly rateLimiter: RateLimiter;
}

export function reportingRoutes(deps: ReportingRoutesDeps): Hono<AppEnv> {
  const { reporting, auth, config, rateLimiter } = deps;
  const routes = new Hono<AppEnv>();

  routes.use('*', requireCsrf(config));
  routes.use('*', requireAuth(auth, config));
  routes.use('*', requirePasswordChanged());
  routes.use('*', requireSuperAdmin());
  routes.use(
    '/usage/*',
    rateLimit(config, rateLimiter, {
      name: 'reporting-usage',
      scope: 'user',
      limit: config.RATE_LIMIT_REPORTING_REQUESTS,
      windowSeconds: config.RATE_LIMIT_WINDOW_SECONDS,
    }),
  );

  routes.get('/dashboard', async (c) => {
    const report = await reporting.dashboard();
    privateCache(c, 30);
    return c.json(ok(report));
  });

  routes.get('/usage/report', async (c) => {
    const query = parseQuery(c, UsageWindowQuerySchema);
    const report = await reporting.usageReport(query);
    privateCache(c, 30);
    return c.json(ok(report));
  });

  routes.get('/usage/export', async (c) => {
    const query = parseQuery(c, UsageQuerySchema);
    const csv = await reporting.usageCsv(query);
    const day = new Date().toISOString().slice(0, 10);
    noStore(c);
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="usage-${query.groupBy}-${day}.csv"`);
    return c.body(csv);
  });

  routes.get('/errors', async (c) => {
    const query = parseQuery(c, ErrorExplorerQuerySchema);
    const page = await reporting.errors(query);
    noStore(c);
    return c.json(ok(page));
  });

  routes.get('/audit-logs', async (c) => {
    const query = parseQuery(c, AuditSearchQuerySchema);
    const page = await reporting.auditLogs(query);
    noStore(c);
    return c.json(ok(page));
  });

  return routes;
}

function noStore(c: { header(name: string, value: string): void }): void {
  c.header('Cache-Control', 'no-store');
}

function privateCache(
  c: { header(name: string, value: string): void },
  maxAgeSeconds: number,
): void {
  c.header(
    'Cache-Control',
    `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds}`,
  );
}

function parseQuery<S extends z.ZodTypeAny>(
  c: { req: { query(): Record<string, string> } },
  schema: S,
): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AppError('invalid_request', 'The request is invalid.', {
      details: {
        fields: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(query)',
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data;
}
