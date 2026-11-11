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

async function createProvider(
  cookie: string,
  csrfToken: string,
  key = 'openai-main',
  displayName = 'OpenAI (main)',
) {
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
        displayName,
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

async function readId(res: Response): Promise<string> {
  return ((await res.json()) as { data: { id: string } }).data.id;
}

interface WireModelRow {
  readonly id: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly kind: string;
  readonly status: string;
}

async function listModels(
  cookie: string,
  params: Record<string, string> = {},
): Promise<{
  res: Response;
  body: {
    status: string;
    code?: string;
    data: { items: WireModelRow[]; nextCursor: string | null };
  };
}> {
  const search = new URLSearchParams(params).toString();
  const res = await app.request(
    new Request(`http://localhost/api/admin/models${search === '' ? '' : `?${search}`}`, {
      headers: { Cookie: cookie },
    }),
  );
  const body = (await res.json()) as {
    status: string;
    code?: string;
    data: { items: WireModelRow[]; nextCursor: string | null };
  };
  return { res, body };
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

  it('deletes an unused provider and writes a provider.delete audit row', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const created = await createProvider(cookie, csrfToken);
    const providerId = ((await created.json()) as { data: { id: string } }).data.id;

    const res = await app.request(
      new Request(`http://localhost/api/admin/providers/${providerId}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; message: string; data?: unknown };
    expect(body.status).toBe('ok');
    expect(body.data).toBeUndefined();

    const list = await app.request(
      new Request('http://localhost/api/admin/providers', { headers: { Cookie: cookie } }),
    );
    const listBody = (await list.json()) as { data: { items: Array<{ id: string }> } };
    expect(listBody.data.items).toHaveLength(0);

    const { rows } = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_logs ORDER BY id`,
    );
    expect(rows.map((row) => row.action)).toContain('provider.delete');
  });

  it('refuses to delete a provider that still has models with 409 conflict', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const created = await createProvider(cookie, csrfToken);
    const providerId = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await createModel(cookie, csrfToken, providerId)).status).toBe(201);

    const res = await app.request(
      new Request(`http://localhost/api/admin/providers/${providerId}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('conflict');
  });

  it('returns 404 not_found when deleting an unknown provider', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const res = await app.request(
      new Request(`http://localhost/api/admin/providers/${Bun.randomUUIDv7()}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('deletes an unused model and writes a model.delete audit row', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const createdProvider = await createProvider(cookie, csrfToken);
    const providerId = ((await createdProvider.json()) as { data: { id: string } }).data.id;
    const createdModel = await createModel(cookie, csrfToken, providerId);
    const modelId = ((await createdModel.json()) as { data: { id: string } }).data.id;

    const res = await app.request(
      new Request(`http://localhost/api/admin/models/${modelId}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; message: string; data?: unknown };
    expect(body.status).toBe('ok');
    expect(body.data).toBeUndefined();

    const list = await app.request(
      new Request('http://localhost/api/admin/models', { headers: { Cookie: cookie } }),
    );
    const listBody = (await list.json()) as { data: { items: Array<{ id: string }> } };
    expect(listBody.data.items).toHaveLength(0);

    const { rows } = await getPool().query<{ action: string }>(
      `SELECT action FROM audit_logs ORDER BY id`,
    );
    expect(rows.map((row) => row.action)).toContain('model.delete');
  });

  it('filters the model list by provider, kind, and status', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');

    const openaiId = await readId(await createProvider(cookie, csrfToken, 'openai-main', 'OpenAI'));
    const anthropicId = await readId(
      await createProvider(cookie, csrfToken, 'anthropic-main', 'Anthropic'),
    );

    await createModel(cookie, csrfToken, openaiId, {
      apiModelId: 'gpt-4o',
      displayName: 'GPT-4o',
    });
    await createModel(cookie, csrfToken, openaiId, {
      apiModelId: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
      status: 'disabled',
    });
    await createModel(cookie, csrfToken, anthropicId, {
      apiModelId: 'dall-e-3',
      displayName: 'DALL-E 3',
      config: { kind: 'image' },
    });

    const byProvider = await listModels(cookie, { providerId: openaiId });
    expect(byProvider.body.data.items).toHaveLength(2);
    expect(byProvider.body.data.items.every((model) => model.providerId === openaiId)).toBe(true);

    const images = await listModels(cookie, { kind: 'image' });
    expect(images.body.data.items.map((model) => model.displayName)).toEqual(['DALL-E 3']);

    const chats = await listModels(cookie, { kind: 'chat' });
    expect(chats.body.data.items).toHaveLength(2);

    const disabled = await listModels(cookie, { status: 'disabled' });
    expect(disabled.body.data.items.map((model) => model.displayName)).toEqual(['GPT-4o mini']);

    const combined = await listModels(cookie, {
      providerId: openaiId,
      kind: 'chat',
      status: 'active',
    });
    expect(combined.body.data.items.map((model) => model.displayName)).toEqual(['GPT-4o']);
  });

  it('searches the model list across display name, api id, and provider', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');

    const openaiId = await readId(await createProvider(cookie, csrfToken, 'openai-main', 'OpenAI'));
    const anthropicId = await readId(
      await createProvider(cookie, csrfToken, 'anthropic-main', 'Anthropic'),
    );
    await createModel(cookie, csrfToken, openaiId, {
      apiModelId: 'gpt-4o',
      displayName: 'GPT-4o',
    });
    await createModel(cookie, csrfToken, openaiId, {
      apiModelId: 'gpt-4o-mini',
      displayName: 'GPT-4o mini',
    });
    await createModel(cookie, csrfToken, anthropicId, {
      apiModelId: 'dall-e-3',
      displayName: 'DALL-E 3',
    });

    const byProvider = await listModels(cookie, { query: 'anthro' });
    expect(byProvider.body.data.items.map((model) => model.displayName)).toEqual(['DALL-E 3']);

    const byDisplayName = await listModels(cookie, { query: 'mini' });
    expect(byDisplayName.body.data.items.map((model) => model.displayName)).toEqual(['GPT-4o mini']);

    const byApiId = await listModels(cookie, { query: 'dall-e' });
    expect(byApiId.body.data.items.map((model) => model.displayName)).toEqual(['DALL-E 3']);
  });

  it('paginates the model list with a keyset cursor', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const providerId = await readId(await createProvider(cookie, csrfToken));

    for (const suffix of ['a', 'b', 'c']) {
      expect(
        (
          await createModel(cookie, csrfToken, providerId, {
            apiModelId: `model-${suffix}`,
            displayName: `Model ${suffix}`,
          })
        ).status,
      ).toBe(201);
    }

    const first = await listModels(cookie, { limit: '2' });
    expect(first.body.data.items).toHaveLength(2);
    const cursor = first.body.data.nextCursor;
    expect(cursor).not.toBeNull();

    const second = await listModels(cookie, { limit: '2', cursor: cursor ?? '' });
    expect(second.body.data.items).toHaveLength(1);
    expect(second.body.data.nextCursor).toBeNull();

    const all = await listModels(cookie);
    expect([...first.body.data.items, ...second.body.data.items].map((model) => model.id)).toEqual(
      all.body.data.items.map((model) => model.id),
    );
    expect(new Set(all.body.data.items.map((model) => model.id)).size).toBe(3);
  });

  it('rejects an invalid kind or cursor with 400 invalid_request', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    expect((await createProvider(cookie, csrfToken)).status).toBe(201);

    const badKind = await listModels(cookie, { kind: 'video' });
    expect(badKind.res.status).toBe(400);
    expect(badKind.body.code).toBe('invalid_request');

    const badCursor = await listModels(cookie, { cursor: 'not-a-cursor' });
    expect(badCursor.res.status).toBe(400);
    expect(badCursor.body.code).toBe('invalid_request');
  });

  it('allows deleting a provider once its last model is removed', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const createdProvider = await createProvider(cookie, csrfToken);
    const providerId = ((await createdProvider.json()) as { data: { id: string } }).data.id;
    const createdModel = await createModel(cookie, csrfToken, providerId);
    const modelId = ((await createdModel.json()) as { data: { id: string } }).data.id;

    const firstDelete = await app.request(
      new Request(`http://localhost/api/admin/providers/${providerId}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      }),
    );
    expect(firstDelete.status).toBe(409);

    const modelDelete = await app.request(
      new Request(`http://localhost/api/admin/models/${modelId}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      }),
    );
    expect(modelDelete.status).toBe(200);

    const providerDelete = await app.request(
      new Request(`http://localhost/api/admin/providers/${providerId}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      }),
    );
    expect(providerDelete.status).toBe(200);
  });

  it('returns 404 not_found when deleting an unknown model', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const res = await app.request(
      new Request(`http://localhost/api/admin/models/${Bun.randomUUIDv7()}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('refuses to delete a model that is referenced by conversations with 409 conflict', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const createdProvider = await createProvider(cookie, csrfToken);
    const providerId = ((await createdProvider.json()) as { data: { id: string } }).data.id;
    const createdModel = await createModel(cookie, csrfToken, providerId);
    const modelId = ((await createdModel.json()) as { data: { id: string } }).data.id;

    const pool = getPool();
    const userRow = (await pool.query<{ id: string }>('SELECT id FROM users LIMIT 1')).rows[0];
    const userId = userRow?.id ?? '';
    const convId = Bun.randomUUIDv7();
    await pool.query(
      `INSERT INTO conversations (id, user_id, model_id) VALUES ($1, $2, $3)`,
      [convId, userId, modelId],
    );

    const res = await app.request(
      new Request(`http://localhost/api/admin/models/${modelId}`, {
        method: 'DELETE',
        headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrfToken },
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('conflict');
  });

  it('accepts a status-only patch when stored defaultMaxOutputTokens exceeds maxOutputTokens', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const createdProvider = await createProvider(cookie, csrfToken);
    const providerId = ((await createdProvider.json()) as { data: { id: string } }).data.id;
    const createdModel = await createModel(cookie, csrfToken, providerId, {
      maxOutputTokens: 8_192,
      defaultMaxOutputTokens: 8_192,
    });
    const modelId = ((await createdModel.json()) as { data: { id: string } }).data.id;

    const lower = await app.request(
      new Request(`http://localhost/api/admin/models/${modelId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ maxOutputTokens: 4_096 }),
      }),
    );
    expect(lower.status).toBe(400);

    const toggle = await app.request(
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
    expect(toggle.status).toBe(200);
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

  it('round-trips a reasoning capability and clears it with null', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const providerRes = await createProvider(cookie, csrfToken);
    const providerId = ((await providerRes.json()) as { data: { id: string } }).data.id;

    const reasoning = {
      availableEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'medium',
    };
    const modelRes = await createModel(cookie, csrfToken, providerId, {
      capabilities: { ...CAPABILITIES, reasoning },
    });
    expect(modelRes.status).toBe(201);
    const createdBody = (await modelRes.json()) as {
      data: { id: string; capabilities: { reasoning?: unknown } };
    };
    expect(createdBody.data.capabilities.reasoning).toEqual(reasoning);
    const modelId = createdBody.data.id;

    const publicRes = await app.request(
      new Request('http://localhost/api/models', { headers: { Cookie: cookie } }),
    );
    const publicBody = (await publicRes.json()) as {
      data: { items: Array<{ capabilities: { reasoning?: unknown } }> };
    };
    expect(publicBody.data.items[0]?.capabilities.reasoning).toEqual(reasoning);

    const invalid = await app.request(
      new Request(`http://localhost/api/admin/models/${modelId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          capabilities: { reasoning: { availableEfforts: ['low'], defaultEffort: 'high' } },
        }),
      }),
    );
    expect(invalid.status).toBe(400);

    const cleared = await app.request(
      new Request(`http://localhost/api/admin/models/${modelId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ capabilities: { reasoning: null } }),
      }),
    );
    expect(cleared.status).toBe(200);
    const clearedBody = (await cleared.json()) as {
      data: { capabilities: { reasoning?: unknown } };
    };
    expect(clearedBody.data.capabilities.reasoning).toBeUndefined();
  });

  it('no longer accepts or returns a model key', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const providerRes = await createProvider(cookie, csrfToken);
    const providerId = ((await providerRes.json()) as { data: { id: string } }).data.id;

    const modelRes = await createModel(cookie, csrfToken, providerId);
    expect(modelRes.status).toBe(201);
    const created = (await modelRes.json()) as { data: Record<string, unknown> };
    expect(Object.keys(created.data)).not.toContain('key');
    expect(created.data['apiModelId']).toBe('gpt-4o-2024-08-06');
  });

  it('rejects a second model with the same apiModelId on the same provider', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const providerRes = await createProvider(cookie, csrfToken);
    const providerId = ((await providerRes.json()) as { data: { id: string } }).data.id;

    expect((await createModel(cookie, csrfToken, providerId)).status).toBe(201);
    expect((await createModel(cookie, csrfToken, providerId)).status).toBe(409);
  });

  it('lists provider models from the adapter for the model picker', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');
    const providerRes = await app.request(
      new Request('http://localhost/api/admin/providers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          key: `fake-${Date.now()}`,
          displayName: 'Fake (picker)',
          adapter: 'fake',
          secretRef: 'FAKE_API_KEY',
        }),
      }),
    );
    expect(providerRes.status).toBe(201);
    const providerId = ((await providerRes.json()) as { data: { id: string } }).data.id;

    const res = await app.request(
      new Request(`http://localhost/api/admin/providers/${providerId}/models`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ id: string }> } };
    expect(body.data.items.map((model) => model.id)).toEqual(['fake-model', 'fake-model-mini']);
  });

  it('returns 404 not_found when listing models of an unknown provider', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie } = await loginAs('admin@corp.example');
    const res = await app.request(
      new Request(`http://localhost/api/admin/providers/${Bun.randomUUIDv7()}/models`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(res.status).toBe(404);
  });

  it('allows super admin to configure and update systemAddendum on provider and model', async () => {
    await seedUser('super_admin', 'admin@corp.example');
    const { cookie, csrfToken } = await loginAs('admin@corp.example');

    const providerRes = await app.request(
      new Request('http://localhost/api/admin/providers', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          key: 'prov-addendum',
          displayName: 'Provider with addendum',
          adapter: 'openai',
          secretRef: 'OPENAI_API_KEY',
          config: { systemAddendum: 'Default provider instructions.' },
        }),
      }),
    );
    expect(providerRes.status).toBe(201);
    const providerData = ((await providerRes.json()) as { data: { id: string; config: Record<string, unknown> } }).data;
    expect(providerData.config['systemAddendum']).toBe('Default provider instructions.');

    const modelRes = await createModel(cookie, csrfToken, providerData.id, {
      config: { systemAddendum: 'Model-specific instructions.' },
    });
    expect(modelRes.status).toBe(201);
    const modelData = ((await modelRes.json()) as { data: { id: string; config: Record<string, unknown> } }).data;
    expect(modelData.config['systemAddendum']).toBe('Model-specific instructions.');

    const updateProvider = await app.request(
      new Request(`http://localhost/api/admin/providers/${providerData.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          config: { systemAddendum: 'Updated provider instructions.' },
        }),
      }),
    );
    expect(updateProvider.status).toBe(200);
    const updatedProvData = ((await updateProvider.json()) as { data: { config: Record<string, unknown> } }).data;
    expect(updatedProvData.config['systemAddendum']).toBe('Updated provider instructions.');

    const updateModel = await app.request(
      new Request(`http://localhost/api/admin/models/${modelData.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({
          config: { systemAddendum: 'Updated model instructions.' },
        }),
      }),
    );
    expect(updateModel.status).toBe(200);
    const updatedModelData = ((await updateModel.json()) as { data: { config: Record<string, unknown> } }).data;
    expect(updatedModelData.config['systemAddendum']).toBe('Updated model instructions.');
  });
});
