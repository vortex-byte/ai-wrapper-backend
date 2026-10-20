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
import type { AppEnv } from '@/http/types.ts';
import type { ReportingService } from '../application/reporting-service.ts';
import {
  AuditSearchQuerySchema,
  ErrorExplorerQuerySchema,
  UsageExportQuerySchema,
  UsageQuerySchema,
} from './schemas.ts';

export interface ReportingRoutesDeps {
  readonly reporting: ReportingService;
  readonly auth: AuthService;
  readonly config: Config;
}

export function reportingRoutes(deps: ReportingRoutesDeps): Hono<AppEnv> {
  const { reporting, auth, config } = deps;
  const routes = new Hono<AppEnv>();

  routes.use('*', requireCsrf(config));
  routes.use('*', requireAuth(auth, config));
  routes.use('*', requirePasswordChanged());
  routes.use('*', requireSuperAdmin());

  routes.get('/usage', async (c) => {
    const query = parseQuery(c, UsageQuerySchema);
    const items = await reporting.usage(query);
    noStore(c);
    return c.json(ok({ items }));
  });

  routes.get('/usage/export', async (c) => {
    const query = parseQuery(c, UsageExportQuerySchema);
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
