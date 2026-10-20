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
  // Keep the node cap high so admission never masks the invariants under test.
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

async function loginAs(
  email: string,
): Promise<{ cookie: string; csrfToken: string; userId: string }> {
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

async function seedActiveModel(providerAdapter = 'openai'): Promise<string> {
  const pool = getPool();
  const providerId = Bun.randomUUIDv7();
  const modelId = Bun.randomUUIDv7();

  await pool.query(
    `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref, status)
     VALUES ($1, $2, 'TestProvider', $3, 'OPENAI_API_KEY', 'active')`,
    [providerId, `p-${providerId}`, providerAdapter],
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

async function createConversation(
  cookie: string,
  csrfToken: string,
  modelId: string,
): Promise<string> {
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

interface SendOptions {
  key?: string;
  text?: string;
  body?: unknown;
}

async function send(
  conversationId: string,
  cookie: string,
  csrfToken: string,
  options: SendOptions = {},
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
      body: JSON.stringify(
        options.body ?? { parts: [{ type: 'text', text: options.text ?? 'Hello' }] },
      ),
    }),
  );
}

describe('Send message — transactional & idempotent (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
    (services.rateLimiter as MemoryRateLimiter).clear();
    services.registry.invalidate();
  });

  afterAll(async () => {
    await closePool();
  });

  it('creates the user message, assistant placeholder and generation row atomically', async () => {
    const modelId = await seedActiveModel();
    await seedUser('sender@corp.example');
    const auth = await loginAs('sender@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const res = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Summarize the contract',
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      data: {
        userMessage: { id: string; seq: number; role: string; status: string };
        assistantMessage: { id: string; seq: number; role: string; status: string };
        generation: { id: string; status: string; streamUrl: string };
        quota: { reservedTokens: number; remainingTokens: number } | null;
      };
    };
    expect(body.data.userMessage.role).toBe('user');
    expect(body.data.userMessage.status).toBe('complete');
    expect(body.data.userMessage.seq).toBe(1);
    expect(body.data.assistantMessage.role).toBe('assistant');
    expect(body.data.assistantMessage.status).toBe('streaming');
    expect(body.data.assistantMessage.seq).toBe(2);
    expect(body.data.generation.status).toBe('pending');
    expect(body.data.generation.streamUrl).toBe(
      `/api/generations/${body.data.generation.id}/stream`,
    );
    // Quota reports the reservation and remaining balance.
    expect(body.data.quota).not.toBeNull();
    expect(body.data.quota?.reservedTokens).toBeGreaterThan(0);
    expect(body.data.quota?.remainingTokens).toBeGreaterThanOrEqual(0);

    const pool = getPool();
    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) FROM generation_jobs WHERE conversation_id = $1',
      [convId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('auto-titles the conversation from the first user message', async () => {
    const modelId = await seedActiveModel();
    await seedUser('title@corp.example');
    const auth = await loginAs('title@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: '  Plan a trip to Kyoto ',
    });

    const { rows } = await getPool().query<{ title: string }>(
      'SELECT title FROM conversations WHERE id = $1',
      [convId],
    );
    expect(rows[0]?.title).toBe('Plan a trip to Kyoto');
  });

  it('replays the original response for a repeated Idempotency-Key (no second generation)', async () => {
    const modelId = await seedActiveModel();
    await seedUser('replay@corp.example');
    const auth = await loginAs('replay@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);
    const key = Bun.randomUUIDv7();

    const first = await send(convId, auth.cookie, auth.csrfToken, { key, text: 'Double click' });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as { data: { generation: { id: string } } };
    expect(first.headers.get('Idempotency-Replayed')).toBeNull();

    const second = await send(convId, auth.cookie, auth.csrfToken, { key, text: 'Double click' });
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as { data: { generation: { id: string } } };
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    expect(secondBody.data.generation.id).toBe(firstBody.data.generation.id);

    const { rows } = await getPool().query<{ count: string }>(
      'SELECT count(*) FROM messages WHERE conversation_id = $1',
      [convId],
    );
    expect(rows[0]?.count).toBe('2');
  });

  it('rejects the same key with a different payload (422 idempotency_key_reuse)', async () => {
    const modelId = await seedActiveModel();
    await seedUser('reuse@corp.example');
    const auth = await loginAs('reuse@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);
    const key = Bun.randomUUIDv7();

    const first = await send(convId, auth.cookie, auth.csrfToken, { key, text: 'First payload' });
    expect(first.status).toBe(202);

    const second = await send(convId, auth.cookie, auth.csrfToken, {
      key,
      text: 'Different payload',
    });
    expect(second.status).toBe(422);
    expect(((await second.json()) as { code: string }).code).toBe('idempotency_key_reuse');
  });

  it('serializes 20 parallel sends with the same key into exactly one generation', async () => {
    const modelId = await seedActiveModel();
    await seedUser('parallel@corp.example');
    const auth = await loginAs('parallel@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);
    const key = Bun.randomUUIDv7();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        send(convId, auth.cookie, auth.csrfToken, { key, text: 'Concurrent' }),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(202);
    }
    const ids = new Set(
      await Promise.all(
        responses.map(async (res) => {
          const body = (await res.json()) as { data: { generation: { id: string } } };
          return body.data.generation.id;
        }),
      ),
    );
    expect(ids.size).toBe(1);

    const { rows } = await getPool().query<{ count: string }>(
      'SELECT count(*) FROM generation_jobs WHERE conversation_id = $1',
      [convId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('rejects a second send while a generation is live (409 generation_in_progress)', async () => {
    const modelId = await seedActiveModel('fake');
    (services.providers.get('fake') as unknown as { scenario: string }).scenario = 'timeout';

    await seedUser('busy@corp.example');
    const auth = await loginAs('busy@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const first = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'First',
    });
    expect(first.status).toBe(202);

    const second = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Second',
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe('generation_in_progress');
  });

  it('allows a new send once the previous generation is terminal', async () => {
    const modelId = await seedActiveModel();
    await seedUser('again@corp.example');
    const auth = await loginAs('again@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    await send(convId, auth.cookie, auth.csrfToken, { key: Bun.randomUUIDv7(), text: 'First' });
    await getPool().query(
      `UPDATE generation_jobs SET status = 'completed', finished_at = now() WHERE conversation_id = $1`,
      [convId],
    );

    const second = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Second',
    });
    expect(second.status).toBe(202);
  });

  it('requires a UUID Idempotency-Key (400 when missing or malformed)', async () => {
    const modelId = await seedActiveModel();
    await seedUser('header@corp.example');
    const auth = await loginAs('header@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const missing = await send(convId, auth.cookie, auth.csrfToken, { text: 'No key' });
    expect(missing.status).toBe(400);

    const bad = await send(convId, auth.cookie, auth.csrfToken, { key: 'not-a-uuid', text: 'Bad' });
    expect(bad.status).toBe(400);
  });

  it('rejects an empty message (400) and an unknown attachment (404)', async () => {
    const modelId = await seedActiveModel();
    await seedUser('invalid@corp.example');
    const auth = await loginAs('invalid@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const empty = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      body: { parts: [] },
    });
    expect(empty.status).toBe(400);

    // Attachments are wired in this build, so a file id that is not the caller's (or does not
    // exist) resolves to `not_found` — never 403, never a silent drop.
    const file = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      body: { parts: [{ type: 'file', fileId: Bun.randomUUIDv7() }] },
    });
    expect(file.status).toBe(404);
    expect(((await file.json()) as { code: string }).code).toBe('not_found');
  });

  it("returns 404 for another user's conversation (IDOR) with no rows written", async () => {
    const modelId = await seedActiveModel();
    await seedUser('owner2@corp.example');
    await seedUser('intruder@corp.example');
    const owner = await loginAs('owner2@corp.example');
    const intruder = await loginAs('intruder@corp.example');
    const convId = await createConversation(owner.cookie, owner.csrfToken, modelId);

    const res = await send(convId, intruder.cookie, intruder.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Intrude',
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');

    const { rows } = await getPool().query<{ count: string }>(
      'SELECT count(*) FROM generation_jobs WHERE conversation_id = $1',
      [convId],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('rejects an in-flight unfinalized idempotency key (status=0) with 409 conflict', async () => {
    const modelId = await seedActiveModel();
    await seedUser('inflight@corp.example');
    const auth = await loginAs('inflight@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);
    const key = Bun.randomUUIDv7();

    const { canonicalRequestHash } = await import('@/generations/application/send-service.ts');
    const requestHash = canonicalRequestHash(
      convId,
      [{ type: 'text', text: 'In flight' }],
      undefined,
    );
    await getPool().query(
      `INSERT INTO idempotency_keys (user_id, key, endpoint, request_hash, response_status, response_body, expires_at)
       VALUES ($1, $2, 'POST /api/conversations/:id/messages', $3, 0, '{}', now() + interval '1 day')`,
      [auth.userId, key, requestHash],
    );

    const res = await send(convId, auth.cookie, auth.csrfToken, { key, text: 'In flight' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('conflict');
  });

  it('emits 503 service_busy and Retry-After header when node capacity is saturated', async () => {
    const modelId = await seedActiveModel('fake');
    await seedUser('cap1@corp.example');
    await seedUser('cap2@corp.example');
    const auth1 = await loginAs('cap1@corp.example');
    const auth2 = await loginAs('cap2@corp.example');
    const convId1 = await createConversation(auth1.cookie, auth1.csrfToken, modelId);
    const convId2 = await createConversation(auth2.cookie, auth2.csrfToken, modelId);

    const lowCapConfig = loadConfig({
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      NODE_ENV: 'test',
      SESSION_SECRET: SECRET,
      ALLOWED_ORIGINS: ORIGIN,
      LOG_LEVEL: 'silent',
      MAX_ACTIVE_GENERATIONS: '1',
    });
    const lowCapServices = createServices(lowCapConfig);
    (lowCapServices.providers.get('fake') as unknown as { scenario: string }).scenario = 'timeout';
    const lowCapApp = createApp(lowCapConfig, lowCapServices);

    const res1 = await lowCapApp.request(
      new Request(`http://localhost/api/conversations/${convId1}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: auth1.cookie,
          'X-CSRF-Token': auth1.csrfToken,
          'Idempotency-Key': Bun.randomUUIDv7(),
        },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'First active' }] }),
      }),
    );
    expect(res1.status).toBe(202);

    const res2 = await lowCapApp.request(
      new Request(`http://localhost/api/conversations/${convId2}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: auth2.cookie,
          'X-CSRF-Token': auth2.csrfToken,
          'Idempotency-Key': Bun.randomUUIDv7(),
        },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'Second should be 503' }] }),
      }),
    );
    expect(res2.status).toBe(503);
    expect(res2.headers.get('Retry-After')).toBe('5');
    const body2 = (await res2.json()) as { code: string };
    expect(body2.code).toBe('service_busy');
  });
});
