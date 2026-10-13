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

async function seedUser(email: string, role: 'admin' | 'user' = 'user') {
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

async function loginAs(email: string): Promise<{ cookie: string; csrfToken: string; userId: string }> {
  const res = await app.request(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { user: { id: string }; csrfToken: string } };
  const setCookie = res.headers.get('set-cookie');
  const match = setCookie === null ? null : /__Host-session=([^;]*)/.exec(setCookie);
  if (match === null) throw new Error('no session cookie issued');
  return { cookie: `__Host-session=${match[1]}`, csrfToken: body.data.csrfToken, userId: body.data.user.id };
}

async function seedActiveModel(): Promise<string> {
  const pool = getPool();
  const providerId = Bun.randomUUIDv7();
  const modelId = Bun.randomUUIDv7();

  await pool.query(
    `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref, status)
     VALUES ($1, $2, 'OpenAI', 'openai', 'OPENAI_API_KEY', 'active')`,
    [providerId, `p-${providerId}`],
  );

  await pool.query(
    `INSERT INTO ai_models (id, provider_id, key, api_model_id, display_name, status,
                            capabilities, context_window, max_output_tokens, default_max_output_tokens)
     VALUES ($1, $2, $3, 'gpt-4o', 'GPT-4o', 'active',
             '{"schemaVersion":1,"streaming":true,"vision":true,"documents":{"pdf":true},"imageGeneration":false,"documentGeneration":false,"systemPrompt":true,"tools":false,"contextWindow":128000,"maxOutputTokens":4096}',
             128000, 4096, 2048)`,
    [modelId, providerId, `m-${modelId}`],
  );

  services.registry.invalidate();
  return modelId;
}

describe('Conversations HTTP surface & security (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
    (services.rateLimiter as MemoryRateLimiter).clear();
    services.registry.invalidate();
  });

  afterAll(async () => {
    await closePool();
  });

  it('creates a conversation with an active model', async () => {
    const modelId = await seedActiveModel();
    await seedUser('user1@corp.example');
    const { cookie, csrfToken } = await loginAs('user1@corp.example');

    const res = await app.request(
      new Request('http://localhost/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ modelId, title: 'Test Chat' }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { id: string; title: string; modelId: string; modelLocked: boolean };
    };
    expect(body.data.title).toBe('Test Chat');
    expect(body.data.modelId).toBe(modelId);
    expect(body.data.modelLocked).toBe(false);
  });

  it('enforces IDOR -> 404 on every ID route for another user\'s conversation', async () => {
    const modelId = await seedActiveModel();
    const owner = await seedUser('owner@corp.example');
    const other = await seedUser('other@corp.example');
    void owner;
    void other;

    const ownerAuth = await loginAs('owner@corp.example');
    const otherAuth = await loginAs('other@corp.example');

    const createRes = await app.request(
      new Request('http://localhost/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: ownerAuth.cookie,
          'X-CSRF-Token': ownerAuth.csrfToken,
        },
        body: JSON.stringify({ modelId, title: 'Owner Private Chat' }),
      }),
    );
    const convId = ((await createRes.json()) as { data: { id: string } }).data.id;

    const getRes = await app.request(
      new Request(`http://localhost/api/conversations/${convId}`, {
        headers: { Cookie: otherAuth.cookie },
      }),
    );
    expect(getRes.status).toBe(404);
    expect(((await getRes.json()) as { code: string }).code).toBe('not_found');

    const patchRes = await app.request(
      new Request(`http://localhost/api/conversations/${convId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: otherAuth.cookie,
          'X-CSRF-Token': otherAuth.csrfToken,
        },
        body: JSON.stringify({ title: 'Hacked Title' }),
      }),
    );
    expect(patchRes.status).toBe(404);

    const deleteRes = await app.request(
      new Request(`http://localhost/api/conversations/${convId}`, {
        method: 'DELETE',
        headers: {
          Origin: ORIGIN,
          Cookie: otherAuth.cookie,
          'X-CSRF-Token': otherAuth.csrfToken,
        },
      }),
    );
    expect(deleteRes.status).toBe(404);

    const messagesRes = await app.request(
      new Request(`http://localhost/api/conversations/${convId}/messages`, {
        headers: { Cookie: otherAuth.cookie },
      }),
    );
    expect(messagesRes.status).toBe(404);
  });

  it('performs keyset pagination when listing conversations', async () => {
    const modelId = await seedActiveModel();
    await seedUser('user@corp.example');
    const { cookie, csrfToken } = await loginAs('user@corp.example');

    for (let i = 1; i <= 3; i++) {
      await app.request(
        new Request('http://localhost/api/conversations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ modelId, title: `Chat ${i}` }),
        }),
      );
    }

    const page1Res = await app.request(
      new Request('http://localhost/api/conversations?limit=2', {
        headers: { Cookie: cookie },
      }),
    );
    expect(page1Res.status).toBe(200);
    const page1Body = (await page1Res.json()) as {
      data: { items: Array<{ title: string }>; nextCursor: string | null };
    };
    expect(page1Body.data.items).toHaveLength(2);
    expect(page1Body.data.nextCursor).not.toBeNull();

    const page2Res = await app.request(
      new Request(`http://localhost/api/conversations?limit=2&cursor=${encodeURIComponent(page1Body.data.nextCursor!)}`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(page2Res.status).toBe(200);
    const page2Body = (await page2Res.json()) as {
      data: { items: Array<{ title: string }>; nextCursor: string | null };
    };
    expect(page2Body.data.items).toHaveLength(1);
    expect(page2Body.data.nextCursor).toBeNull();
  });

  it('verifies DB-enforced model immutability after message_count > 0', async () => {
    const modelId = await seedActiveModel();
    await seedUser('user@corp.example');
    const { cookie, csrfToken } = await loginAs('user@corp.example');

    const createRes = await app.request(
      new Request('http://localhost/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ modelId }),
      }),
    );
    const convId = ((await createRes.json()) as { data: { id: string } }).data.id;

    const pool = getPool();
    await pool.query('UPDATE conversations SET message_count = 1 WHERE id = $1', [convId]);

    const anotherModelId = Bun.randomUUIDv7();
    await expect(
      pool.query('UPDATE conversations SET model_id = $2 WHERE id = $1', [convId, anotherModelId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('paginates message history using opaque before cursor string', async () => {
    const modelId = await seedActiveModel();
    await seedUser('msguser@corp.example');
    const { cookie, csrfToken } = await loginAs('msguser@corp.example');

    const createRes = await app.request(
      new Request('http://localhost/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ modelId }),
      }),
    );
    const convId = ((await createRes.json()) as { data: { id: string } }).data.id;

    const pool = getPool();
    for (let seq = 1; seq <= 5; seq++) {
      const msgId = Bun.randomUUIDv7();
      await pool.query(
        `INSERT INTO messages (id, conversation_id, seq, role, status) VALUES ($1, $2, $3, $4, 'complete')`,
        [msgId, convId, seq, seq % 2 === 1 ? 'user' : 'assistant'],
      );
    }

    const page1Res = await app.request(
      new Request(`http://localhost/api/conversations/${convId}/messages?limit=2`, {
        headers: { Cookie: cookie },
      }),
    );
    expect(page1Res.status).toBe(200);
    const page1Body = (await page1Res.json()) as {
      data: { items: Array<{ seq: number }>; nextCursor: string | null };
    };
    expect(page1Body.data.items).toHaveLength(2);
    expect(page1Body.data.nextCursor).not.toBeNull();

    const page2Res = await app.request(
      new Request(
        `http://localhost/api/conversations/${convId}/messages?limit=2&before=${encodeURIComponent(page1Body.data.nextCursor!)}`,
        { headers: { Cookie: cookie } },
      ),
    );
    expect(page2Res.status).toBe(200);
    const page2Body = (await page2Res.json()) as {
      data: { items: Array<{ seq: number }>; nextCursor: string | null };
    };
    expect(page2Body.data.items.length).toBeGreaterThan(0);
  });
});
