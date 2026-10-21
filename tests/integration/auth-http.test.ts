import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '@/app.ts';
import { createServices } from '@/services.ts';
import { loadConfig, type Config } from '@/config/index.ts';
import { closePool, getPool } from '@/db/index.ts';
import { onError } from '@/http/error-handler.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requirePasswordChanged } from '@/http/middleware/require-password-changed.ts';
import type { AppEnv } from '@/http/types.ts';
import { BunPasswordHasher } from '@/auth/infrastructure/bun-password-hasher.ts';
import { DrizzleUserRepository } from '@/auth/infrastructure/drizzle-user-repository.ts';
import { resetDatabase } from './helpers/reset.ts';

const SECRET = 'integration-session-secret-0123456789abcdef';
const ORIGIN = 'https://app.corp.example';

const config: Config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  NODE_ENV: 'test',
  SESSION_SECRET: SECRET,
  ALLOWED_ORIGINS: ORIGIN,
  LOG_LEVEL: 'silent',
});

const services = createServices(config);
const app = createApp(config, services);
const users = new DrizzleUserRepository();
const hasher = new BunPasswordHasher();
const PASSWORD = 'correct horse battery staple';

async function seedUser(options: { mustChangePassword?: boolean; status?: 'active' | 'disabled' } = {}) {
  return users.create({
    id: Bun.randomUUIDv7(),
    email: 'ada@corp.example',
    displayName: 'Ada L.',
    passwordHash: await hasher.hash(PASSWORD),
    role: 'user',
    mustChangePassword: options.mustChangePassword ?? false,
    status: options.status ?? 'active',
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

/** Extracts the `__Host-session` cookie pair from a response, if set. */
function sessionCookie(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) return null;
  const match = /__Host-session=([^;]*)/.exec(setCookie);
  return match === null ? null : `__Host-session=${match[1]}`;
}

async function login(mustChangePassword = false): Promise<{ cookie: string; csrfToken: string; userId: string }> {
  await seedUser({ mustChangePassword });
  const res = await app.request(
    post('/api/auth/login', { email: 'ada@corp.example', password: PASSWORD }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { user: { id: string }; csrfToken: string };
  };
  const cookie = sessionCookie(res);
  expect(cookie).not.toBeNull();
  return { cookie: cookie as string, csrfToken: body.data.csrfToken, userId: body.data.user.id };
}

describe('auth HTTP surface (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
    (services.rateLimiter as import('@/http/infrastructure/memory-rate-limiter.ts').MemoryRateLimiter).clear();
  });

  afterAll(async () => {
    await closePool();
  });

  it('logs in: sets the cookie, returns the envelope and a CSRF token', async () => {
    await seedUser();
    const res = await app.request(
      post('/api/auth/login', { email: 'ada@corp.example', password: PASSWORD }),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');

    const body = (await res.json()) as {
      status: string;
      data: { user: { email: string }; csrfToken: string };
    };
    expect(body.status).toBe('ok');
    expect(body.data.user.email).toBe('ada@corp.example');
    expect(body.data.csrfToken.split('.')).toHaveLength(3);
    // The password hash must never cross the wire.
    expect(JSON.stringify(body)).not.toContain('$argon2');
  });

  it('bootstraps: login succeeds without a CSRF token but rejects a bad origin', async () => {
    await seedUser();
    // No token is available before the first login — it is issued by this call.
    const ok = await app.request(
      post('/api/auth/login', { email: 'ada@corp.example', password: PASSWORD }),
    );
    expect(ok.status).toBe(200);

    // The origin check still applies, so a cross-site login attempt is refused.
    const rejected = await app.request(
      post('/api/auth/login', { email: 'ada@corp.example', password: PASSWORD }, { Origin: 'https://evil.example' }),
    );
    expect(rejected.status).toBe(403);
  });

  it('returns a generic 401 for bad credentials', async () => {
    await seedUser();
    const res = await app.request(
      post('/api/auth/login', { email: 'ada@corp.example', password: 'wrong-password' }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('unauthenticated');
    expect(body.message).toBe('Invalid email or password.');
  });

  it('validates the login body (400 with field details)', async () => {
    const res = await app.request(
      post('/api/auth/login', { email: 'not-an-email', password: '' }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; details?: { fields?: unknown[] } };
    expect(body.code).toBe('invalid_request');
    expect(body.details?.fields?.length).toBeGreaterThan(0);
  });

  it('serves /api/me only with a valid cookie', async () => {
    const { cookie, userId } = await login();

    const anonymous = await app.request('http://localhost/api/me');
    expect(anonymous.status).toBe(401);

    const me = await app.request(
      new Request('http://localhost/api/me', { headers: { Cookie: cookie } }),
    );
    expect(me.status).toBe(200);
    const body = (await me.json()) as { data: { id: string; createdAt: string; csrfToken: string } };
    expect(body.data.id).toBe(userId);
    expect(typeof body.data.createdAt).toBe('string');
    expect(typeof body.data.csrfToken).toBe('string');
    expect(body.data.csrfToken.length).toBeGreaterThan(16);

    const csrfRes = await app.request(
      new Request('http://localhost/api/auth/csrf', { headers: { Cookie: cookie } }),
    );
    expect(csrfRes.status).toBe(200);
    const csrfBody = (await csrfRes.json()) as { data: { csrfToken: string } };
    expect(typeof csrfBody.data.csrfToken).toBe('string');
    expect(csrfBody.data.csrfToken.length).toBeGreaterThan(16);
  });

  it('blocks gated endpoints while a password change is required (gate)', async () => {
    const { cookie, csrfToken } = await login(true);

    // /api/me stays reachable so the SPA can learn about the gate.
    const me = await app.request(
      new Request('http://localhost/api/me', { headers: { Cookie: cookie } }),
    );
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { data: { mustChangePassword: boolean } };
    expect(meBody.data.mustChangePassword).toBe(true);

    // A representative gated route wired exactly as future feature routers will be:
    // requireAuth → requirePasswordChanged. This proves the gate yields 403, not 401.
    const gatedApp = new Hono<AppEnv>();
    gatedApp.onError(onError(config));
    gatedApp.use('/api/*', requireAuth(services.auth, config));
    gatedApp.use('/api/*', requirePasswordChanged());
    gatedApp.get('/api/conversations', (c) => c.json({ ok: true }));

    const blocked = await gatedApp.request(
      new Request('http://localhost/api/conversations', { headers: { Cookie: cookie } }),
    );
    expect(blocked.status).toBe(403);
    const blockedBody = (await blocked.json()) as { code: string; retryable: boolean };
    expect(blockedBody.code).toBe('password_change_required');
    expect(blockedBody.retryable).toBe(false);

    const changed = await app.request(
      new Request('http://localhost/api/me/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'a brand new passphrase' }),
      }),
    );
    expect(changed.status).toBe(200);
    const rotated = sessionCookie(changed) as string;
    const allowed = await gatedApp.request(
      new Request('http://localhost/api/conversations', { headers: { Cookie: rotated } }),
    );
    expect(allowed.status).toBe(200);
  });

  it('changes the password: rotates the cookie, re-issues CSRF, clears the gate', async () => {
    const { cookie, csrfToken } = await login(true);

    const res = await app.request(
      new Request('http://localhost/api/me/password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          currentPassword: PASSWORD,
          newPassword: 'a brand new passphrase',
        }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: string; data: { csrfToken: string } };
    expect(body.message).toBe('Password updated.');
    expect(body.data.csrfToken).not.toBe(csrfToken);

    const rotated = sessionCookie(res);
    expect(rotated).not.toBeNull();
    expect(rotated).not.toBe(cookie);

    const me = await app.request(
      new Request('http://localhost/api/me', { headers: { Cookie: rotated as string } }),
    );
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { data: { mustChangePassword: boolean } };
    expect(meBody.data.mustChangePassword).toBe(false);

    const stale = await app.request(
      new Request('http://localhost/api/me', { headers: { Cookie: cookie } }),
    );
    expect(stale.status).toBe(401);

    const relogin = await app.request(
      post('/api/auth/login', { email: 'ada@corp.example', password: 'a brand new passphrase' }),
    );
    expect(relogin.status).toBe(200);
  });

  it('logs out: revokes the session and clears the cookie', async () => {
    const { cookie, csrfToken } = await login();

    const res = await app.request(
      new Request('http://localhost/api/auth/session', {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      }),
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-session=');
    expect(setCookie.toLowerCase()).toContain('max-age=0');

    const after = await app.request(
      new Request('http://localhost/api/me', { headers: { Cookie: cookie } }),
    );
    expect(after.status).toBe(401);
  });

  it('revokes immediately when the user is disabled', async () => {
    const { cookie, userId } = await login();
    await getPool().query('UPDATE users SET status = $1 WHERE id = $2', ['disabled', userId]);

    const res = await app.request(
      new Request('http://localhost/api/me', { headers: { Cookie: cookie } }),
    );
    expect(res.status).toBe(401);

    const { rows } = await getPool().query<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM sessions WHERE user_id = $1',
      [userId],
    );
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it('answers CORS preflight on the API tree', async () => {
    const res = await app.request(
      new Request('http://localhost/api/auth/login', {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Max-Age')).toBe('600');
  });
});
