import { Hono } from 'hono';
import type { Config } from '../config/index.ts';
import type { AppEnv } from '../http/types.ts';
import type { MetricsRegistry } from '../observability/metrics.ts';
import { checkReadiness } from './readyz.ts';

const startedAt = Date.now();

export function healthRoutes(config: Config, metrics?: MetricsRegistry): Hono<AppEnv> {
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

  routes.get('/metrics', (c) => {
    if (config.METRICS_TOKEN !== '') {
      const supplied = c.req.header('authorization');
      if (supplied !== `Bearer ${config.METRICS_TOKEN}`) {
        return c.text('unauthorized', 401);
      }
    }
    const uptimeSeconds = (Date.now() - startedAt) / 1000;
    const body = [
      '# HELP aichat_up 1 if the process is serving.',
      '# TYPE aichat_up gauge',
      'aichat_up 1',
      '# HELP aichat_uptime_seconds Seconds since process start.',
      '# TYPE aichat_uptime_seconds gauge',
      `aichat_uptime_seconds ${uptimeSeconds.toFixed(3)}`,
      
      metrics?.render() ?? '',
    ].join('\n');
    return c.text(body, 200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
  });

  return routes;
}
