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
    `INSERT INTO ai_models (id, provider_id, key, api_model_id, display_name, status,
                            capabilities, context_window, max_output_tokens, default_max_output_tokens)
     VALUES ($1, $2, $3, 'fake-model', 'Fake Model', 'active',
             '{"schemaVersion":1,"streaming":true,"vision":false,"documents":{"pdf":false},"imageGeneration":false,"documentGeneration":false,"systemPrompt":true,"tools":false,"contextWindow":128000,"maxOutputTokens":4096}',
             128000, 4096, 2048)`,
    [modelId, providerId, `m-${modelId}`],
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

interface SendOptions {
  key?: string;
  text?: string;
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
      body: JSON.stringify({ parts: [{ type: 'text', text: options.text ?? 'Hello' }] }),
    }),
  );
}

describe('Generation HTTP Surface & Streaming (P2-5 & P2-6)', () => {
  beforeEach(async () => {
    await resetDatabase();
    (services.rateLimiter as MemoryRateLimiter).clear();
    services.registry.invalidate();
    (services.providers.get('fake') as unknown as { scenario: string }).scenario = 'success';
  });

  afterAll(async () => {
    await closePool();
  });

  it('full FakeProvider happy path: streams deltas and final text matches persisted text_content', async () => {
    const modelId = await seedActiveModel('fake');
    await seedUser('streamer@corp.example');
    const auth = await loginAs('streamer@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const sendRes = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Tell me something',
    });
    expect(sendRes.status).toBe(202);
    const sendBody = (await sendRes.json()) as {
      data: { generation: { id: string; streamUrl: string }; assistantMessage: { id: string } };
    };
    const genId = sendBody.data.generation.id;
    const assistantId = sendBody.data.assistantMessage.id;

    const streamRes = await app.request(
      new Request(`http://localhost/api/generations/${genId}/stream`, {
        headers: {
          Cookie: auth.cookie,
        },
      }),
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream');

    const streamText = await streamRes.text();
    expect(streamText).toContain('event: message.created');
    expect(streamText).toContain('event: generation.state');
    expect(streamText).toContain('event: text.delta');
    expect(streamText).toContain('event: generation.completed');

    await new Promise((resolve) => setTimeout(resolve, 50));

    const pool = getPool();
    const { rows: partRows } = await pool.query<{ text_content: string; status: string }>(
      'SELECT text_content, status FROM message_parts WHERE message_id = $1',
      [assistantId],
    );
    expect(partRows.length).toBe(1);
    expect(partRows[0]?.status).toBe('complete');
    expect(partRows[0]?.text_content).toContain('Hello from the fake provider.');
  });

  it('GET /api/generations/:id returns status and handles IDOR (404 for other user)', async () => {
    const modelId = await seedActiveModel('fake');
    await seedUser('user1@corp.example');
    await seedUser('user2@corp.example');
    const auth1 = await loginAs('user1@corp.example');
    const auth2 = await loginAs('user2@corp.example');

    const convId = await createConversation(auth1.cookie, auth1.csrfToken, modelId);
    const sendRes = await send(convId, auth1.cookie, auth1.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Hi',
    });
    const genId = ((await sendRes.json()) as { data: { generation: { id: string } } }).data.generation.id;

    const statusRes1 = await app.request(
      new Request(`http://localhost/api/generations/${genId}`, {
        headers: { Cookie: auth1.cookie },
      }),
    );
    expect(statusRes1.status).toBe(200);
    const body1 = (await statusRes1.json()) as { data: { id: string; status: string } };
    expect(body1.data.id).toBe(genId);

    const statusRes2 = await app.request(
      new Request(`http://localhost/api/generations/${genId}`, {
        headers: { Cookie: auth2.cookie },
      }),
    );
    expect(statusRes2.status).toBe(404);
  });

  it('POST /api/generations/:id/cancel cancels generation idempotently', async () => {
    const modelId = await seedActiveModel('fake');
    (services.providers.get('fake') as unknown as { scenario: string }).scenario = 'timeout';

    await seedUser('cancel@corp.example');
    const auth = await loginAs('cancel@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const sendRes = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Cancel me',
    });
    const genId = ((await sendRes.json()) as { data: { generation: { id: string } } }).data.generation.id;

    const cancelRes1 = await app.request(
      new Request(`http://localhost/api/generations/${genId}/cancel`, {
        method: 'POST',
        headers: {
          Cookie: auth.cookie,
          Origin: ORIGIN,
          'X-CSRF-Token': auth.csrfToken,
        },
      }),
    );
    expect(cancelRes1.status).toBe(202);

    const cancelRes2 = await app.request(
      new Request(`http://localhost/api/generations/${genId}/cancel`, {
        method: 'POST',
        headers: {
          Cookie: auth.cookie,
          Origin: ORIGIN,
          'X-CSRF-Token': auth.csrfToken,
        },
      }),
    );
    expect(cancelRes2.status).toBe(202);

    // Wait for the background execution/finalizer to complete. Finalization is asynchronous now:
    // the route only signals the abort and the run owns the terminal write with the real usage.
    const pool = getPool();
    let row: { status: string; cancel_reason: string } | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const { rows } = await pool.query<{ status: string; cancel_reason: string }>(
        'SELECT status, cancel_reason FROM generation_jobs WHERE id = $1',
        [genId],
      );
      row = rows[0];
      if (row !== undefined && row.status !== 'pending' && row.status !== 'generating') break;
    }

    expect(row?.status).toBe('cancelled');
    expect(row?.cancel_reason).toBe('user_cancel');
  });

  it('cancel preserves partial text already streamed and marks the message incomplete', async () => {
    const modelId = await seedActiveModel('fake');
    const fake = services.providers.get('fake') as unknown as {
      scenario: string;
      chunkDelayMs: number;
      chunks: string[];
    };
    fake.scenario = 'success';
    fake.chunkDelayMs = 40;
    fake.chunks = ['Partial', ' text', ' more', ' tail'];

    await seedUser('partial@corp.example');
    const auth = await loginAs('partial@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const sendRes = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Give me a long answer',
    });
    const sendBody = (await sendRes.json()) as {
      data: { generation: { id: string }; assistantMessage: { id: string } };
    };
    const genId = sendBody.data.generation.id;
    const assistantId = sendBody.data.assistantMessage.id;

    await new Promise((resolve) => setTimeout(resolve, 120));

    const cancelRes = await app.request(
      new Request(`http://localhost/api/generations/${genId}/cancel`, {
        method: 'POST',
        headers: { Cookie: auth.cookie, Origin: ORIGIN, 'X-CSRF-Token': auth.csrfToken },
      }),
    );
    expect(cancelRes.status).toBe(202);

    const pool = getPool();
    let msg: { status: string; finish_reason: string } | undefined;
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const { rows } = await pool.query<{ status: string; finish_reason: string }>(
        'SELECT status, finish_reason FROM messages WHERE id = $1',
        [assistantId],
      );
      msg = rows[0];
      if (msg !== undefined && msg.status !== 'streaming') break;
    }

    expect(msg?.status).toBe('incomplete');
    expect(msg?.finish_reason).toBe('cancelled');

    // The partial text must survive the cancellation (the finalizer persists accumulated text).
    const { rows: partRows } = await pool.query<{ text_content: string; status: string }>(
      'SELECT text_content, status FROM message_parts WHERE message_id = $1 ORDER BY position',
      [assistantId],
    );
    expect(partRows.length).toBeGreaterThan(0);
    const persisted = partRows.map((p) => p.text_content).join('');
    expect(persisted.length).toBeGreaterThan(0);
    expect('Partial text more tail').toContain(persisted);
    expect(partRows[0]?.status).toBe('incomplete');
  });

  it('POST /api/conversations/:id/messages/:mid/retry retries failed/cancelled message', async () => {
    const modelId = await seedActiveModel('fake');
    (services.providers.get('fake') as unknown as { scenario: string }).scenario = 'error_before_output';

    await seedUser('retry@corp.example');
    const auth = await loginAs('retry@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const sendRes = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Trigger error',
    });
    const sendBody = (await sendRes.json()) as {
      data: {
        userMessage: { id: string };
        assistantMessage: { id: string };
        generation: { id: string };
      };
    };
    const userMid = sendBody.data.userMessage.id;
    const oldAssistantId = sendBody.data.assistantMessage.id;
    const pool = getPool();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Keep failing so the retried assistant messages stay retryable (the point of this test is the
    // supersession chain, not the success path).
    (services.providers.get('fake') as unknown as { scenario: string }).scenario = 'error_before_output';

    const retryRes = await app.request(
      new Request(`http://localhost/api/conversations/${convId}/messages/${userMid}/retry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: auth.cookie,
          Origin: ORIGIN,
          'X-CSRF-Token': auth.csrfToken,
          'Idempotency-Key': Bun.randomUUIDv7(),
        },
        body: JSON.stringify({}),
      }),
    );
    expect(retryRes.status).toBe(202);
    const retryBody = (await retryRes.json()) as {
      data: { assistantMessage: { id: string } };
    };
    const newAssistantId = retryBody.data.assistantMessage.id;

    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM generation_jobs
         WHERE conversation_id = $1 AND status IN ('pending','generating')`,
        [convId],
      );
      if (rows[0]?.count === '0') break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    const { rows: oldRows } = await pool.query<{ superseded_by: string }>(
      'SELECT superseded_by FROM messages WHERE id = $1',
      [oldAssistantId],
    );
    expect(oldRows[0]?.superseded_by).toBe(newAssistantId);

    // List messages - superseded message must be hidden by default per §13.4
    const listRes = await app.request(
      new Request(`http://localhost/api/conversations/${convId}/messages`, {
        headers: { Cookie: auth.cookie },
      }),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { data: { items: Array<{ id: string }> } };
    const listedIds = listBody.data.items.map((m) => m.id);
    expect(listedIds).not.toContain(oldAssistantId);
    expect(listedIds).toContain(newAssistantId);

    // Retry AGAIN from the same original user message: the retry must target the *tail* of the
    // supersession chain, not resurrect the first attempt (§13.4). This is the
    // findPairedAssistantMessage chain-walk fix. Wait for the retry's generation to go terminal
    // first (only one live generation per conversation is allowed).
    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM generation_jobs
         WHERE conversation_id = $1 AND status IN ('pending','generating')`,
        [convId],
      );
      if (rows[0]?.count === '0') break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    const secondRetryRes = await app.request(
      new Request(`http://localhost/api/conversations/${convId}/messages/${userMid}/retry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: auth.cookie,
          Origin: ORIGIN,
          'X-CSRF-Token': auth.csrfToken,
          'Idempotency-Key': Bun.randomUUIDv7(),
        },
        body: JSON.stringify({}),
      }),
    );
    expect(secondRetryRes.status).toBe(202);
    const secondRetryBody = (await secondRetryRes.json()) as {
      data: { assistantMessage: { id: string } };
    };
    const thirdAssistantId = secondRetryBody.data.assistantMessage.id;
    expect(thirdAssistantId).not.toBe(newAssistantId);

    const { rows: midRows } = await pool.query<{ superseded_by: string | null }>(
      'SELECT superseded_by FROM messages WHERE id = $1',
      [newAssistantId],
    );
    expect(midRows[0]?.superseded_by).toBe(thirdAssistantId);

    const { rows: firstRows } = await pool.query<{ superseded_by: string | null }>(
      'SELECT superseded_by FROM messages WHERE id = $1',
      [oldAssistantId],
    );
    expect(firstRows[0]?.superseded_by).toBe(newAssistantId);
  });
});
