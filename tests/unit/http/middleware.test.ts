import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../../src/config/index.ts';
import { loadConfig } from '../../../src/config/index.ts';
import { issueCsrfToken } from '../../../src/csrf.ts';
import { AppError, isAppError } from '../../../src/errors.ts';
import { cors, isAllowedOrigin } from '../../../src/http/middleware/cors.ts';
import { requireAuth } from '../../../src/http/middleware/require-auth.ts';
import { requireCsrf, enforceOrigin } from '../../../src/http/middleware/require-csrf.ts';
import { requirePasswordChanged } from '../../../src/http/middleware/require-password-changed.ts';
import type { AppEnv } from '../../../src/http/types.ts';
import type { AuthService } from '../../../src/auth/application/auth-service.ts';
import { makeUser } from '../auth/fakes.ts';

const ORIGIN = 'https://app.corp.example';
const SECRET = 'a'.repeat(48);

function testConfig(overrides: Record<string, unknown> = {}): Config {
  return loadConfig({
    DATABASE_URL: 'postgresql://x:y@127.0.0.1:5432/aichat_test',
    SESSION_SECRET: SECRET,
    ALLOWED_ORIGINS: ORIGIN,
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

  it('reports allowed origins precisely', () => {
    const config = testConfig();
    expect(isAllowedOrigin(config, ORIGIN)).toBe(true);
    expect(isAllowedOrigin(config, 'https://app.corp.example.evil.com')).toBe(false);
    expect(isAllowedOrigin(config, undefined)).toBe(false);
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
  it('allows a mutation with no Origin (same-origin fetch)', async () => {
    const config = testConfig();
    const app = buildApp(config, (a) => {
      a.use('/api/*', enforceOrigin(config));
      a.post('/api/thing', (c) => c.json({ ok: true }));
    });
    const res = await app.request('/api/thing', { method: 'POST' });
    expect(res.status).toBe(200);
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
