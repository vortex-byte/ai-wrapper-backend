import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '@/app.ts';
import { createServices } from '@/services.ts';
import { BunPasswordHasher } from '@/auth/infrastructure/bun-password-hasher.ts';
import { DrizzleUserRepository } from '@/auth/infrastructure/drizzle-user-repository.ts';
import { loadConfig, type Config } from '@/config/index.ts';
import { closePool, getPool } from '@/db/index.ts';
import type { MemoryRateLimiter } from '@/http/infrastructure/memory-rate-limiter.ts';
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

async function seedUser(role: 'user' | 'admin' | 'super_admin', email: string): Promise<string> {
  let divisionId: string | undefined;
  if (role === 'admin') {
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO divisions (id, name) VALUES ($1, $2) RETURNING id`,
      [Bun.randomUUIDv7(), `Division ${email}`],
    );
    divisionId = result.rows[0]?.id;
  }

  const user = await users.create({
    id: Bun.randomUUIDv7(),
    email,
    displayName: `User ${email}`,
    passwordHash: await hasher.hash(PASSWORD),
    role,
    ...(divisionId !== undefined ? { divisionId } : {}),
    mustChangePassword: false,
    status: 'active',
  });
  return user.id;
}

function extractSessionCookie(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) return null;
  const match = /__Host-session=([^;]*)/.exec(setCookie);
  return match === null ? null : `__Host-session=${match[1]}`;
}

async function loginAs(email: string): Promise<{ cookie: string; csrfToken: string }> {
  const res = await app.request(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  const cookie = extractSessionCookie(res);
  expect(cookie).not.toBeNull();
  const body = (await res.json()) as { data: { csrfToken: string } };
  return { cookie: cookie ?? '', csrfToken: body.data.csrfToken };
}

describe('admin settings HTTP surface (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
    (services.rateLimiter as MemoryRateLimiter).clear();
  });

  afterAll(async () => {
    await closePool();
  });

  it('restricts GET and PATCH to super_admin (user and admin get 403)', async () => {
    await seedUser('user', 'user@corp.example');
    await seedUser('admin', 'admin@corp.example');

    const userAuth = await loginAs('user@corp.example');
    const adminAuth = await loginAs('admin@corp.example');

    for (const auth of [userAuth, adminAuth]) {
      const getRes = await app.request(
        new Request('http://localhost/api/admin/settings', {
          method: 'GET',
          headers: { Cookie: auth.cookie, Origin: ORIGIN },
        }),
      );
      expect(getRes.status).toBe(403);

      const patchRes = await app.request(
        new Request('http://localhost/api/admin/settings', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Cookie: auth.cookie,
            'X-CSRF-Token': auth.csrfToken,
            Origin: ORIGIN,
          },
          body: JSON.stringify({ quotaTimezone: 'Asia/Makassar' }),
        }),
      );
      expect(patchRes.status).toBe(403);
    }
  });

  it('reads default settings when none have been customized', async () => {
    await seedUser('super_admin', 'root@corp.example');
    const { cookie } = await loginAs('root@corp.example');

    const res = await app.request(
      new Request('http://localhost/api/admin/settings', {
        method: 'GET',
        headers: { Cookie: cookie, Origin: ORIGIN },
      }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        systemPrompt: { value: string; version: number };
        quotaTimezone: { value: string };
        attachments: { value: { maxBytesPerFile: number; maxFilesPerRequest: number } };
        security: { value: { sessionIdleMinutes: number } };
      };
    };

    expect(body.data.quotaTimezone.value).toBe('Asia/Jakarta');
    expect(body.data.systemPrompt.value).toBe('');
    expect(body.data.attachments.value.maxFilesPerRequest).toBe(5);
    expect(body.data.security.value.sessionIdleMinutes).toBe(480);
  });

  it('validates invalid settings with 400', async () => {
    await seedUser('super_admin', 'root@corp.example');
    const { cookie, csrfToken } = await loginAs('root@corp.example');

    const res = await app.request(
      new Request('http://localhost/api/admin/settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
          Origin: ORIGIN,
        },
        body: JSON.stringify({ quotaTimezone: 'Invalid/Non_Existent_TZ' }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_request');
  });

  it('updates settings, records audit rows, and returns enriched updater info', async () => {
    const rootId = await seedUser('super_admin', 'root@corp.example');
    const { cookie, csrfToken } = await loginAs('root@corp.example');

    const patchRes = await app.request(
      new Request('http://localhost/api/admin/settings', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
          Origin: ORIGIN,
        },
        body: JSON.stringify({
          systemPrompt: 'You are Asta, an enterprise AI assistant.',
          quotaTimezone: 'Asia/Makassar',
          attachments: {
            maxBytesPerFile: 20 * 1024 * 1024,
            maxFilesPerRequest: 4,
            retentionHours: 48,
          },
          security: {
            sessionIdleMinutes: 240,
            loginMaxFailures: 5,
            loginLockoutMinutes: 30,
          },
        }),
      }),
    );
    expect(patchRes.status).toBe(200);

    const patchBody = (await patchRes.json()) as {
      data: {
        systemPrompt: {
          value: string;
          version: number;
          updatedBy: { id: string; displayName: string; email: string };
        };
        quotaTimezone: { value: string; version: number };
        attachments: { value: { maxFilesPerRequest: number }; version: number };
        security: { value: { sessionIdleMinutes: number }; version: number };
      };
    };

    expect(patchBody.data.systemPrompt.value).toBe('You are Asta, an enterprise AI assistant.');
    expect(patchBody.data.systemPrompt.version).toBe(1);
    expect(patchBody.data.systemPrompt.updatedBy).toEqual({
      id: rootId,
      displayName: 'User root@corp.example',
      email: 'root@corp.example',
    });
    expect(patchBody.data.quotaTimezone.value).toBe('Asia/Makassar');
    expect(patchBody.data.attachments.value.maxFilesPerRequest).toBe(4);
    expect(patchBody.data.security.value.sessionIdleMinutes).toBe(240);

    // Verify audit log has settings.update events
    const auditRes = await app.request(
      new Request('http://localhost/api/admin/audit-logs?action=settings.update', {
        method: 'GET',
        headers: { Cookie: cookie, Origin: ORIGIN },
      }),
    );
    expect(auditRes.status).toBe(200);
    const auditBody = (await auditRes.json()) as {
      data: {
        items: Array<{
          action: string;
          targetType: string;
          targetId: string;
          actor: { id: string; email: string } | null;
        }>;
      };
    };
    expect(auditBody.data.items.length).toBeGreaterThanOrEqual(4);
    expect(auditBody.data.items[0]?.actor?.email).toBe('root@corp.example');
  });
});
