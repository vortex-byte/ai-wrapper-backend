import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '@/app.ts';
import { createServices, type Services } from '@/services.ts';
import { BunPasswordHasher } from '@/auth/infrastructure/bun-password-hasher.ts';
import { DrizzleUserRepository } from '@/auth/infrastructure/drizzle-user-repository.ts';
import { loadConfig, type Config } from '@/config/index.ts';
import { closePool, getPool } from '@/db/index.ts';
import type { MemoryRateLimiter } from '@/http/infrastructure/memory-rate-limiter.ts';
import { setShuttingDown } from '@/health/readyz.ts';
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
  MAX_ACTIVE_GENERATIONS: '1000',
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
  return {
    cookie: `__Host-session=${match[1]}`,
    csrfToken: body.data.csrfToken,
    userId: body.data.user.id,
  };
}

async function seedActiveModel(providerAdapter = 'fake'): Promise<string> {
  const pool = getPool();
  const providerId = Bun.randomUUIDv7();
  const modelId = Bun.randomUUIDv7();

  await pool.query(
    `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref, status)
     VALUES ($1, $2, 'FakeProvider', $3, 'FAKE_KEY', 'active')`,
    [providerId, `p-${providerId}`, providerAdapter],
  );
  await pool.query(
    `INSERT INTO ai_models (id, provider_id, api_model_id, display_name, status,
                            capabilities, context_window, max_output_tokens, default_max_output_tokens)
     VALUES ($1, $2, 'fake-model', 'Fake Model', 'active',
             '{"schemaVersion":1,"streaming":true,"vision":false,"documents":{"pdf":false},"imageGeneration":false,"documentGeneration":false,"systemPrompt":true,"tools":false,"contextWindow":128000,"maxOutputTokens":4096}',
             128000, 4096, 2048)`,
    [modelId, providerId],
  );
  services.registry.invalidate();
  return modelId;
}

async function createConversation(cookie: string, csrfToken: string, modelId: string): Promise<string> {
  const res = await app.request(
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
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

async function send(
  conversationId: string,
  cookie: string,
  csrfToken: string,
  options: { key?: string; text?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: ORIGIN,
    Cookie: cookie,
    'X-CSRF-Token': csrfToken,
  };
  if (options.key !== undefined) headers['Idempotency-Key'] = options.key;
  return app.request(
    new Request(`http://localhost/api/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ parts: [{ type: 'text', text: options.text ?? 'Hello' }] }),
    }),
  );
}

describe('Shutdown & Role Wiring (P2-7)', () => {
  beforeEach(async () => {
    setShuttingDown(false);
    services.orchestrator.isDraining = false;
    await resetDatabase();
    (services.rateLimiter as MemoryRateLimiter).clear();
    services.registry.invalidate();
    (services.providers.get('fake') as unknown as { scenario: string; chunkDelayMs: number }).scenario = 'success';
    (services.providers.get('fake') as unknown as { scenario: string; chunkDelayMs: number }).chunkDelayMs = 0;
  });

  afterAll(async () => {
    setShuttingDown(false);
    await closePool();
  });

  it('GET /readyz returns 503 during shutdown/drain', async () => {
    const readyBefore = await app.request(new Request('http://localhost/readyz'));
    expect(readyBefore.status).toBe(200);

    setShuttingDown(true);

    const readyAfter = await app.request(new Request('http://localhost/readyz'));
    expect(readyAfter.status).toBe(503);
    const body = (await readyAfter.json()) as { ready: boolean; checks: Record<string, unknown> };
    expect(body.ready).toBe(false);
  });

  it('admission gate: send & retry return 503 service_busy + Retry-After during drain', async () => {
    const modelId = await seedActiveModel('fake');
    await seedUser('admit@corp.example');
    const auth = await loginAs('admit@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    services.orchestrator.isDraining = true;

    const sendRes = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Should be rejected',
    });
    expect(sendRes.status).toBe(503);
    expect(sendRes.headers.get('retry-after')).toBe('5');
    const sendBody = (await sendRes.json()) as { code: string };
    expect(sendBody.code).toBe('service_busy');
  });

  it('slow generation interrupted by shutdown persists partial text and marks failed(interrupted)', async () => {
    const modelId = await seedActiveModel('fake');
    const fake = services.providers.get('fake') as unknown as {
      scenario: string;
      chunkDelayMs: number;
      chunks: string[];
    };
    fake.scenario = 'success';
    fake.chunks = ['chunk1 ', 'chunk2 ', 'chunk3 ', 'chunk4 '];
    fake.chunkDelayMs = 200;

    await seedUser('slow@corp.example');
    const auth = await loginAs('slow@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const sendRes = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Long answer please',
    });
    expect(sendRes.status).toBe(202);
    const sendBody = (await sendRes.json()) as {
      data: { generation: { id: string }; assistantMessage: { id: string } };
    };
    const genId = sendBody.data.generation.id;
    const assistantId = sendBody.data.assistantMessage.id;

    const streamPromise = app.request(
      new Request(`http://localhost/api/generations/${genId}/stream`, {
        headers: { Cookie: auth.cookie },
      }),
    );

    await Bun.sleep(150);

    await services.orchestrator.shutdown(0);

    const streamRes = await streamPromise;
    expect(streamRes.status).toBe(200);
    const streamText = await streamRes.text();

    expect(streamText).toContain('event: generation.failed');
    expect(streamText).toContain('generation_interrupted');

    const pool = getPool();
    const { rows: genRows } = await pool.query<{ status: string; error_category: string }>(
      'SELECT status, error_category FROM generation_jobs WHERE id = $1',
      [genId],
    );
    expect(genRows[0]?.status).toBe('failed');
    expect(genRows[0]?.error_category).toBe('generation_interrupted');

    const { rows: msgRows } = await pool.query<{ status: string; finish_reason: string }>(
      'SELECT status, finish_reason FROM messages WHERE id = $1',
      [assistantId],
    );
    expect(msgRows[0]?.status).toBe('incomplete');
    expect(msgRows[0]?.finish_reason).toBe('interrupted');

    const { rows: partRows } = await pool.query<{ status: string; text_content: string }>(
      'SELECT status, text_content FROM message_parts WHERE message_id = $1',
      [assistantId],
    );
    expect(partRows[0]?.status).toBe('incomplete');
  });
});
