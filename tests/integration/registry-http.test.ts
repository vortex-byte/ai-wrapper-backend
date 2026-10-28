import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '@/app.ts';
import { createServices, type Services } from '@/services.ts';
import { BunPasswordHasher } from '@/auth/infrastructure/bun-password-hasher.ts';
import { DrizzleUserRepository } from '@/auth/infrastructure/drizzle-user-repository.ts';
import { loadConfig, type Config } from '@/config/index.ts';
import { closePool, getPool } from '@/db/index.ts';
import type { MemoryRateLimiter } from '@/http/infrastructure/memory-rate-limiter.ts';
import { resetDatabase } from './helpers/reset.ts';

const SECRET = 'integration-session-secret-0123456789abcdef';
const ORIGIN = 'https://app.corp.example';
const PASSWORD = 'correct horse battery staple';

const config: Config = loadConfig({
  DATABASE_URL: process.env.DATABASE_URL ?? '',
  NODE_ENV: 'test',
  SESSION_SECRET: SECRET,
  ALLOWED_ORIGINS: ORIGIN,
  LOG_LEVEL: 'silent',
});

const services: Services = createServices(config);
const app = createApp(config, services);
const users = new DrizzleUserRepository();
const hasher = new BunPasswordHasher();

async function seedUser(role: 'super_admin' | 'admin' | 'user', email: string) {
  return users.create({
    id: Bun.randomUUIDv7(),
    email,
    displayName: `${role} user`,
    passwordHash: await hasher.hash(PASSWORD),
    role,
    mustChangePassword: false,
    status: 'active',
  });
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
  const body = (await res.json()) as { data: { csrfToken: string } };
  const setCookie = res.headers.get('set-cookie');
  const match = setCookie === null ? null : /__Host-session=([^;]*)/.exec(setCookie);
  if (match === null) throw new Error('no session cookie issued');
  return { cookie: `__Host-session=${match[1]}`, csrfToken: body.data.csrfToken };
}

const CAPABILITIES = {
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
  vision: true,
  documents: { pdf: true },
};

async function createProvider(cookie: string, csrfToken: string, key = 'openai-main') {
  const res = await app.request(
    new Request('http://localhost/api/admin/providers', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        key,
        displayName: 'OpenAI (main)',
        adapter: 'openai',
        secretRef: 'OPENAI_API_KEY',
        status: 'active',
      }),
    }),
  );
  return res;
}

async function createModel(
  cookie: string,
  csrfToken: string,
  providerId: string,
  overrides: Record<string, unknown> = {},
) {
  const res = await app.request(
    new Request('http://localhost/api/admin/models', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        providerId,
        key: 'gpt-4o',
        apiModelId: 'gpt-4o-2024-08-06',
        displayName: 'GPT-4o',
        status: 'active',
        capabilities: CAPABILITIES,
        ...overrides,
      }),
    }),
  );
  return res;
}

describe('registry admin HTTP surface (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
    (services.rateLimiter as MemoryRateLimiter).clear();
    // The cached registry lives across tests; drop its snapshot so each test re-reads.
    services.registry.invalidate();
  });

  afterAll(async () => {
    await closePool();
  });

  it('rejects a standard user with 403 forbidden', async () => {
    await seedUser('user', 'plain@corp.example');
    const { cookie } = await loginAs('plain@corp.example');
    const res = await app.request(
      new Request('http://localhost/api/admin/providers', { headers: { Cookie: cookie } }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects a division admin with 403 forbidden', async () => {
    const divId = Bun.randomUUIDv7();
    const pool = getPool();
    await pool.query('INSERT INTO divisions (id, name) VALUES ($1, $2)', [divId, 'Providers Div']);
    await users.create({
      id: Bun.randomUUIDv7(),
      email: 'divadmin@corp.example',
      displayName: 'Div Admin',
      passwordHash: await hasher.hash(PASSWORD),
      role: 'admin',
      divisionId: divId,
      mustChangePassword: false,
      status: 'active',
    });
    const { cookie } = await loginAs('divadmin@corp.example');
    const res = await app.request(
      new Request('http://localhost/api/admin/providers', { headers: { Cookie: cookie } }),
    );
    expect(res.status).toBe(403);
  });

  it('requires a CSRF token on POST', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie } = await loginAs('admin@corp.example');
    const res = await app.request(
      new Request('http://localhost/api/admin/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookie },
        body: JSON.stringify({
          key: 'x',
          displayName: 'X',
          adapter: 'openai',
          secretRef: 'X_KEY',
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('creates and lists a provider; never echoes key material', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');

    const created = await createProvider(cookie, csrfToken);
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      data: { id: string; secretRef: string; status: string };
    };
    expect(createdBody.data.secretRef).toBe('OPENAI_API_KEY');
    expect(createdBody.data.status).toBe('active');
    expect(JSON.stringify(createdBody)).not.toContain('sk-');

    const list = await app.request(
      new Request('http://localhost/api/admin/providers', { headers: { Cookie: cookie } }),
    );
    const listBody = (await list.json()) as { data: { items: Array<{ id: string }> } };
    expect(listBody.data.items).toHaveLength(1);
  });

  it('rejects an unknown adapter with 400 invalid_request', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const res = await app.request(
      new Request('http://localhost/api/admin/providers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          key: 'odd',
          displayName: 'Odd',
          adapter: 'not-a-real-adapter',
          secretRef: 'ODD_KEY',
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate provider key with 409 conflict', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    expect((await createProvider(cookie, csrfToken)).status).toBe(201);
    const dup = await createProvider(cookie, csrfToken);
    expect(dup.status).toBe(409);
  });

  it('writes an audit row for each mutation', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    await createProvider(cookie, csrfToken);

    const { rows } = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_logs ORDER BY id`,
    );
    expect(rows.map((row) => row.action)).toContain('provider.create');
  });

  it('creates a model and exposes it on GET /api/models with wire shape', async () => {
    const admin = await seedUser('super_admin', 'admin@corp.example');
    void admin;
    const { cookie, csrfToken } = await loginAs('admin@corp.example');

    const providerRes = await createProvider(cookie, csrfToken);
    const providerId = ((await providerRes.json()) as { data: { id: string } }).data.id;

    const modelRes = await createModel(cookie, csrfToken, providerId);
    expect(modelRes.status).toBe(201);

    const publicRes = await app.request(
      new Request('http://localhost/api/models', { headers: { Cookie: cookie } }),
    );
    expect(publicRes.status).toBe(200);
    const publicBody = (await publicRes.json()) as {
      data: {
        items: Array<{
          id: string;
          displayName: string;
          providerLabel: string;
          status: string;
          capabilities: unknown;
          limits: { maxImagesPerMessage: number };
        }>;
      };
    };
    expect(publicBody.data.items).toHaveLength(1);
    const item = publicBody.data.items[0]!;
    expect(item.displayName).toBe('GPT-4o');
    expect(item.providerLabel).toBe('OpenAI (main)');
    expect(item.status).toBe('active');
    expect(item.limits.maxImagesPerMessage).toBe(10);
    // Public shape must not leak the provider id or any config blob.
    expect(Object.keys(item)).not.toContain('providerId');
    expect(JSON.stringify(item)).not.toContain('secretRef');
  });

  it('hides a disabled model from GET /api/models', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const providerRes = await createProvider(cookie, csrfToken);
    const providerId = ((await providerRes.json()) as { data: { id: string } }).data.id;
    const modelRes = await createModel(cookie, csrfToken, providerId);
    const modelId = ((await modelRes.json()) as { data: { id: string } }).data.id;

    const disable = await app.request(
      new Request(`http://localhost/api/admin/models/${modelId}`, {
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
    expect(disable.status).toBe(200);

    const publicRes = await app.request(
      new Request('http://localhost/api/models', { headers: { Cookie: cookie } }),
    );
    const publicBody = (await publicRes.json()) as { data: { items: unknown[] } };
    expect(publicBody.data.items).toHaveLength(0);
  });

  it('keeps documents.pdf when a patch only changes documents.maxPages', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const providerRes = await createProvider(cookie, csrfToken);
    const providerId = ((await providerRes.json()) as { data: { id: string } }).data.id;
    const modelRes = await createModel(cookie, csrfToken, providerId);
    const modelId = ((await modelRes.json()) as { data: { id: string } }).data.id;

    const patch = await app.request(
      new Request(`http://localhost/api/admin/models/${modelId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ capabilities: { documents: { maxPages: 40 } } }),
      }),
    );
    expect(patch.status).toBe(200);

    const body = (await patch.json()) as {
      data: { capabilities: { documents: { pdf: boolean; maxPages?: number } } };
    };
    expect(body.data.capabilities.documents.pdf).toBe(true);
    expect(body.data.capabilities.documents.maxPages).toBe(40);
  });
});
