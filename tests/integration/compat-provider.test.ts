import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '@/app.ts';
import { createServices, type Services } from '@/services.ts';
import { BunPasswordHasher } from '@/auth/infrastructure/bun-password-hasher.ts';
import { DrizzleUserRepository } from '@/auth/infrastructure/drizzle-user-repository.ts';
import { loadConfig, type Config } from '@/config/index.ts';
import { closePool } from '@/db/index.ts';
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

async function loginAsSuperAdmin(): Promise<{ cookie: string; csrfToken: string }> {
  await users.create({
    id: Bun.randomUUIDv7(),
    email: 'super@corp.example',
    displayName: 'Super Admin',
    passwordHash: await hasher.hash(PASSWORD),
    role: 'super_admin',
    mustChangePassword: false,
    status: 'active',
  });
  const res = await app.request(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email: 'super@corp.example', password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { csrfToken: string } };
  const setCookie = res.headers.get('set-cookie');
  const match = setCookie === null ? null : /__Host-session=([^;]*)/.exec(setCookie);
  if (match === null) throw new Error('no session cookie issued');
  return { cookie: `__Host-session=${match[1]}`, csrfToken: body.data.csrfToken };
}

function authed(
  path: string,
  session: { cookie: string; csrfToken: string },
  method: string,
  body?: unknown,
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: ORIGIN,
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrfToken,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function createCompatProvider(
  session: { cookie: string; csrfToken: string },
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await app.request(
    authed('/api/admin/providers', session, 'POST', {
      key: 'compat-main',
      displayName: 'Compatible gateway',
      adapter: 'openai',
      baseUrl: 'https://llm.internal.example/v1',
      secretRef: 'COMPAT_API_KEY',
      status: 'active',
      ...overrides,
    }),
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

function modelBody(providerId: string, overrides: Record<string, unknown> = {}) {
  return {
    providerId,
    apiModelId: 'compat-model',
    displayName: 'Compat Model',
    status: 'active',
    capabilities: {
      contextWindow: 32_000,
      maxOutputTokens: 4_096,
    },
    ...overrides,
  };
}

describe('compatible provider onboarding (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
    (services.rateLimiter as MemoryRateLimiter).clear();
    services.registry.invalidate();
  });

  afterAll(async () => {
    await closePool();
  });

  it('derives a narrowed dialect from a custom base URL', async () => {
    const session = await loginAsSuperAdmin();
    await createCompatProvider(session);

    const res = await app.request(authed('/api/admin/providers', session, 'GET'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: Array<{ key: string; dialect: Record<string, unknown> }> };
    };
    const provider = body.data.items.find((item) => item.key === 'compat-main');
    expect(provider?.dialect['responses']).toBe(false);
    expect(provider?.dialect['containers']).toBe(false);
    expect((provider?.dialect['chatPayload'] as { maxTokens: string }).maxTokens).toBe(
      'max_tokens',
    );
  });

  it('rejects capabilities the dialect cannot serve at save time', async () => {
    const session = await loginAsSuperAdmin();
    const providerId = await createCompatProvider(session);

    const res = await app.request(
      authed(
        '/api/admin/models',
        session,
        'POST',
        modelBody(providerId, {
          capabilities: {
            contextWindow: 32_000,
            maxOutputTokens: 4_096,
            documentGeneration: true,
            promptCaching: { supported: true },
            documents: { pdf: true },
          },
        }),
      ),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      code: string;
      details: { fields: Array<{ field: string }> };
    };
    expect(body.code).toBe('invalid_request');
    expect(body.details.fields.map((field) => field.field)).toEqual([
      'documentGeneration',
      'promptCaching',
      'documents.pdf',
    ]);
  });

  it('accepts capabilities the dialect can serve', async () => {
    const session = await loginAsSuperAdmin();
    const providerId = await createCompatProvider(session);

    const res = await app.request(
      authed(
        '/api/admin/models',
        session,
        'POST',
        modelBody(providerId, {
          capabilities: {
            contextWindow: 32_000,
            maxOutputTokens: 4_096,
            vision: true,
            reasoning: { availableEfforts: ['low'], defaultEffort: 'low' },
          },
        }),
      ),
    );

    expect(res.status).toBe(201);
  });

  it('lets an explicit dialect override widen the provider', async () => {
    const session = await loginAsSuperAdmin();
    const providerId = await createCompatProvider(session, {
      config: {
        dialect: {
          responses: true,
          containers: true,
          documentInput: { pdf: 'native' },
        },
      },
    });

    const res = await app.request(
      authed(
        '/api/admin/models',
        session,
        'POST',
        modelBody(providerId, {
          capabilities: {
            contextWindow: 32_000,
            maxOutputTokens: 4_096,
            documentGeneration: true,
            documents: { pdf: true },
          },
        }),
      ),
    );

    expect(res.status).toBe(201);
  });
});
