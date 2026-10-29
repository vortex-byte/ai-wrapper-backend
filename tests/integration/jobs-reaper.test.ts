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

describe('Jobs Runtime & Reaper (P2-8)', () => {
  beforeEach(async () => {
    await resetDatabase();
    (services.rateLimiter as MemoryRateLimiter).clear();
    services.registry.invalidate();
    (services.providers.get('fake') as unknown as { scenario: string }).scenario = 'success';
  });

  afterAll(async () => {
    await closePool();
  });

  it('JobQueue enqueue, claim, execute and complete via JobRunner', async () => {
    let executedPayload: { task: string } | null = null;
    services.jobRunner.registerHandler('test.echo', async (payload: { task: string }) => {
      executedPayload = payload;
    });

    const jobId = await services.jobQueue.enqueue({
      type: 'test.echo',
      payload: { task: 'hello-job' },
      dedupeKey: 'unique-task-1',
    });
    expect(jobId).toBeDefined();

    const dupId = await services.jobQueue.enqueue({
      type: 'test.echo',
      payload: { task: 'hello-job-dup' },
      dedupeKey: 'unique-task-1',
    });
    expect(dupId).toBe(jobId);

    const pool = getPool();

    const count = await services.jobRunner.pollOnce();
    expect(count).toBe(1);
    expect(executedPayload).toEqual({ task: 'hello-job' });

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM jobs WHERE id = $1', [jobId]);
    expect(rows[0]?.status).toBe('done');
  });

  it('crash simulation (kill -9 story): reaper recovers crashed generation', async () => {
    const modelId = await seedActiveModel('fake');
    await seedUser('crasher@corp.example');
    const auth = await loginAs('crasher@corp.example');
    const convId = await createConversation(auth.cookie, auth.csrfToken, modelId);

    const sendRes = await send(convId, auth.cookie, auth.csrfToken, {
      key: Bun.randomUUIDv7(),
      text: 'Start generating',
    });
    expect(sendRes.status).toBe(202);
    const sendBody = (await sendRes.json()) as {
      data: { generation: { id: string }; assistantMessage: { id: string } };
    };
    const genId = sendBody.data.generation.id;
    const assistantId = sendBody.data.assistantMessage.id;

    const pool = getPool();

    // The run's own start() promise keeps executing in the background, so wait for it to become
    // quiescent *before* touching the assistant message: the live run owns the `message_parts`
    // row and the generation row, and a late checkpoint/finalize would overwrite this test's
    // hand-crafted crash state (the UNIQUE (message_id, position) index made that a race).
    const activeRun = services.orchestrator.getRun(genId);
    (services.orchestrator as unknown as { runs: Map<string, unknown> }).runs.delete(genId);
    if (activeRun) {
      // Aborting releases the provider stream and lets the run's background work drain.
      activeRun.abort('shutdown');
      for (let attempt = 0; attempt < 200 && !activeRun.isTerminal; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    // Overwrite the DB back to the "mid-stream" state the killed process left behind: one
    // streaming part holding the checkpointed text, and a stale `generating` row that no
    // in-memory run owns any more. Delete whatever the drained run wrote for determinism.
    await pool.query(`DELETE FROM message_parts WHERE message_id = $1`, [assistantId]);
    const partId = Bun.randomUUIDv7();
    await pool.query(
      `INSERT INTO message_parts (id, message_id, position, type, status, text_content)
       VALUES ($1, $2, 0, 'text', 'streaming', 'Partial text before crash...')`,
      [partId, assistantId],
    );

    await pool.query(
      `UPDATE generation_jobs
       SET status = 'generating',
           started_at = now() - interval '60 seconds',
           heartbeat_at = now() - interval '50 seconds'
       WHERE id = $1`,
      [genId],
    );

    const { reapedCount } = await services.reaperHandler();
    expect(reapedCount).toBe(1);

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
      'SELECT status, text_content FROM message_parts WHERE id = $1',
      [partId],
    );
    expect(partRows[0]?.status).toBe('incomplete');
    expect(partRows[0]?.text_content).toBe('Partial text before crash...');

    const secondPass = await services.reaperHandler();
    expect(secondPass.reapedCount).toBe(0);

    const streamRes = await app.request(
      new Request(`http://localhost/api/generations/${genId}/stream`, {
        headers: { Cookie: auth.cookie },
      }),
    );
    expect(streamRes.status).toBe(200);
    const streamText = await streamRes.text();
    expect(streamText).toContain('event: snapshot');
    expect(streamText).toContain('Partial text before crash...');
  });

  it('touchHeartbeat advances live rows and never resurrects terminal rows', async () => {
    const pool = getPool();
    const user = await seedUser(`hb-${Bun.randomUUIDv7().slice(0, 8)}@corp.example`);
    const providerId = Bun.randomUUIDv7();
    const modelId = Bun.randomUUIDv7();
    const conversationId = Bun.randomUUIDv7();
    const messageId = Bun.randomUUIDv7();
    const generationId = Bun.randomUUIDv7();

    await pool.query(
      `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref)
       VALUES ($1, $2, 'Fixture', 'fake', 'FAKE_KEY')`,
      [providerId, `p-${providerId}`],
    );
    await pool.query(
      `INSERT INTO ai_models (id, provider_id, api_model_id, display_name, status,
                              capabilities, context_window, max_output_tokens, default_max_output_tokens)
       VALUES ($1, $2, $3, 'Fixture Model', 'active', '{"schemaVersion":1}', 8192, 1024, 1024)`,
      [modelId, providerId, `api-${modelId}`],
    );
    await pool.query(`INSERT INTO conversations (id, user_id, model_id) VALUES ($1, $2, $3)`, [
      conversationId,
      user.id,
      modelId,
    ]);
    await pool.query(
      `INSERT INTO messages (id, conversation_id, seq, role, status)
       VALUES ($1, $2, 1, 'assistant', 'streaming')`,
      [messageId, conversationId],
    );
    await pool.query(
      `INSERT INTO generation_jobs
         (id, request_id, user_id, conversation_id, assistant_message_id, model_id, provider_id,
          status, max_output_tokens, started_at, heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'generating', 1024, now() - interval '60 seconds',
               now() - interval '60 seconds')`,
      [generationId, `req-${generationId}`, user.id, conversationId, messageId, modelId, providerId],
    );

    const firstBeat = new Date(Date.now() + 5 * 60_000);
    await services.generationRepository.touchHeartbeat(generationId, firstBeat);
    const { rows: afterFirst } = await pool.query<{ heartbeat_at: Date }>(
      'SELECT heartbeat_at FROM generation_jobs WHERE id = $1',
      [generationId],
    );
    const firstRow = afterFirst[0];
    const firstHeartbeat = firstRow?.heartbeat_at;
    const firstDelta = firstHeartbeat
      ? Math.abs(firstHeartbeat.getTime() - firstBeat.getTime())
      : Number.POSITIVE_INFINITY;
    expect(firstDelta).toBeLessThan(200);

    await pool.query(
      `UPDATE generation_jobs SET status = 'completed', finished_at = now() WHERE id = $1`,
      [generationId],
    );
    const { rows: beforeSecond } = await pool.query<{ heartbeat_at: Date }>(
      'SELECT heartbeat_at FROM generation_jobs WHERE id = $1',
      [generationId],
    );

    // A late heartbeat from a still-running worker must not move a terminal row forward.
    const secondBeat = new Date(Date.now() + 10 * 60_000);
    await services.generationRepository.touchHeartbeat(generationId, secondBeat);
    const { rows: afterSecond } = await pool.query<{ status: string; heartbeat_at: Date }>(
      'SELECT status, heartbeat_at FROM generation_jobs WHERE id = $1',
      [generationId],
    );
    expect(afterSecond[0]?.status).toBe('completed');
    expect(afterSecond[0]?.heartbeat_at?.getTime()).toBe(beforeSecond[0]?.heartbeat_at?.getTime());
  });

  it('fail() applies capped exponential backoff and marks exhausted jobs dead', async () => {
    const pool = getPool();
    const jobId = await services.jobQueue.enqueue({
      type: 'backoff.test',
      payload: {},
      maxAttempts: 3,
    });

    // Claim once (attempt 1) then fail: run_at must be pushed out, and the delay must be bounded
    // by the exponentially-growing cap, not a fixed linear step.
    const claimed = await services.jobQueue.claim('worker-test');
    expect(claimed.some((j) => j.id === jobId)).toBe(true);

    const before = Date.now();
    await services.jobQueue.fail(jobId, 'boom');
    const { rows: afterFirst } = await pool.query<{ status: string; run_at: Date }>(
      'SELECT status, run_at FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(afterFirst[0]?.status).toBe('queued');
    const delayMs = (afterFirst[0]?.run_at.getTime() ?? before) - before;
    expect(delayMs).toBeLessThanOrEqual(5_000);
    expect(delayMs).toBeGreaterThanOrEqual(0);

    await pool.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [jobId]);
    await services.jobQueue.claim('worker-test');
    await services.jobQueue.fail(jobId, 'boom');
    await pool.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [jobId]);
    await services.jobQueue.claim('worker-test');
    await services.jobQueue.fail(jobId, 'boom');

    const { rows: finalRows } = await pool.query<{ status: string }>(
      'SELECT status FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(finalRows[0]?.status).toBe('dead');
  });

  it('scheduler enqueues one job per interval slot and the xact lock is released', async () => {
    const pool = getPool();
    const { Scheduler } = await import('@/jobs/application/scheduler.ts');
    const task = { name: 'test-lock', jobType: 'test.lockjob', intervalMs: 3_600_000 } as const;
    const scheduler = new Scheduler(services.jobQueue, [task]);

    const first = await scheduler.scheduleTask(task);
    expect(first).toBe(true);

    const second = await scheduler.scheduleTask(task);
    expect(second).toBe(true);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE type = 'test.lockjob'`,
    );
    expect(rows[0]?.count).toBe('1');

    // The transaction-scoped advisory lock must be released when the transaction ends: a fresh
    // call still acquires it (a session-level leak would block this after the first call).
    const third = await scheduler.scheduleTask(task);
    expect(third).toBe(true);
  });

  it('hourly purges clean up expired idempotency keys and sessions', async () => {
    const pool = getPool();
    const userId = Bun.randomUUIDv7();
    await pool.query(
      `INSERT INTO users (id, email, display_name, password_hash)
       VALUES ($1, 'purge@corp.example', 'Purge User', 'dummy')`,
      [userId],
    );

    await pool.query(
      `INSERT INTO idempotency_keys (user_id, key, endpoint, request_hash, response_status, response_body, expires_at)
       VALUES ($1, 'expired-key-1', '/api/test', 'hash-1', 200, '{}', now() - interval '1 hour')`,
      [userId],
    );

    await pool.query(
      `INSERT INTO idempotency_keys (user_id, key, endpoint, request_hash, response_status, response_body, expires_at)
       VALUES ($1, 'active-key-1', '/api/test', 'hash-2', 200, '{}', now() + interval '1 hour')`,
      [userId],
    );

    await services.jobQueue.enqueue({ type: 'idempotency.purge', payload: {} });
    await services.jobRunner.pollOnce();

    const { rows: idempRows } = await pool.query<{ key: string }>('SELECT key FROM idempotency_keys WHERE user_id = $1', [
      userId,
    ]);
    expect(idempRows.length).toBe(1);
    expect(idempRows[0]?.key).toBe('active-key-1');
  });
});
