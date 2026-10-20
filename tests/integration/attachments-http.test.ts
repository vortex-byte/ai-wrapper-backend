import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '@/app.ts';
import { createServices, type Services } from '@/services.ts';
import { BunPasswordHasher } from '@/auth/infrastructure/bun-password-hasher.ts';
import { DrizzleUserRepository } from '@/auth/infrastructure/drizzle-user-repository.ts';
import { loadConfig, type Config } from '@/config/index.ts';
import { closePool, getPool } from '@/db/index.ts';
import { resetDatabase } from './helpers/reset.ts';

const SECRET = 'integration-session-secret-0123456789abcdef';
const ORIGIN = 'https://app.corp.example';
const PASSWORD = 'correct horse battery staple';

/** A valid 1×1 PNG — enough for magic-byte detection and the IHDR dimension check. */
const PNG_1X1 = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  ),
  (char) => char.charCodeAt(0),
);

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

async function seedUser(email: string): Promise<void> {
  await users.create({
    id: Bun.randomUUIDv7(),
    email,
    displayName: 'attachment user',
    passwordHash: await hasher.hash(PASSWORD),
    role: 'user',
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

function uploadRequest(
  conversationId: string,
  cookie: string,
  csrfToken: string,
  fileName = 'pixel.png',
): Request {
  const form = new FormData();
  form.append('files', new Blob([PNG_1X1], { type: 'image/png' }), fileName);
  return new Request(`http://localhost/api/conversations/${conversationId}/attachments`, {
    method: 'POST',
    headers: { Origin: ORIGIN, Cookie: cookie, 'X-CSRF-Token': csrfToken },
    body: form,
  });
}

describe('Attachments HTTP surface (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('uploads, reports status, and serves the bytes with range support', async () => {
    await seedUser('attach@corp.example');
    const auth = await loginAs('attach@corp.example');
    const modelId = await seedActiveModel();
    const conversationId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const uploaded = await app.request(uploadRequest(conversationId, auth.cookie, auth.csrfToken));
    expect(uploaded.status).toBe(201);
    const uploadBody = (await uploaded.json()) as {
      status: string;
      data: { items: Array<Record<string, unknown>> };
    };
    expect(uploadBody.status).toBe('ok');
    const item = uploadBody.data.items[0];
    expect(item).toMatchObject({
      name: 'pixel.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: PNG_1X1.byteLength,
      status: 'ready',
    });
    // Storage internals never cross the wire.
    expect(item?.['storageKey']).toBeUndefined();
    const attachmentId = item?.['id'] as string;

    const status = await app.request(
      new Request(`http://localhost/api/attachments/${attachmentId}`, {
        headers: { Cookie: auth.cookie },
      }),
    );
    expect(status.status).toBe(200);
    expect(((await status.json()) as { data: { status: string } }).data.status).toBe('ready');

    const content = await app.request(
      new Request(`http://localhost/api/files/${attachmentId}/content`, {
        headers: { Cookie: auth.cookie },
      }),
    );
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(content.headers.get('content-length')).toBe(String(PNG_1X1.byteLength));
    expect(content.headers.get('x-content-type-options')).toBe('nosniff');
    expect(content.headers.get('cache-control')).toBe('private, no-store');
    expect(content.headers.get('content-disposition')).toContain('inline');
    expect((await content.arrayBuffer()).byteLength).toBe(PNG_1X1.byteLength);

    const ranged = await app.request(
      new Request(`http://localhost/api/files/${attachmentId}/content`, {
        headers: { Cookie: auth.cookie, Range: 'bytes=0-9' },
      }),
    );
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-length')).toBe('10');
    expect(ranged.headers.get('content-range')).toBe(`bytes 0-9/${PNG_1X1.byteLength}`);
    expect((await ranged.arrayBuffer()).byteLength).toBe(10);
  });

  it('requires authentication and never turns an unknown path into a 401 (CRITICAL-01)', async () => {
    const unauthenticated = await app.request(
      new Request('http://localhost/api/conversations/c-1/attachments', {
        method: 'POST',
        headers: { Origin: ORIGIN },
      }),
    );
    expect(unauthenticated.status).toBe(401);

    const unknown = await app.request(
      new Request('http://localhost/api/definitely-not-a-route', {
        headers: { Cookie: 'bogus' },
      }),
    );
    expect(unknown.status).toBe(404);
  });

  it("returns 404 for another user's attachment (IDOR)", async () => {
    await seedUser('owner3@corp.example');
    await seedUser('intruder3@corp.example');
    const owner = await loginAs('owner3@corp.example');
    const intruder = await loginAs('intruder3@corp.example');
    const modelId = await seedActiveModel();
    const conversationId = await createConversation(owner.cookie, owner.csrfToken, modelId);

    const uploaded = await app.request(uploadRequest(conversationId, owner.cookie, owner.csrfToken));
    const attachmentId = ((await uploaded.json()) as { data: { items: Array<{ id: string }> } }).data
      .items[0]?.id as string;

    for (const path of [`/api/attachments/${attachmentId}`, `/api/files/${attachmentId}/content`]) {
      const res = await app.request(
        new Request(`http://localhost${path}`, { headers: { Cookie: intruder.cookie } }),
      );
      expect(res.status).toBe(404);
    }
  });

  it('refuses a file the caller does not own by conversation id', async () => {
    await seedUser('owner4@corp.example');
    await seedUser('intruder4@corp.example');
    const owner = await loginAs('owner4@corp.example');
    const intruder = await loginAs('intruder4@corp.example');
    const modelId = await seedActiveModel();
    const ownerConversation = await createConversation(owner.cookie, owner.csrfToken, modelId);

    // Uploading into someone else's conversation is a 404, not a 403.
    const res = await app.request(
      uploadRequest(ownerConversation, intruder.cookie, intruder.csrfToken),
    );
    expect(res.status).toBe(404);
  });
});
