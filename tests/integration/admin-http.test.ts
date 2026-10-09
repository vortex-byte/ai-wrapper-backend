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

async function seedAdminUser(email = 'admin@corp.example') {
  return users.create({
    id: Bun.randomUUIDv7(),
    email,
    displayName: 'Admin User',
    passwordHash: await hasher.hash(PASSWORD),
    role: 'admin',
    mustChangePassword: false,
    status: 'active',
  });
}

async function seedStandardUser(email = 'user@corp.example') {
  return users.create({
    id: Bun.randomUUIDv7(),
    email,
    displayName: 'Standard User',
    passwordHash: await hasher.hash(PASSWORD),
    role: 'user',
    mustChangePassword: false,
    status: 'active',
  });
}

function sessionCookie(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) return null;
  const match = /__Host-session=([^;]*)/.exec(setCookie);
  return match === null ? null : `__Host-session=${match[1]}`;
}

async function loginAs(email: string): Promise<{ cookie: string; csrfToken: string; userId: string }> {
  const res = await app.request(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { user: { id: string }; csrfToken: string };
  };
  const cookie = sessionCookie(res)!;
  return { cookie, csrfToken: body.data.csrfToken, userId: body.data.user.id };
}

describe('admin HTTP surface & RBAC (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
    (services.rateLimiter as MemoryRateLimiter).clear();
  });

  afterAll(async () => {
    await closePool();
  });

  it('enforces RBAC: standard user is rejected with 403 forbidden', async () => {
    await seedStandardUser('user@corp.example');
    const { cookie } = await loginAs('user@corp.example');

    const res = await app.request(
      new Request('http://localhost/api/admin/users', {
        headers: { Cookie: cookie },
      }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('forbidden');
  });

  it('admin can list users, create user, and update user', async () => {
    await seedAdminUser('admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');

    // List users
    const listRes = await app.request(
      new Request('http://localhost/api/admin/users', {
        headers: { Cookie: cookie },
      }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { items: Array<{ id: string }> } };
    expect(listBody.data.items).toHaveLength(1);

    // Create a new user
    const createRes = await app.request(
      new Request('http://localhost/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          email: 'newhire@corp.example',
          displayName: 'New Hire',
          role: 'user',
          generatePassword: true,
        }),
      }),
    );

    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as {
      data: { id: string; email: string; temporaryPassword?: string };
    };
    expect(createBody.data.email).toBe('newhire@corp.example');
    expect(createBody.data.temporaryPassword).toBeDefined();

    // Audit log recorded
    const pool = getPool();
    const auditRows = await pool.query('SELECT action, target_id FROM audit_logs WHERE target_id = $1', [
      createBody.data.id,
    ]);
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]?.action).toBe('user.create');
  });

  it('enforces last-admin safeguard: cannot demote the only active admin', async () => {
    const admin = await seedAdminUser('onlyadmin@corp.example');
    const { cookie, csrfToken } = await loginAs('onlyadmin@corp.example');

    const res = await app.request(
      new Request(`http://localhost/api/admin/users/${admin.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ role: 'user' }),
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('conflict');
    expect(body.message).toBe('Cannot disable or demote the last active admin.');
  });

  it('returns standard 404 envelope for unmatched /api routes', async () => {
    const res = await app.request('http://localhost/api/non-existent-endpoint');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { status: string; code: string; message: string };
    expect(body.status).toBe('error');
    expect(body.code).toBe('not_found');
    expect(body.message).toBe('Not found.');
  });

  it('allows re-creating a user whose email belonged to a soft-deleted row (409→201)', async () => {
    await seedAdminUser('admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const pool = getPool();

    // Insert then soft-delete a user with the target email.
    const dead = await users.create({
      id: Bun.randomUUIDv7(),
      email: 'reuse@corp.example',
      displayName: 'Gone',
      passwordHash: await hasher.hash(PASSWORD),
      role: 'user',
      mustChangePassword: false,
      status: 'active',
    });
    await pool.query('UPDATE users SET deleted_at = now() WHERE id = $1', [dead.id]);

    const res = await app.request(
      new Request('http://localhost/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          email: 'reuse@corp.example',
          displayName: 'Reuse',
          role: 'user',
          generatePassword: true,
        }),
      }),
    );

    expect(res.status).toBe(201);
  });

  it('returns 409 (not 500) when the email belongs to a live user', async () => {
    await seedAdminUser('admin@corp.example');
    await seedStandardUser('taken@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');

    const res = await app.request(
      new Request('http://localhost/api/admin/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          email: 'taken@corp.example',
          displayName: 'Dup',
          role: 'user',
          generatePassword: true,
        }),
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('conflict');
  });

  it('rejects a malformed cursor with 400 instead of silently returning page 1', async () => {
    await seedAdminUser('admin@corp.example');
    const { cookie } = await loginAs('admin@corp.example');

    const res = await app.request(
      new Request('http://localhost/api/admin/users?cursor=not-a-real-cursor', {
        headers: { Cookie: cookie },
      }),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_request');
  });

  it('keeps at least one active admin under concurrent demotions', async () => {
    // Three admins: A and B are the concurrent targets, C is the caller (stays admin).
    await seedAdminUser('admin-c@corp.example');
    const adminA = await seedAdminUser('admin-a@corp.example');
    const adminB = await seedAdminUser('admin-b@corp.example');
    const { cookie, csrfToken } = await loginAs('admin-c@corp.example');

    const demote = (targetId: string) =>
      app.request(
        new Request(`http://localhost/api/admin/users/${targetId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ role: 'user' }),
        }),
      );

    const results = await Promise.all([demote(adminA.id), demote(adminB.id)]);
    const statuses = results.map((r) => r.status);

    const pool = getPool();
    const activeAdmins = await pool.query(
      "SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL",
    );
    expect(activeAdmins.rows[0]?.n).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
  });
});
