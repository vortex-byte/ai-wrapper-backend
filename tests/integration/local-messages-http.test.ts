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

const LOCAL_CAPABILITIES = {
  schemaVersion: 1,
  streaming: true,
  vision: false,
  documents: { pdf: false },
  imageGeneration: false,
  documentGeneration: false,
  systemPrompt: true,
  tools: false,
  contextWindow: 8_192,
  maxOutputTokens: 2_048,
};

const LOCAL_CONFIG = {
  local: {
    webllmModelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    tier: 'small',
    downloadSizeBytes: 880_000_000,
    vramRequiredMB: 1_100,
    license: 'Llama 3.2 Community License',
    sourceRevision: 'main',
    requiredFeatures: ['shader-f16'],
  },
};

const SERVER_CAPABILITIES = {
  schemaVersion: 1,
  streaming: true,
  vision: true,
  documents: { pdf: true },
  imageGeneration: false,
  documentGeneration: false,
  systemPrompt: true,
  tools: false,
  contextWindow: 128_000,
  maxOutputTokens: 4_096,
};

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

async function seedLocalModel(): Promise<string> {
  const pool = getPool();
  const providerId = Bun.randomUUIDv7();
  const modelId = Bun.randomUUIDv7();

  await pool.query(
    `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref, status)
     VALUES ($1, $2, 'On-device', 'local', 'UNUSED_LOCAL_KEY', 'active')`,
    [providerId, `local-${providerId}`],
  );

  await pool.query(
    `INSERT INTO ai_models (id, provider_id, api_model_id, display_name, status,
                            capabilities, context_window, max_output_tokens,
                            default_max_output_tokens, config)
     VALUES ($1, $2, 'Llama-3.2-1B-Instruct-q4f16_1-MLC', 'Llama 3.2 1B (local)', 'active',
             $3, 8192, 2048, 1024, $4)`,
    [modelId, providerId, JSON.stringify(LOCAL_CAPABILITIES), JSON.stringify(LOCAL_CONFIG)],
  );

  services.registry.invalidate();
  return modelId;
}

async function seedServerModel(): Promise<string> {
  const pool = getPool();
  const providerId = Bun.randomUUIDv7();
  const modelId = Bun.randomUUIDv7();

  await pool.query(
    `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref, status)
     VALUES ($1, $2, 'OpenAI', 'openai', 'OPENAI_API_KEY', 'active')`,
    [providerId, `p-${providerId}`],
  );

  await pool.query(
    `INSERT INTO ai_models (id, provider_id, api_model_id, display_name, status,
                            capabilities, context_window, max_output_tokens, default_max_output_tokens)
     VALUES ($1, $2, 'gpt-4o', 'GPT-4o', 'active', $3, 128000, 4096, 2048)`,
    [modelId, providerId, JSON.stringify(SERVER_CAPABILITIES)],
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

async function localTurn(
  conversationId: string,
  cookie: string,
  csrfToken: string,
  options: { key: string; body: unknown },
): Promise<Response> {
  return app.request(
    new Request(`http://localhost/api/conversations/${conversationId}/messages/local`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
        'Idempotency-Key': options.key,
      },
      body: JSON.stringify(options.body),
    }),
  );
}

async function localReply(
  conversationId: string,
  userMessageId: string,
  cookie: string,
  csrfToken: string,
  options: { key: string; body: unknown },
): Promise<Response> {
  return app.request(
    new Request(
      `http://localhost/api/conversations/${conversationId}/messages/${userMessageId}/local-reply`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: cookie,
          'X-CSRF-Token': csrfToken,
          'Idempotency-Key': options.key,
        },
        body: JSON.stringify(options.body),
      },
    ),
  );
}

describe('Local (browser-executed) message persistence (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
    (services.rateLimiter as MemoryRateLimiter).clear();
    services.registry.invalidate();
  });

  afterAll(async () => {
    await closePool();
  });

  it('stores a user turn and a reply without any generation or quota row', async () => {
    const modelId = await seedLocalModel();
    await seedUser('local@corp.example');
    const auth = await loginAs('local@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const turnRes = await localTurn(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      body: { parts: [{ type: 'text', text: 'Plan a trip to Kyoto' }] },
    });
    expect(turnRes.status).toBe(201);
    const turnBody = (await turnRes.json()) as {
      data: { userMessage: { id: string; seq: number; role: string; generationId: string | null } };
    };
    expect(turnBody.data.userMessage.role).toBe('user');
    expect(turnBody.data.userMessage.seq).toBe(1);
    expect(turnBody.data.userMessage.generationId).toBeNull();

    const replyRes = await localReply(convId, turnBody.data.userMessage.id, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      body: {
        parts: [{ type: 'text', text: 'Three days in Kyoto.' }],
        finishReason: 'stop',
        clientUsage: { inputTokens: 412, outputTokens: 96 },
      },
    });
    expect(replyRes.status).toBe(201);
    const replyBody = (await replyRes.json()) as {
      data: {
        assistantMessage: {
          id: string;
          seq: number;
          role: string;
          finishReason: string | null;
          generationId: string | null;
        };
      };
    };
    expect(replyBody.data.assistantMessage.role).toBe('assistant');
    expect(replyBody.data.assistantMessage.seq).toBe(2);
    expect(replyBody.data.assistantMessage.finishReason).toBe('stop');
    expect(replyBody.data.assistantMessage.generationId).toBeNull();

    const pool = getPool();
    const counts = await pool.query<{
      generations: string;
      reservations: string;
      usage: string;
      ledger: string;
    }>(
      `SELECT
         (SELECT count(*) FROM generation_jobs WHERE conversation_id = $1) AS generations,
         (SELECT count(*) FROM quota_reservations WHERE user_id = $2) AS reservations,
         (SELECT count(*) FROM usage_events WHERE user_id = $2) AS usage,
         (SELECT count(*) FROM quota_ledger WHERE user_id = $2) AS ledger`,
      [convId, auth.userId],
    );
    expect(counts.rows[0]?.generations).toBe('0');
    expect(counts.rows[0]?.reservations).toBe('0');
    expect(counts.rows[0]?.usage).toBe('0');
    expect(counts.rows[0]?.ledger).toBe('0');

    const metadata = await pool.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM messages WHERE id = $1',
      [replyBody.data.assistantMessage.id],
    );
    expect(metadata.rows[0]?.metadata['execution']).toBe('client');
    expect(metadata.rows[0]?.metadata['local']).toEqual({
      clientUsage: { inputTokens: 412, outputTokens: 96 },
    });
  });

  it('replays the original response for a repeated Idempotency-Key', async () => {
    const modelId = await seedLocalModel();
    await seedUser('replay@corp.example');
    const auth = await loginAs('replay@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const key = Bun.randomUUIDv7();
    const body = { parts: [{ type: 'text', text: 'Double click' }] };

    const first = await localTurn(convId, auth.cookie, auth.csrfToken, { key, body });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { userMessage: { id: string } } };
    expect(first.headers.get('Idempotency-Replayed')).toBeNull();

    const second = await localTurn(convId, auth.cookie, auth.csrfToken, { key, body });
    expect(second.status).toBe(201);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    const secondBody = (await second.json()) as { data: { userMessage: { id: string } } };
    expect(secondBody.data.userMessage.id).toBe(firstBody.data.userMessage.id);

    const { rows } = await getPool().query<{ count: string }>(
      'SELECT count(*) FROM messages WHERE conversation_id = $1',
      [convId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('rejects an Idempotency-Key reused with a different payload', async () => {
    const modelId = await seedLocalModel();
    await seedUser('reuse@corp.example');
    const auth = await loginAs('reuse@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const key = Bun.randomUUIDv7();
    await localTurn(convId, auth.cookie, auth.csrfToken, {
      key,
      body: { parts: [{ type: 'text', text: 'First' }] },
    });

    const res = await localTurn(convId, auth.cookie, auth.csrfToken, {
      key,
      body: { parts: [{ type: 'text', text: 'Second' }] },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('idempotency_key_reuse');
  });

  it('rejects a reply that no longer targets the latest turn', async () => {
    const modelId = await seedLocalModel();
    await seedUser('stale@corp.example');
    const auth = await loginAs('stale@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const firstTurn = await localTurn(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      body: { parts: [{ type: 'text', text: 'First turn' }] },
    });
    const firstBody = (await firstTurn.json()) as { data: { userMessage: { id: string } } };

    await localTurn(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      body: { parts: [{ type: 'text', text: 'Second turn' }] },
    });

    const res = await localReply(
      convId,
      firstBody.data.userMessage.id,
      auth.cookie,
      auth.csrfToken,
      {
        key: Bun.randomUUIDv7(),
        body: { parts: [{ type: 'text', text: 'Late answer' }], finishReason: 'stop' },
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('conflict');
  });

  it("returns 404 for another user's conversation", async () => {
    const modelId = await seedLocalModel();
    await seedUser('owner@corp.example');
    await seedUser('stranger@corp.example');
    const ownerAuth = await loginAs('owner@corp.example');
    const strangerAuth = await loginAs('stranger@corp.example');
    const convId = await createConversation(ownerAuth.cookie, ownerAuth.csrfToken, modelId);

    const res = await localTurn(convId, strangerAuth.cookie, strangerAuth.csrfToken, {
      key: Bun.randomUUIDv7(),
      body: { parts: [{ type: 'text', text: 'Not mine' }] },
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('not_found');
  });

  it('rejects the local endpoints for a server-executed model', async () => {
    const modelId = await seedServerModel();
    await seedUser('server@corp.example');
    const auth = await loginAs('server@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const res = await localTurn(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      body: { parts: [{ type: 'text', text: 'Hello' }] },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('unsupported_for_model');
  });

  it('rejects the server send path for a browser-executed model', async () => {
    const modelId = await seedLocalModel();
    await seedUser('wrongpath@corp.example');
    const auth = await loginAs('wrongpath@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const res = await app.request(
      new Request(`http://localhost/api/conversations/${convId}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          Cookie: auth.cookie,
          'X-CSRF-Token': auth.csrfToken,
          'Idempotency-Key': Bun.randomUUIDv7(),
        },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'Hello' }] }),
      }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('unsupported_for_model');
  });

  it('rejects unknown fields and non-text parts', async () => {
    const modelId = await seedLocalModel();
    await seedUser('strict@corp.example');
    const auth = await loginAs('strict@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const unknownField = await localTurn(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      body: { parts: [{ type: 'text', text: 'Hi' }], options: { maxOutputTokens: 10 } },
    });
    expect(unknownField.status).toBe(400);
    expect(((await unknownField.json()) as { code: string }).code).toBe('invalid_request');

    const filePart = await localTurn(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      body: { parts: [{ type: 'file', fileId: Bun.randomUUIDv7() }] },
    });
    expect(filePart.status).toBe(400);
    expect(((await filePart.json()) as { code: string }).code).toBe('invalid_request');
  });

  it('exposes the local model as client-executed in the model list', async () => {
    await seedLocalModel();
    await seedUser('models@corp.example');
    const auth = await loginAs('models@corp.example');

    const res = await app.request(
      new Request('http://localhost/api/models', { headers: { Cookie: auth.cookie } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        items: Array<{
          id: string;
          execution: string;
          local: { webllmModelId: string; tier: string; license: string } | null;
          limits: { maxFilesPerMessage: number; maxImagesPerMessage: number };
        }>;
      };
    };
    const local = body.data.items.find((item) => item.execution === 'client');
    expect(local).toBeDefined();
    expect(local?.local?.webllmModelId).toBe('Llama-3.2-1B-Instruct-q4f16_1-MLC');
    expect(local?.local?.tier).toBe('small');
    expect(local?.local?.license).toBe('Llama 3.2 Community License');
    expect(local?.limits.maxFilesPerMessage).toBe(0);
    expect(local?.limits.maxImagesPerMessage).toBe(0);
  });
});
