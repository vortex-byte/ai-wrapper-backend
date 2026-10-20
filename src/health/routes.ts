import { Hono } from 'hono';
import type { Config } from '../config/index.ts';
import type { AppEnv } from '../http/types.ts';
import { checkReadiness } from './readyz.ts';

export function healthRoutes(config: Config): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/healthz', (c) => c.text('ok'));

  routes.get('/readyz', async (c) => {
    const report = await checkReadiness(config);

    const body =
      config.NODE_ENV === 'production'
        ? {
            ready: report.ready,
            checks: Object.fromEntries(
              Object.entries(report.checks).map(([name, check]) => [
                name,
                check.ok ? { ok: true, detail: 'ok' } : { ok: false, detail: 'unavailable' },
              ]),
            ),
          }
        : report;
    return c.json(body, report.ready ? 200 : 503);
  });

  return routes;
}
