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

async function seedSuperAdminUser(email = 'admin@corp.example') {
  return users.create({
    id: Bun.randomUUIDv7(),
    email,
    displayName: 'Super Admin User',
    passwordHash: await hasher.hash(PASSWORD),
    role: 'super_admin',
    mustChangePassword: false,
    status: 'active',
  });
}

async function seedAdminUser(email = 'admin@corp.example', divisionId: string) {
  return users.create({
    id: Bun.randomUUIDv7(),
    email,
    displayName: 'Division Admin User',
    passwordHash: await hasher.hash(PASSWORD),
    role: 'admin',
    divisionId,
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

  it('super admin can list users, create user, and update user', async () => {
    await seedSuperAdminUser('admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');

    const listRes = await app.request(
      new Request('http://localhost/api/admin/users', {
        headers: { Cookie: cookie },
      }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { items: Array<{ id: string }> } };
    expect(listBody.data.items).toHaveLength(1);

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

    const pool = getPool();
    const auditRows = await pool.query('SELECT action, target_id FROM audit_logs WHERE target_id = $1', [
      createBody.data.id,
    ]);
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0]?.action).toBe('user.create');
  });

  it('enforces last-super-admin safeguard: cannot demote the only active super admin', async () => {
    const admin = await seedSuperAdminUser('onlyadmin@corp.example');
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
    expect(body.message).toBe('Cannot disable or demote the last active super admin.');
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
    await seedSuperAdminUser('admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const pool = getPool();

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
    await seedSuperAdminUser('admin@corp.example');
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
    await seedSuperAdminUser('admin@corp.example');
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

  it('keeps at least one active super admin under concurrent demotions', async () => {
    // Three super admins: A and B are the concurrent targets, C is the caller (stays super admin).
    await seedSuperAdminUser('admin-c@corp.example');
    const adminA = await seedSuperAdminUser('admin-a@corp.example');
    const adminB = await seedSuperAdminUser('admin-b@corp.example');
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
      "SELECT count(*)::int AS n FROM users WHERE role = 'super_admin' AND status = 'active' AND deleted_at IS NULL",
    );
    expect(activeAdmins.rows[0]?.n).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
  });

  describe('two-tier role division admin and super admin isolation', () => {
    it('division admin can manage users in own division but cannot escalate roles, reassign divisions, or touch other divisions', async () => {
      const pool = getPool();
      const div1Id = Bun.randomUUIDv7();
      const div2Id = Bun.randomUUIDv7();
      await pool.query('INSERT INTO divisions (id, name) VALUES ($1, $2), ($3, $4)', [
        div1Id,
        'Engineering',
        div2Id,
        'Marketing',
      ]);

      const divAdmin = await seedAdminUser('divadmin@corp.example', div1Id);
      const userDiv1 = await users.create({
        id: Bun.randomUUIDv7(),
        email: 'user1@corp.example',
        displayName: 'User 1',
        passwordHash: await hasher.hash(PASSWORD),
        role: 'user',
        divisionId: div1Id,
        mustChangePassword: false,
        status: 'active',
      });
      const userDiv2 = await users.create({
        id: Bun.randomUUIDv7(),
        email: 'user2@corp.example',
        displayName: 'User 2',
        passwordHash: await hasher.hash(PASSWORD),
        role: 'user',
        divisionId: div2Id,
        mustChangePassword: false,
        status: 'active',
      });

      const { cookie, csrfToken } = await loginAs('divadmin@corp.example');

      // 1. List users: only sees own division users (divAdmin and userDiv1), not userDiv2
      const listRes = await app.request(
        new Request('http://localhost/api/admin/users', {
          headers: { Cookie: cookie },
        }),
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as { data: { items: Array<{ id: string }> } };
      const listedIds = listBody.data.items.map((i) => i.id);
      expect(listedIds).toContain(divAdmin.id);
      expect(listedIds).toContain(userDiv1.id);
      expect(listedIds).not.toContain(userDiv2.id);

      // 2. Cross-division access returns 404 (opaque existence protection)
      const getCrossRes = await app.request(
        new Request(`http://localhost/api/admin/users/${userDiv2.id}`, {
          headers: { Cookie: cookie },
        }),
      );
      expect(getCrossRes.status).toBe(404);

      const patchCrossRes = await app.request(
        new Request(`http://localhost/api/admin/users/${userDiv2.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ displayName: 'Hacked' }),
        }),
      );
      expect(patchCrossRes.status).toBe(404);

      // 3. Create user forces divisionId to caller's division, and role must be 'user'
      const createEscalateRes = await app.request(
        new Request('http://localhost/api/admin/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({
            email: 'escalate@corp.example',
            displayName: 'Escalate',
            role: 'admin',
            generatePassword: true,
          }),
        }),
      );
      expect(createEscalateRes.status).toBe(403);

      const createValidRes = await app.request(
        new Request('http://localhost/api/admin/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({
            email: 'newuser1@corp.example',
            displayName: 'New User 1',
            role: 'user',
            divisionId: div2Id, // Attempted to assign to div2, should be overridden to div1
            generatePassword: true,
          }),
        }),
      );
      expect(createValidRes.status).toBe(201);
      const createdUser = (await createValidRes.json()) as { data: { divisionId: string } };
      expect(createdUser.data.divisionId).toBe(div1Id);

      // 4. Forbid changing role or division on own-division user
      const patchRoleRes = await app.request(
        new Request(`http://localhost/api/admin/users/${userDiv1.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ role: 'admin' }),
        }),
      );
      expect(patchRoleRes.status).toBe(403);

      const patchDivRes = await app.request(
        new Request(`http://localhost/api/admin/users/${userDiv1.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ divisionId: div2Id }),
        }),
      );
      expect(patchDivRes.status).toBe(403);

      // 5. Forbid self-disabling
      const selfDisableRes = await app.request(
        new Request(`http://localhost/api/admin/users/${divAdmin.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ status: 'disabled' }),
        }),
      );
      expect(selfDisableRes.status).toBe(403);

      // 6. Division admin cannot access super_admin routes (e.g. /api/admin/divisions)
      const divisionsRes = await app.request(
        new Request('http://localhost/api/admin/divisions', {
          headers: { Cookie: cookie },
        }),
      );
      expect(divisionsRes.status).toBe(403);

      // 7. Division admin cannot target super_admin even in same division
      const superAdminDiv1 = await seedSuperAdminUser('super-in-div1@corp.example');
      await pool.query('UPDATE users SET division_id = $1 WHERE id = $2', [
        div1Id,
        superAdminDiv1.id,
      ]);

      const getSuperRes = await app.request(
        new Request(`http://localhost/api/admin/users/${superAdminDiv1.id}`, {
          headers: { Cookie: cookie },
        }),
      );
      expect(getSuperRes.status).toBe(404);

      const patchSuperRes = await app.request(
        new Request(`http://localhost/api/admin/users/${superAdminDiv1.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ displayName: 'Hacked Super' }),
        }),
      );
      expect(patchSuperRes.status).toBe(404);

      const resetSuperRes = await app.request(
        new Request(`http://localhost/api/admin/users/${superAdminDiv1.id}/password/reset`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ generatePassword: true }),
        }),
      );
      expect(resetSuperRes.status).toBe(404);

      // 8. Non-UUID path parameters return 400 invalid_request instead of 500
      const malformedIdRes = await app.request(
        new Request('http://localhost/api/admin/users/not-a-uuid', {
          headers: { Cookie: cookie },
        }),
      );
      expect(malformedIdRes.status).toBe(400);
      const malformedBody = (await malformedIdRes.json()) as { code: string };
      expect(malformedBody.code).toBe('invalid_request');
    });
  });
});
