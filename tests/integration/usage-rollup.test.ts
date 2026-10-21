import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/db/index.ts';
import { DrizzleUsageRepository } from '@/quota/infrastructure/drizzle-usage-repository.ts';
import { resetDatabase } from './helpers/reset.ts';

const usageRepo = new DrizzleUsageRepository();

interface SeedContext {
  readonly userId: string;
  readonly divisionId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly accountId: string;
}

async function seedPrerequisites(): Promise<SeedContext> {
  const pool = getPool();
  const divisionId = Bun.randomUUIDv7();
  await pool.query(`INSERT INTO divisions (id, name) VALUES ($1, $2)`, [
    divisionId,
    `Div-${divisionId}`,
  ]);

  const userId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO users (id, email, display_name, password_hash, division_id)
     VALUES ($1, $2, 'Usage User', 'not-used', $3)`,
    [userId, `user-${userId}@corp.example`, divisionId],
  );

  const providerId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref)
     VALUES ($1, $2, 'Usage Provider', 'openai', 'TEST_KEY')`,
    [providerId, `provider-${providerId}`],
  );

  const modelId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO ai_models
       (id, provider_id, key, api_model_id, display_name, status, capabilities,
        context_window, max_output_tokens, default_max_output_tokens)
     VALUES ($1, $2, $3, 'model-1', 'Model 1', 'active', '{"schemaVersion":1}',
             128000, 4096, 1024)`,
    [modelId, providerId, `model-${modelId}`],
  );

  const accountId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO quota_accounts
       (id, user_id, scope_type, period_start, period_end, base_limit_tokens)
     VALUES ($1, $2, 'total', '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z', 1000000)`,
    [accountId, userId],
  );

  return { userId, divisionId, providerId, modelId, accountId };
}

async function seedGenerationAndUsageEvent(
  ctx: SeedContext,
  opts: {
    readonly day: string;
    readonly outcome: 'completed' | 'failed';
    readonly usageSource: 'provider' | 'estimated';
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly quotaTokens: number;
    readonly estCostMicros: number;
    readonly divisionId?: string | null;
  },
): Promise<void> {
  const pool = getPool();
  const convId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO conversations (id, user_id, model_id, title, message_count)
     VALUES ($1, $2, $3, 'Test Conv', 2)`,
    [convId, ctx.userId, ctx.modelId],
  );

  const asstMsgId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO messages (id, conversation_id, seq, role, status)
     VALUES ($1, $2, 1, 'user', 'complete'), ($3, $2, 2, 'assistant', 'complete')`,
    [Bun.randomUUIDv7(), convId, asstMsgId],
  );

  const genId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO generation_jobs
       (id, conversation_id, user_id, model_id, provider_id, assistant_message_id, request_id, status, max_output_tokens, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed', 1000, now())`,
    [genId, convId, ctx.userId, ctx.modelId, ctx.providerId, asstMsgId, `req-${genId}`],
  );

  const eventId = Bun.randomUUIDv7();
  const divisionId = opts.divisionId !== undefined ? opts.divisionId : ctx.divisionId;
  await pool.query(
    `INSERT INTO usage_events
       (id, generation_id, user_id, division_id, provider_id, model_id, account_id,
        input_tokens, output_tokens, quota_tokens, usage_source, est_cost_micros,
        outcome, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz)`,
    [
      eventId,
      genId,
      ctx.userId,
      divisionId,
      ctx.providerId,
      ctx.modelId,
      ctx.accountId,
      opts.inputTokens,
      opts.outputTokens,
      opts.quotaTokens,
      opts.usageSource,
      opts.estCostMicros,
      opts.outcome,
      `${opts.day}T10:00:00Z`,
    ],
  );
}

describe('UsageRepository.rollupDay integration test', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('aggregates usage_events into usage_daily without min(uuid) failure', async () => {
    const ctx = await seedPrerequisites();
    const day = '2026-10-21';

    // Seed two events on the same day for the same user and model
    await seedGenerationAndUsageEvent(ctx, {
      day,
      outcome: 'completed',
      usageSource: 'provider',
      inputTokens: 100,
      outputTokens: 50,
      quotaTokens: 150,
      estCostMicros: 300,
    });

    await seedGenerationAndUsageEvent(ctx, {
      day,
      outcome: 'failed',
      usageSource: 'estimated',
      inputTokens: 200,
      outputTokens: 0,
      quotaTokens: 200,
      estCostMicros: 400,
    });

    // Run rollupDay - should not throw 42883 (fungsi min(uuid) tidak ada)
    const rolled = await usageRepo.rollupDay(day);
    expect(rolled).toBe(1);

    // Verify row in usage_daily
    const pool = getPool();
    const res = await pool.query<{
      day: string;
      user_id: string;
      division_id: string;
      provider_id: string;
      model_id: string;
      requests: number;
      failed_requests: number;
      provider_sourced_requests: number;
      input_tokens: string;
      output_tokens: string;
      quota_tokens: string;
      est_cost_micros: string;
    }>(
      `SELECT * FROM usage_daily WHERE day = $1 AND user_id = $2 AND model_id = $3`,
      [day, ctx.userId, ctx.modelId],
    );

    expect(res.rows).toHaveLength(1);
    const row = res.rows[0]!;
    expect(row.division_id).toBe(ctx.divisionId);
    expect(Number(row.requests)).toBe(2);
    expect(Number(row.failed_requests)).toBe(1);
    expect(Number(row.provider_sourced_requests)).toBe(1);
    expect(Number(row.input_tokens)).toBe(300);
    expect(Number(row.output_tokens)).toBe(50);
    expect(Number(row.quota_tokens)).toBe(350);
    expect(Number(row.est_cost_micros)).toBe(700);

    // Verify idempotent re-run
    const rolledAgain = await usageRepo.rollupDay(day);
    expect(rolledAgain).toBe(1);
  });

  it('works with createUsageRollupHandler incremental runner', async () => {
    const ctx = await seedPrerequisites();
    const today = new Date().toISOString().slice(0, 10);

    await seedGenerationAndUsageEvent(ctx, {
      day: today,
      outcome: 'completed',
      usageSource: 'provider',
      inputTokens: 50,
      outputTokens: 50,
      quotaTokens: 100,
      estCostMicros: 200,
    });

    const { createUsageRollupHandler } = await import(
      '@/jobs/application/handlers/usage-rollup-handler.ts'
    );
    const handler = createUsageRollupHandler({ usage: usageRepo });
    const result = await handler.incremental();

    expect(result.day).toBe(today);
    expect(result.rows).toBe(1);
  });

  it('handles null division_id correctly in rollupDay aggregation', async () => {
    const ctx = await seedPrerequisites();
    const day = '2026-10-21';

    await seedGenerationAndUsageEvent(ctx, {
      day,
      outcome: 'completed',
      usageSource: 'provider',
      inputTokens: 80,
      outputTokens: 20,
      quotaTokens: 100,
      estCostMicros: 150,
      divisionId: null,
    });

    const rolled = await usageRepo.rollupDay(day);
    expect(rolled).toBe(1);

    const pool = getPool();
    const res = await pool.query<{ division_id: string | null }>(
      `SELECT division_id FROM usage_daily WHERE day = $1 AND user_id = $2 AND model_id = $3`,
      [day, ctx.userId, ctx.modelId],
    );

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.division_id).toBeNull();
  });
});
