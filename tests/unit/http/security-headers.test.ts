import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/index.ts';
import { loadConfig } from '@/config/index.ts';
import { securityHeaders } from '@/http/middleware/security-headers.ts';
import type { AppEnv } from '@/http/types.ts';

function testConfig(overrides: Record<string, unknown> = {}): Config {
  return loadConfig({
    DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/aichat_test',
    SESSION_SECRET: 'a'.repeat(48),
    ...overrides,
  });
}

function buildApp(config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', securityHeaders(config));
  app.get('/api/thing', (c) => c.json({ ok: true }));
  app.get('/healthz', (c) => c.text('ok'));
  return app;
}

describe('securityHeaders', () => {
  it('sets a deny-by-default CSP and the baseline headers', async () => {
    const res = await buildApp(testConfig({ NODE_ENV: 'test' })).request('/api/thing');

    expect(res.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Permissions-Policy')).toContain('camera=()');
    expect(res.headers.get('X-Permitted-Cross-Domain-Policies')).toBe('none');
  });

  it('disables caching for API responses but not for probes', async () => {
    const app = buildApp(testConfig({ NODE_ENV: 'test' }));
    expect((await app.request('/api/thing')).headers.get('Cache-Control')).toBe('no-store');
    expect((await app.request('/healthz')).headers.get('Cache-Control')).toBeNull();
  });

  it('adds HSTS only in production', async () => {
    const dev = await buildApp(testConfig({ NODE_ENV: 'development' })).request('/api/thing');
    expect(dev.headers.get('Strict-Transport-Security')).toBeNull();

    const prod = await buildApp(testConfig({ NODE_ENV: 'production' })).request('/api/thing');
    expect(prod.headers.get('Strict-Transport-Security')).toContain('max-age=63072000');
  });

  it('keeps a stricter CSP set by the route', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', securityHeaders(testConfig({ NODE_ENV: 'test' })));
    app.get('/api/files/:id/content', (c) => {
      c.header('Content-Security-Policy', "sandbox; default-src 'none'");
      return c.body('bytes');
    });

    const res = await app.request('/api/files/abc/content');
    expect(res.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
  });
});
