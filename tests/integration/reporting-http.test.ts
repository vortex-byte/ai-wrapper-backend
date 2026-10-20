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

async function seedUser(role: 'user' | 'admin' | 'super_admin', email: string): Promise<string> {
  let divisionId: string | undefined;
  if (role === 'admin') {
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO divisions (id, name) VALUES ($1, $2) RETURNING id`,
      [Bun.randomUUIDv7(), `Division ${email}`],
    );
    divisionId = result.rows[0]?.id;
  }

  const user = await users.create({
    id: Bun.randomUUIDv7(),
    email,
    displayName: `User ${email}`,
    passwordHash: await hasher.hash(PASSWORD),
    role,
    ...(divisionId !== undefined ? { divisionId } : {}),
    mustChangePassword: false,
    status: 'active',
  });
  return user.id;
}

function sessionCookie(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) return null;
  const match = /__Host-session=([^;]*)/.exec(setCookie);
  return match === null ? null : `__Host-session=${match[1]}`;
}

async function loginAs(email: string): Promise<string> {
  const res = await app.request(
    new Request('http://localhost/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(res.status).toBe(200);
  const cookie = sessionCookie(res);
  expect(cookie).not.toBeNull();
  return cookie ?? '';
}

async function get(path: string, cookie: string): Promise<Response> {
  return app.request(
    new Request(`http://localhost${path}`, {
      method: 'GET',
      headers: { Cookie: cookie, Origin: ORIGIN },
    }),
  );
}

async function seedUsageDay(): Promise<void> {
  const providerId = Bun.randomUUIDv7();
  const modelId = Bun.randomUUIDv7();

  await getPool().query(
    `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref)
     VALUES ($1, 'test-provider', 'Test Provider', 'openai', 'TEST_API_KEY')`,
    [providerId],
  );
  await getPool().query(
    `INSERT INTO ai_models
       (id, provider_id, key, api_model_id, display_name, status, capabilities,
        context_window, max_output_tokens, default_max_output_tokens)
     VALUES ($1, $2, 'test-model', 'test-model-1', 'Test Model', 'active',
             '{"schemaVersion":1}', 128000, 4096, 1024)`,
    [modelId, providerId],
  );

  const user = await users.create({
    id: Bun.randomUUIDv7(),
    email: 'usage@corp.example',
    displayName: 'Usage User',
    passwordHash: await hasher.hash(PASSWORD),
    role: 'user',
    mustChangePassword: false,
    status: 'active',
  });

  await getPool().query(
    `INSERT INTO usage_daily
       (day, user_id, division_id, provider_id, model_id, requests, failed_requests,
        provider_sourced_requests, input_tokens, output_tokens, quota_tokens, est_cost_micros)
     VALUES ('2026-10-18', $1, NULL, $2, $3, 4, 1, 3, 1000, 200, 1200, 5000)`,
    [user.id, providerId, modelId],
  );
}

describe('admin reporting surface (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
    (services.rateLimiter as MemoryRateLimiter).clear();
  });

  afterAll(async () => {
    await closePool();
  });

  it('is super_admin only: standard users and division admins get 403', async () => {
    await seedUser('user', 'user@corp.example');
    await seedUser('admin', 'admin@corp.example');

    const userCookie = await loginAs('user@corp.example');
    const adminCookie = await loginAs('admin@corp.example');

    for (const path of [
      '/api/admin/usage?groupBy=day',
      '/api/admin/usage/export?groupBy=day',
      '/api/admin/errors',
      '/api/admin/audit-logs',
    ]) {
      expect((await get(path, userCookie)).status).toBe(403);
      expect((await get(path, adminCookie)).status).toBe(403);
    }
  });

  it('aggregates usage from the daily rollup and reports the usage-source split', async () => {
    await seedUser('super_admin', 'root@corp.example');
    await seedUsageDay();
    const cookie = await loginAs('root@corp.example');

    const res = await get('/api/admin/usage?groupBy=day&from=2026-10-01&to=2026-10-31', cookie);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        items: Array<{
          key: Record<string, string | null>;
          requests: number;
          failedRequests: number;
          inputTokens: number;
          usageSource: { provider: number; estimated: number };
        }>;
      };
    };

    const row = body.data.items.find((item) => item.key['day'] === '2026-10-18');
    expect(row).toBeDefined();
    expect(row?.requests).toBe(4);
    expect(row?.failedRequests).toBe(1);
    expect(row?.inputTokens).toBe(1000);
    expect(row?.usageSource.provider).toBeCloseTo(0.75);
    expect(row?.usageSource.estimated).toBeCloseTo(0.25);
  });

  it('exports the same aggregate as CSV', async () => {
    await seedUser('super_admin', 'root@corp.example');
    await seedUsageDay();
    const cookie = await loginAs('root@corp.example');

    const res = await get('/api/admin/usage/export?groupBy=day&from=2026-10-01&to=2026-10-31', cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');

    const text = await res.text();
    expect(text.split('\r\n')[0]).toBe(
      'day,requests,failedRequests,inputTokens,outputTokens,quotaTokens,estimatedCostUsd,usageSourceProvider,usageSourceEstimated',
    );
    expect(text).toContain('2026-10-18,4,1,1000,200,1200,0.005000,0.750000,0.250000');
  });

  it('reports an unknown cost as null, not zero', async () => {
    await seedUser('super_admin', 'root@corp.example');
    await seedUsageDay();
    const cookie = await loginAs('root@corp.example');

    await getPool().query(
      `INSERT INTO usage_daily
         (day, user_id, division_id, provider_id, model_id, requests, failed_requests,
          provider_sourced_requests, input_tokens, output_tokens, quota_tokens, est_cost_micros)
       SELECT '2026-10-19', user_id, division_id, provider_id, model_id, 2, 0, 2, 10, 5, 15, NULL
         FROM usage_daily WHERE day = '2026-10-18'`,
    );

    const res = await get('/api/admin/usage?groupBy=day&from=2026-10-01&to=2026-10-31', cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: Array<{ key: Record<string, string | null>; estimatedCostUsd: number | null }> };
    };
    const row = body.data.items.find((item) => item.key['day'] === '2026-10-19');
    expect(row?.estimatedCostUsd).toBeNull();

    const csv = await get(
      '/api/admin/usage/export?groupBy=day&from=2026-10-01&to=2026-10-31',
      cookie,
    );
    expect(await csv.text()).toContain('2026-10-19,2,0,10,5,15,,1.000000,0.000000');
  });

  it('lists error events newest-first and redacts secret-looking context fields', async () => {
    await seedUser('super_admin', 'root@corp.example');
    const cookie = await loginAs('root@corp.example');

    await getPool().query(
      `INSERT INTO error_events (occurred_at, component, category, message, context)
       VALUES ('2026-10-18T10:00:00Z', 'orchestrator', 'provider_error', 'upstream failed',
               '{"apiKey":"sk-live-secret","attempt":2}')`,
    );

    const res = await get('/api/admin/errors?limit=10', cookie);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: {
        items: Array<{ message: string; context: Record<string, unknown> }>;
        nextCursor: string | null;
      };
    };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]?.message).toBe('upstream failed');
    expect(body.data.items[0]?.context['apiKey']).toBe('[redacted]');
    expect(body.data.items[0]?.context['attempt']).toBe(2);
    expect(body.data.nextCursor).toBeNull();
  });

  it('searches the audit log and redacts secrets in before/after', async () => {
    const actorId = await seedUser('super_admin', 'root@corp.example');
    const cookie = await loginAs('root@corp.example');

    await getPool().query(
      `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, before, after)
       VALUES ($1, 'user.password_reset', 'user', 'u-1',
               '{"passwordHash":"$argon2id$secret"}', '{"temporaryPassword":"Temp!123"}')`,
      [actorId],
    );

    const res = await get('/api/admin/audit-logs?action=user.password_reset', cookie);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { items: Array<{ before: Record<string, unknown>; after: Record<string, unknown> }> };
    };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]?.before['passwordHash']).toBe('[redacted]');
    expect(body.data.items[0]?.after['temporaryPassword']).toBe('[redacted]');
  });

  it('rejects a malformed pagination cursor with 400', async () => {
    await seedUser('super_admin', 'root@corp.example');
    const cookie = await loginAs('root@corp.example');

    const res = await get('/api/admin/audit-logs?cursor=%21%21%21', cookie);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('invalid_request');
  });
});
