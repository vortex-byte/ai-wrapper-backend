import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Config } from '@/config/index.ts';
import { loadConfig } from '@/config/index.ts';
import { issueCsrfToken } from '@/csrf.ts';
import { AppError, isAppError } from '@/errors.ts';
import { cors, isAllowedOrigin } from '@/http/middleware/cors.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requireCsrf, enforceOrigin } from '@/http/middleware/require-csrf.ts';
import { requirePasswordChanged } from '@/http/middleware/require-password-changed.ts';
import { requireAdmin, requireRole } from '@/http/middleware/require-role.ts';
import { rateLimitLogin } from '@/http/middleware/rate-limit-login.ts';
import { rateLimit, userRateLimit } from '@/http/middleware/rate-limit.ts';
import { MemoryRateLimiter } from '@/http/infrastructure/memory-rate-limiter.ts';
import type { AppEnv } from '@/http/types.ts';
import type { AuthService } from '@/auth/application/auth-service.ts';
import { makeUser } from '../auth/fakes.ts';

const ORIGIN = 'https://app.corp.example';
const SECRET = 'a'.repeat(48);

function testConfig(overrides: Record<string, unknown> = {}): Config {
  return loadConfig({
    DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/aichat_test',
    SESSION_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
    NODE_ENV: 'test',
    ...overrides,
  });
}

/** Minimal AuthService double: only `resolveSession` is exercised by the middleware. */
function fakeAuth(resolved: { user: ReturnType<typeof makeUser> } | null): AuthService {
  return {
    login: async () => {
      throw new Error('not used');
    },
    logout: async () => {},
    changePassword: async () => {
      throw new Error('not used');
    },
    resolveSession: async () =>
      resolved === null
        ? null
        : {
            user: resolved.user,
            session: {
              id: 'session-1',
              userId: resolved.user.id,
              createdAt: new Date(),
              lastSeenAt: new Date(),
              expiresAt: new Date(Date.now() + 60_000),
              revokedAt: null,
              rotatedFrom: null,
            },
          },
  };
}

/** Small app whose `onError` mirrors the real one closely enough for these tests. */
function buildApp(config: Config, routes: (app: Hono<AppEnv>) => void): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('/api/*', cors(config));
  app.onError((error, c) => {
    const appError = isAppError(error) ? error : new AppError('internal_error');
    return c.json({ code: appError.code }, appError.status as 400);
  });
  app.notFound((c) => c.json({ code: 'not_found' }, 404));
  routes(app);
  return app;
}

describe('cors middleware', () => {
  it('echoes an allowed origin with credentials', async () => {
    const config = testConfig();
    const app = buildApp(config, (a) => {
      a.get('/api/thing', (c) => c.json({ ok: true }));
    });

    const res = await app.request('/api/thing', { headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Vary')).toContain('Origin');
  });

  it('omits CORS headers for a disallowed origin', async () => {
    const config = testConfig();
    const app = buildApp(config, (a) => {
      a.get('/api/thing', (c) => c.json({ ok: true }));
    });

    const res = await app.request('/api/thing', { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('answers preflight with methods, headers and a cached max-age', async () => {
    const config = testConfig();
    const app = buildApp(config, (a) => {
      a.post('/api/thing', (c) => c.json({ ok: true }));
    });

    const res = await app.request('/api/thing', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-CSRF-Token');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('600');
  });

  it('reports allowed origins precisely in test/production', () => {
    const config = testConfig();
    expect(isAllowedOrigin(config, ORIGIN)).toBe(true);
    expect(isAllowedOrigin(config, 'https://app.corp.example.evil.com')).toBe(false);
    expect(isAllowedOrigin(config, undefined)).toBe(false);
  });

  it('permits any origin and echoes it in development mode', async () => {
    const devConfig = testConfig({ NODE_ENV: 'development' });
    const app = buildApp(devConfig, (a) => {
      a.get('/api/thing', (c) => c.json({ ok: true }));
    });

    const res = await app.request('/api/thing', { headers: { Origin: 'http://localhost:5173' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(isAllowedOrigin(devConfig, 'http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin(devConfig, undefined)).toBe(true);
  });
});

describe('requireCsrf', () => {
  it('lets safe methods through without a token', async () => {
    const app = buildApp(testConfig(), (a) => {
      a.use('/api/*', requireCsrf(testConfig()));
      a.get('/api/thing', (c) => c.json({ ok: true }));
    });
    const res = await app.request('/api/thing');
    expect(res.status).toBe(200);
  });

  it('rejects a mutation with no token', async () => {
    const config = testConfig();
    const app = buildApp(config, (a) => {
      a.use('/api/*', requireCsrf(config));
      a.post('/api/thing', (c) => c.json({ ok: true }));
    });
    const res = await app.request('/api/thing', { method: 'POST', headers: { Origin: ORIGIN } });
    expect(res.status).toBe(403);
  });

  it('rejects a mutation from a disallowed origin even with a valid token', async () => {
    const config = testConfig();
    const app = buildApp(config, (a) => {
      a.use('/api/*', requireCsrf(config));
      a.post('/api/thing', (c) => c.json({ ok: true }));
    });
    const res = await app.request('/api/thing', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'X-CSRF-Token': issueCsrfToken(SECRET) },
    });
    expect(res.status).toBe(403);
  });

  it('accepts a mutation with a valid token from an allowed origin', async () => {
    const config = testConfig();
    const app = buildApp(config, (a) => {
      a.use('/api/*', requireCsrf(config));
      a.post('/api/thing', (c) => c.json({ ok: true }));
    });
    const res = await app.request('/api/thing', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'X-CSRF-Token': issueCsrfToken(SECRET) },
    });
    expect(res.status).toBe(200);
  });
});

describe('enforceOrigin', () => {
  it('rejects a mutation with no Origin (login is browser-only)', async () => {
    const config = testConfig();
    const app = buildApp(config, (a) => {
      a.use('/api/*', enforceOrigin(config));
      a.post('/api/thing', (c) => c.json({ ok: true }));
    });
    const res = await app.request('/api/thing', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('allows a mutation from an allowed origin without a token', async () => {
    const config = testConfig();
    const app = buildApp(config, (a) => {
      a.use('/api/*', enforceOrigin(config));
      a.post('/api/thing', (c) => c.json({ ok: true }));
    });
    const res = await app.request('/api/thing', { method: 'POST', headers: { Origin: ORIGIN } });
    expect(res.status).toBe(200);
  });

  it('rejects a mutation from a disallowed origin', async () => {
    const config = testConfig();
    const app = buildApp(config, (a) => {
      a.use('/api/*', enforceOrigin(config));
      a.post('/api/thing', (c) => c.json({ ok: true }));
    });
    const res = await app.request('/api/thing', {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('bypasses origin checks in development mode', async () => {
    const devConfig = testConfig({ NODE_ENV: 'development' });
    const app = buildApp(devConfig, (a) => {
      a.use('/api/*', enforceOrigin(devConfig));
      a.post('/api/thing', (c) => c.json({ ok: true }));
    });

    const resNoOrigin = await app.request('/api/thing', { method: 'POST' });
    expect(resNoOrigin.status).toBe(200);

    const resAnyOrigin = await app.request('/api/thing', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(resAnyOrigin.status).toBe(200);
  });
});

describe('requireAuth + requirePasswordChanged', () => {
  function securedApp(user: ReturnType<typeof makeUser> | null): Hono<AppEnv> {
    const config = testConfig();
    return buildApp(config, (a) => {
      a.use('/api/*', requireAuth(fakeAuth(user === null ? null : { user }), config));
      a.get('/api/me', (c) => c.json({ id: c.get('auth')?.user.id }));
    });
  }

  /** A request carrying a syntactically valid session cookie (value is opaque here). */
  function withSession(path: string): Request {
    return new Request(`http://localhost${path}`, {
      headers: { Cookie: `__Host-session=some-opaque-token` },
    });
  }

  it('rejects a request with no session', async () => {
    const res = await securedApp(null).request('/api/me');
    expect(res.status).toBe(401);
  });

  it('attaches the caller for a valid session', async () => {
    const res = await securedApp(makeUser({ id: 'user-42', mustChangePassword: false })).request(
      withSession('/api/me'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'user-42' });
  });

  it('blocks gated endpoints while a password change is pending', async () => {
    const config = testConfig();
    const user = makeUser({ mustChangePassword: true });
    const app = buildApp(config, (a) => {
      a.use('/api/*', requireAuth(fakeAuth({ user }), config));
      a.use('/api/*', requirePasswordChanged());
      a.get('/api/things', (c) => c.json({ ok: true }));
    });
    const res = await app.request(withSession('/api/things'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'password_change_required' });
  });
});

describe('requireRole', () => {
  function rbacApp(user: ReturnType<typeof makeUser>): Hono<AppEnv> {
    const config = testConfig();
    return buildApp(config, (a) => {
      a.use('/api/*', requireAuth(fakeAuth({ user }), config));
      a.use('/api/admin/*', requireAdmin());
      a.get('/api/admin/dashboard', (c) => c.json({ ok: true }));
    });
  }

  function withSession(path: string): Request {
    return new Request(`http://localhost${path}`, {
      headers: { Cookie: `__Host-session=some-opaque-token` },
    });
  }

  it('allows access to users with matching role in multi-role requireRole', async () => {
    const admin = makeUser({ role: 'admin' });
    const app = buildApp(testConfig(), (a) => {
      a.use('/api/*', requireAuth(fakeAuth({ user: admin }), testConfig()));
      a.use('/api/*', requireRole('admin', 'user'));
      a.get('/api/audit', (c) => c.json({ ok: true }));
    });
    const res = await app.request(
      new Request('http://localhost/api/audit', {
        headers: { Cookie: '__Host-session=some-opaque-token' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects non-admin users with 403 forbidden', async () => {
    const standardUser = makeUser({ role: 'user' });
    const res = await rbacApp(standardUser).request(withSession('/api/admin/dashboard'));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'forbidden' });
  });
});

describe('rateLimitLogin', () => {
  it('allows up to 10 attempts and rejects the 11th with 429 rate_limited', async () => {
    const config = testConfig();
    const rateLimiter = new MemoryRateLimiter();
    const app = buildApp(config, (a) => {
      a.use('/api/auth/login', rateLimitLogin(config, rateLimiter));
      a.post('/api/auth/login', (c) => c.json({ ok: true }));
    });

    for (let i = 0; i < 10; i++) {
      const res = await app.request('/api/auth/login', { method: 'POST' });
      expect(res.status).toBe(200);
      expect(res.headers.get('RateLimit-Remaining')).toBe((9 - i).toString());
    }

    const blocked = await app.request('/api/auth/login', { method: 'POST' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeDefined();
    expect(blocked.headers.get('RateLimit-Remaining')).toBe('0');
    const body = (await blocked.json()) as { code: string };
    expect(body.code).toBe('rate_limited');
  });

  it('bounds memory by evicting when many distinct keys arrive', async () => {
    const limiter = new MemoryRateLimiter(undefined, { maxKeys: 100 });
    for (let i = 0; i < 1_000; i++) {
      await limiter.check(`k:${i}`, 10, 60);
    }
    expect(limiter.size()).toBeLessThanOrEqual(100);
  });

  it('keys an unknown-IP client by user agent instead of collapsing all clients', async () => {
    const config = testConfig();
    const limiter = new MemoryRateLimiter();
    const app = buildApp(config, (a) => {
      a.use('/api/auth/login', rateLimitLogin(config, limiter));
      a.post('/api/auth/login', (c) => c.json({ ok: true }));
    });

    // No connection info in the test runtime → clientIp is null.
    const alice = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'User-Agent': 'alice-browser' },
    });
    const bob = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'User-Agent': 'bob-browser' },
    });
    expect(alice.status).toBe(200);
    expect(bob.status).toBe(200);
    expect(bob.headers.get('RateLimit-Remaining')).toBe('9');
  });
});

describe('rateLimit (general buckets)', () => {
  it('emits RateLimit headers and blocks past the configured limit', async () => {
    const config = testConfig();
    const limiter = new MemoryRateLimiter();
    const app = buildApp(config, (a) => {
      a.use(
        '/api/*',
        rateLimit(config, limiter, {
          name: 'test',
          scope: 'ip',
          limit: 2,
          windowSeconds: 60,
        }),
      );
      a.get('/api/thing', (c) => c.json({ ok: true }));
    });

    const first = await app.request('/api/thing');
    expect(first.status).toBe(200);
    expect(first.headers.get('RateLimit-Limit')).toBe('2');
    expect(first.headers.get('RateLimit-Remaining')).toBe('1');
    expect(Number(first.headers.get('RateLimit-Reset'))).toBeGreaterThan(0);

    expect((await app.request('/api/thing')).status).toBe(200);

    const blocked = await app.request('/api/thing');
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeDefined();
    expect(blocked.headers.get('RateLimit-Remaining')).toBe('0');
  });

  it('uses a custom message and never leaks the bucket key', async () => {
    const config = testConfig();
    const limiter = new MemoryRateLimiter();
    const app = buildApp(config, (a) => {
      a.use(
        '/api/*',
        rateLimit(config, limiter, {
          name: 'upload',
          scope: 'ip',
          limit: 1,
          windowSeconds: 60,
          message: 'Too many uploads. Try again shortly.',
        }),
      );
      a.get('/api/thing', (c) => c.json({ ok: true }));
    });

    await app.request('/api/thing');
    const blocked = await app.request('/api/thing');
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { code: string };
    expect(body.code).toBe('rate_limited');
  });

  it('keys user-scoped buckets by user id, so one user cannot exhaust another', async () => {
    const config = testConfig();
    const limiter = new MemoryRateLimiter();
    const app = buildApp(config, (a) => {
      a.use('/api/*', async (c, next) => {
        const user = (c.req.header('x-test-user') ?? 'u-1') as string;
        c.set('auth', {
          user: makeUser({ id: user }),
          session: {
            id: 'session-1',
            userId: user,
            createdAt: new Date(),
            lastSeenAt: new Date(),
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
            rotatedFrom: null,
          },
        });
        await next();
      });
      a.use(
        '/api/*',
        rateLimit(config, limiter, {
          name: 'generation',
          scope: 'user',
          limit: 1,
          windowSeconds: 60,
        }),
      );
      a.get('/api/thing', (c) => c.json({ ok: true }));
    });

    expect(
      (await app.request('/api/thing', { headers: { 'x-test-user': 'u-1' } })).status,
    ).toBe(200);
    expect(
      (await app.request('/api/thing', { headers: { 'x-test-user': 'u-1' } })).status,
    ).toBe(429);
    // A different user has its own bucket.
    expect(
      (await app.request('/api/thing', { headers: { 'x-test-user': 'u-2' } })).status,
    ).toBe(200);
  });

  it('userRateLimit derives its limit from RATE_LIMIT_USER_REQUESTS', async () => {
    const config = testConfig({ RATE_LIMIT_USER_REQUESTS: '7' });
    const limiter = new MemoryRateLimiter();
    const app = buildApp(config, (a) => {
      a.use('/api/*', userRateLimit(config, limiter));
      a.get('/api/thing', (c) => c.json({ ok: true }));
    });

    const res = await app.request('/api/thing');
    expect(res.status).toBe(200);
    expect(res.headers.get('RateLimit-Limit')).toBe('7');
  });
});
