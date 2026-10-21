import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { RealQuota } from '@/quota/infrastructure/real-quota.ts';
import { DrizzleQuotaAccountRepository } from '@/quota/infrastructure/drizzle-quota-account-repository.ts';
import { DrizzleQuotaPolicyRepository } from '@/quota/infrastructure/drizzle-quota-policy-repository.ts';
import { DrizzleUsageRepository } from '@/quota/infrastructure/drizzle-usage-repository.ts';
import { createReconciliationHandler } from '@/jobs/application/handlers/reconciliation-handler.ts';
import { createPrecreatePeriodsHandler } from '@/jobs/application/handlers/precreate-periods-handler.ts';
import { QuotaService } from '@/quota/application/quota-service.ts';
import { systemClock, uuidv7Generator } from '@/clock/index.ts';
import { closePool, getPool } from '@/db/index.ts';
import { withTransaction } from '@/db/tx.ts';
import { AppError } from '@/errors.ts';
import { resetDatabase } from './helpers/reset.ts';

/**
 * Quota accounting integration tests against PostgreSQL.
 */

const accounts = new DrizzleQuotaAccountRepository();
const policies = new DrizzleQuotaPolicyRepository();
const usage = new DrizzleUsageRepository();
const quota = new RealQuota({
  accounts,
  policies,
  usage,
  clock: systemClock,
  idGen: uuidv7Generator,
  quotaTimezone: 'Asia/Jakarta',
});
const reconciliationHandler = createReconciliationHandler({ accounts, clock: systemClock });
const quotaService = new QuotaService({
  accounts,
  policies,
  usage,
  idGen: () => uuidv7Generator.uuidv7(),
  quotaTimezone: 'Asia/Jakarta',
});

async function seedUserAndModel(): Promise<{ userId: string; modelId: string; providerId: string }> {
  const pool = getPool();
  const userId = Bun.randomUUIDv7();
  const modelId = Bun.randomUUIDv7();
  const providerId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO users (id, email, display_name, password_hash, role, status, must_change_password)
     VALUES ($1, $2, 'Quota User', 'x', 'user', 'active', false)`,
    [userId, `quota-${userId}@corp.example`],
  );
  await pool.query(
    `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref, status)
     VALUES ($1, $2, 'Fake', 'fake', 'FAKE_KEY', 'active')`,
    [providerId, `p-${providerId}`],
  );
  await pool.query(
    `INSERT INTO ai_models (id, provider_id, key, api_model_id, display_name, status,
                            capabilities, context_window, max_output_tokens, default_max_output_tokens)
     VALUES ($1, $2, $3, 'fake-model', 'Fake', 'active', '{}', 128000, 4096, 2048)`,
    [modelId, providerId, `m-${modelId}`],
  );
  return { userId, modelId, providerId };
}

async function seedGeneration(
  userId: string,
  modelId: string,
  providerId: string,
  status: 'pending' | 'generating' | 'completed' = 'generating',
): Promise<string> {
  const pool = getPool();
  const generationId = Bun.randomUUIDv7();
  // generation_jobs requires a conversation + assistant message; create minimal rows.
  const conversationId = Bun.randomUUIDv7();
  const userMessageId = Bun.randomUUIDv7();
  const assistantMessageId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO conversations (id, user_id, model_id, title) VALUES ($1, $2, $3, 't')`,
    [conversationId, userId, modelId],
  );
  await pool.query(
    `INSERT INTO messages (id, conversation_id, seq, role, status)
     VALUES ($1, $2, 0, 'user', 'complete'), ($3, $2, 1, 'assistant', 'streaming')`,
    [userMessageId, conversationId, assistantMessageId],
  );
  await pool.query(
    `INSERT INTO generation_jobs (id, request_id, user_id, conversation_id, assistant_message_id,
                                  model_id, provider_id, status, started_at, heartbeat_at, max_output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             CASE WHEN $8 IN ('generating','completed') THEN now() ELSE NULL END,
             CASE WHEN $8 = 'generating' THEN now() ELSE NULL END, 4096)`,
    [generationId, `req-${generationId}`, userId, conversationId, assistantMessageId, modelId, providerId, status],
  );
  return generationId;
}

/** Reserve against a real generation row (the concurrency test creates these up front). */
function reserveFor(
  userId: string,
  generationId: string,
  modelId: string,
  providerId: string,
  inputTokens: number,
  maxOutput: number,
  modelMaxOutputTokens = 4096,
) {
  return (tx: Parameters<typeof quota.reserve>[1]) =>
    quota.reserve(
      {
        userId,
        generationId,
        providerId,
        modelId,
        estimatedInputTokens: inputTokens,
        requestedMaxOutputTokens: maxOutput,
        modelMaxOutputTokens,
        quotaWeight: 1,
        hasMediaParts: false,
      },
      tx,
    );
}

describe('quota reservation concurrency', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('the 100,000-limit / 50×20,000 test: exactly 5 succeed', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();
    const pool = getPool();

    // Fixed policy so the account limit is exactly 100,000 (concurrency raised for this test).
    await pool.query(
      `INSERT INTO quota_policies (id, scope, monthly_tokens, max_concurrent_generations)
       VALUES ($1, 'global', 100000, 100)`,
      [Bun.randomUUIDv7()],
    );

    // 50 live generations (each reservation needs its own generation row).
    const generationIds = await Promise.all(
      Array.from({ length: 50 }, () => seedGeneration(userId, modelId, providerId)),
    );

    // All 50 reserve 20,000 concurrently (10k input + 10k output). The account row's
    // conditional UPDATE serializes them.
    const results = await Promise.allSettled(
      generationIds.map((generationId) =>
        withTransaction(reserveFor(userId, generationId, modelId, providerId, 10_000, 10_000, 10_000)),
      ),
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r) => r.status === 'rejected' && (r.reason as AppError)?.code === 'quota_exceeded',
    );
    expect(succeeded.length).toBe(5);
    expect(rejected.length).toBe(45);

    // Rejections rolled back their whole transaction: no reservation rows, no ledger rows.
    const reservationCount = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM quota_reservations`,
    );
    const reservationRow = reservationCount.rows[0]!;
    expect(Number.parseInt(reservationRow.count, 10)).toBe(5);

    // Counter invariant: used + reserved <= limit.
    const account = await accounts.findCurrentAccount(userId, new Date());
    expect(account).not.toBeNull();
    if (account) {
      expect(account.usedTokens + account.reservedTokens).toBeLessThanOrEqual(100_000);
      expect(account.reservedTokens).toBe(100_000); // 5 × 20,000
    }
  });

  it('releases reserved tokens back when a generation fails before the provider', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();
    await getPool().query(
      `INSERT INTO quota_policies (id, scope, monthly_tokens, max_concurrent_generations)
       VALUES ($1, 'global', 100000, 100)`,
      [Bun.randomUUIDv7()],
    );
    const generationId = await seedGeneration(userId, modelId, providerId, 'pending');

    await withTransaction(reserveFor(userId, generationId, modelId, providerId, 5_000, 5_000));
    let account = await accounts.findCurrentAccount(userId, new Date());
    // est input 5,000 + output clamped to the model's 4,096 cap = 9,096.
    expect(account?.reservedTokens).toBe(9_096);

    // Release path: provider never accepted the request.
    await withTransaction((tx) =>
      quota.settleOrRelease({ generationId, outcome: 'released', actualTokens: 0 }, tx),
    );
    account = await accounts.findCurrentAccount(userId, new Date());
    expect(account?.reservedTokens).toBe(0);
    expect(account?.usedTokens).toBe(0);
  });

  it('settles actual usage with overshoot beyond the reservation', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();
    await getPool().query(
      `INSERT INTO quota_policies (id, scope, monthly_tokens, max_concurrent_generations)
       VALUES ($1, 'global', 100000, 100)`,
      [Bun.randomUUIDv7()],
    );
    const generationId = await seedGeneration(userId, modelId, providerId, 'generating');

    await withTransaction(reserveFor(userId, generationId, modelId, providerId, 5_000, 5_000));

    // Provider reports more than reserved (input underestimated).
    await withTransaction((tx) =>
      quota.settleOrRelease(
        {
          generationId,
          outcome: 'settled',
          actualTokens: 12_000,
          usage: { inputTokens: 7_000, outputTokens: 5_000, source: 'provider' },
          outcomeCategory: 'completed',
        },
        tx,
      ),
    );

    const account = await accounts.findCurrentAccount(userId, new Date());
    expect(account?.reservedTokens).toBe(0);
    expect(account?.usedTokens).toBe(12_000);

    // Usage event written once, with overshoot.
    const event = await getPool().query<{ quota_tokens: string; overshoot_tokens: string; usage_source: string }>(
      `SELECT quota_tokens, overshoot_tokens, usage_source FROM usage_events WHERE generation_id = $1`,
      [generationId],
    );
    expect(event.rows.length).toBe(1);
    const row = event.rows[0]!;
    expect(Number.parseInt(row.quota_tokens, 10)).toBe(12_000);
    // Settled quota tokens 12,000 − reserved 9,096 (5,000 input + 4,096 model-capped output).
    expect(Number.parseInt(row.overshoot_tokens, 10)).toBe(2_904);
    expect(row.usage_source).toBe('provider');

    // Settlement is idempotent: a replay must not double-count.
    await withTransaction((tx) =>
      quota.settleOrRelease(
        {
          generationId,
          outcome: 'settled',
          actualTokens: 12_000,
          usage: { inputTokens: 7_000, outputTokens: 5_000, source: 'provider' },
        },
        tx,
      ),
    );
    const accountAfter = await accounts.findCurrentAccount(userId, new Date());
    expect(accountAfter?.usedTokens).toBe(12_000);
    const events = await getPool().query(`SELECT 1 FROM usage_events WHERE generation_id = $1`, [
      generationId,
    ]);
    expect(events.rows.length).toBe(1);
  });

  it('rejects with quota_exceeded including remaining/resetAt details', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();
    await getPool().query(
      `INSERT INTO quota_policies (id, scope, monthly_tokens, max_concurrent_generations)
       VALUES ($1, 'global', 1000, 100)`,
      [Bun.randomUUIDv7()],
    );
    const generationId = await seedGeneration(userId, modelId, providerId);
    try {
      await withTransaction(reserveFor(userId, generationId, modelId, providerId, 900, 500));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe('quota_exceeded');
      const details = appErr.details as { remainingTokens: number; resetAt: string };
      expect(details.remainingTokens).toBe(1_000);
      expect(details.resetAt).toBeTruthy();
    }
  });

  it('nightly reconciliation derives counters from the ledger exactly', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();
    await getPool().query(
      `INSERT INTO quota_policies (id, scope, monthly_tokens, max_concurrent_generations)
       VALUES ($1, 'global', 100000, 100)`,
      [Bun.randomUUIDv7()],
    );
    const genA = await seedGeneration(userId, modelId, providerId);
    const genB = await seedGeneration(userId, modelId, providerId);

    await withTransaction(reserveFor(userId, genA, modelId, providerId, 4_000, 4_000));
    await withTransaction(reserveFor(userId, genB, modelId, providerId, 4_000, 4_000));
    await withTransaction((tx) =>
      quota.settleOrRelease(
        {
          generationId: genA,
          outcome: 'settled',
          actualTokens: 6_000,
          usage: { inputTokens: 3_000, outputTokens: 3_000, source: 'provider' },
        },
        tx,
      ),
    );
    await withTransaction((tx) =>
      quota.settleOrRelease({ generationId: genB, outcome: 'released', actualTokens: 0 }, tx),
    );

    const account = await accounts.findCurrentAccount(userId, new Date());
    expect(account).not.toBeNull();
    const totals = await accounts.reconciliationTotals(account!.id);
    // used = reserve(8k) + settle(6k − 8k) + release(−8k) = 6k
    expect(totals.ledgerUsedTokens).toBe(6_000);
    expect(totals.ledgerUsedTokens).toBe(account!.usedTokens);
    expect(totals.ledgerAdjustmentTokens).toBe(account!.adjustmentTokens);
    expect(totals.liveReservedTokens).toBe(account!.reservedTokens);
  });

  it('rolls back the whole send when the reservation is rejected (atomicity)', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();
    await getPool().query(
      `INSERT INTO quota_policies (id, scope, monthly_tokens, max_concurrent_generations)
       VALUES ($1, 'global', 1000, 100)`,
      [Bun.randomUUIDv7()],
    );
    const generationId = await seedGeneration(userId, modelId, providerId);
    try {
      await withTransaction(async (tx) => {
        await reserveFor(userId, generationId, modelId, providerId, 900, 500)(tx);
        // Simulate the rest of the send transaction writing rows after the reserve.
        await tx.client.query(`INSERT INTO messages (id, conversation_id, seq, role, status)
          VALUES ($1, (SELECT conversation_id FROM generation_jobs WHERE id = $2), 5, 'user', 'complete')`,
          [Bun.randomUUIDv7(), generationId]);
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('quota_exceeded');
    }
    // The message write rolled back with the reservation.
    const messages = await getPool().query(`SELECT count(*) AS count FROM messages WHERE seq = 5`);
    expect(Number.parseInt(messages.rows[0].count, 10)).toBe(0);
    const reservations = await getPool().query(`SELECT count(*) AS count FROM quota_reservations`);
    expect(Number.parseInt(reservations.rows[0].count, 10)).toBe(0);
  });

  it('concurrency cap: requests beyond maxConcurrentGenerations get 429 concurrency_limit (Task 3.6.2)', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();
    // Plenty of monthly quota — only the live-generation cap is under test.
    await getPool().query(
      `INSERT INTO quota_policies (id, scope, monthly_tokens, max_concurrent_generations)
       VALUES ($1, 'global', 1000000, 2)`,
      [Bun.randomUUIDv7()],
    );
    const genA = await seedGeneration(userId, modelId, providerId);
    const genB = await seedGeneration(userId, modelId, providerId);

    // Two live generations fill the cap; the third must be rejected regardless of tokens.
    await withTransaction(reserveFor(userId, genA, modelId, providerId, 100, 100));
    await withTransaction(reserveFor(userId, genB, modelId, providerId, 100, 100));
    const genC = await seedGeneration(userId, modelId, providerId);
    try {
      await withTransaction(reserveFor(userId, genC, modelId, providerId, 100, 100));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('concurrency_limit');
      expect(((err as AppError).details as { maxConcurrentGenerations: number }))
        .toMatchObject({ maxConcurrentGenerations: 2 });
    }

    // Completing one live generation frees a slot.
    await getPool().query(
      `UPDATE generation_jobs SET status = 'completed', finished_at = now() WHERE id = $1`,
      [genA],
    );
    await withTransaction((tx) =>
      quota.settleOrRelease(
        {
          generationId: genA,
          outcome: 'settled',
          actualTokens: 200,
          usage: { inputTokens: 100, outputTokens: 100, source: 'provider' },
        },
        tx,
      ),
    );
    await withTransaction(reserveFor(userId, genC, modelId, providerId, 100, 100));
    const account = await accounts.findCurrentAccount(userId, new Date());
    expect(account?.reservedTokens).toBe(400); // genB 200 + genC 200
  });

  it('reconciliation drill: injected counter drift is detected and reported', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();
    await getPool().query(
      `INSERT INTO quota_policies (id, scope, monthly_tokens, max_concurrent_generations)
       VALUES ($1, 'global', 100000, 100)`,
      [Bun.randomUUIDv7()],
    );
    const generationId = await seedGeneration(userId, modelId, providerId);
    await withTransaction(reserveFor(userId, generationId, modelId, providerId, 1_000, 1_000));
    await withTransaction((tx) =>
      quota.settleOrRelease(
        {
          generationId,
          outcome: 'settled',
          actualTokens: 2_000,
          usage: { inputTokens: 1_000, outputTokens: 1_000, source: 'provider' },
        },
        tx,
      ),
    );

    // Clean baseline: reconciliation reports nothing.
    const cleanRun = await reconciliationHandler();
    const cleanForUser = cleanRun.mismatches.filter((m) => m.userId === userId);
    expect(cleanForUser).toHaveLength(0);

    // Inject drift: bump the counter without a ledger entry (simulates an accounting bug).
    const account = await accounts.findCurrentAccount(userId, new Date());
    expect(account).not.toBeNull();
    await getPool().query(
      `UPDATE quota_accounts SET used_tokens = used_tokens + 777 WHERE id = $1`,
      [account!.id],
    );

    const driftedRun = await reconciliationHandler();
    const drift = driftedRun.mismatches.filter((m) => m.userId === userId);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      accountId: account!.id,
      userId,
      kind: 'used',
      expected: account!.usedTokens, // ledger-derived truth
      actual: account!.usedTokens + 777, // corrupted counter
    });
    expect(driftedRun.checked).toBeGreaterThan(0);
  });

  it('reconciliation ignores active in-flight reservations (no false drift)', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();
    await getPool().query(
      `INSERT INTO quota_policies (id, scope, monthly_tokens, max_concurrent_generations)
       VALUES ($1, 'global', 100000, 100)`,
      [Bun.randomUUIDv7()],
    );
    const genActive = await seedGeneration(userId, modelId, providerId);
    // Reserve tokens but leave it active (in-flight generation)
    await withTransaction(reserveFor(userId, genActive, modelId, providerId, 2_000, 2_000));

    const run = await reconciliationHandler();
    const mismatches = run.mismatches.filter((m) => m.userId === userId);
    expect(mismatches).toHaveLength(0);
  });

  it('adjustQuota lazily creates account if user has no period yet', async () => {
    const { userId } = await seedUserAndModel();
    const res = await quotaService.adjustQuota({
      userId,
      tokens: 5_000,
      reason: 'Onboarding bonus',
      actorUserId: userId,
    });
    expect(res.tokensDelta).toBe(5_000);
    expect(res.entryType).toBe('grant');

    const account = await accounts.findCurrentAccount(userId, new Date());
    expect(account).not.toBeNull();
    expect(account?.adjustmentTokens).toBe(5_000);
  });

  it('division policy update with applyToCurrentPeriod only sweeps members of that division', async () => {
    const divA = Bun.randomUUIDv7();
    const divB = Bun.randomUUIDv7();
    await getPool().query(
      `INSERT INTO divisions (id, name) VALUES ($1, $2), ($3, $4)`,
      [divA, `Div A ${divA}`, divB, `Div B ${divB}`],
    );

    const { userId: userA, modelId, providerId } = await seedUserAndModel();
    const { userId: userB } = await seedUserAndModel();
    await getPool().query(`UPDATE users SET division_id = $1 WHERE id = $2`, [divA, userA]);
    await getPool().query(`UPDATE users SET division_id = $1 WHERE id = $2`, [divB, userB]);

    // Create current accounts for both users
    const genA = await seedGeneration(userA, modelId, providerId);
    const genB = await seedGeneration(userB, modelId, providerId);
    await withTransaction(reserveFor(userA, genA, modelId, providerId, 100, 100));
    await withTransaction(reserveFor(userB, genB, modelId, providerId, 100, 100));

    // Update Div A policy with applyToCurrentPeriod
    await quotaService.updatePolicy({
      scope: 'division',
      targetId: divA,
      fields: { monthlyTokens: 800_000 },
      applyToCurrentPeriod: true,
      reason: 'Budget increase for Div A',
      actorUserId: userA,
    });

    const accA = await accounts.findCurrentAccount(userA, new Date());
    const accB = await accounts.findCurrentAccount(userB, new Date());
    expect(accA?.baseLimitTokens).toBe(800_000);
    expect(accB?.baseLimitTokens).not.toBe(800_000);
  });

  it('precreatePeriodsHandler resolves user effective policy instead of hardcoding defaults', async () => {
    const { userId } = await seedUserAndModel();
    // Insert a custom user policy with 2,000,000 tokens
    await getPool().query(
      `INSERT INTO quota_policies (id, scope, user_id, monthly_tokens, max_concurrent_generations)
       VALUES ($1, 'user', $2, 2000000, 5)`,
      [Bun.randomUUIDv7(), userId],
    );

    const handler = createPrecreatePeriodsHandler({
      accounts,
      userIds: async () => [userId],
      clock: systemClock,
      idGen: uuidv7Generator,
      quotaTimezone: 'Asia/Jakarta',
      resolvePolicyForUser: (uid, tx) => quota.resolvePolicyForUser(uid, tx),
    });

    const res = await handler();
    expect(res.created).toBe(1);

    const account = await accounts.findCurrentAccount(userId, new Date());
    expect(account).not.toBeNull();
    expect(account?.baseLimitTokens).toBe(2_000_000);
    expect(account?.limits).toMatchObject({ maxConcurrentGenerations: 5 });
  });

  it('reconciliation ignores base-limit rebase ledger entries and reports no mismatch', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();
    const globalPolicyId = Bun.randomUUIDv7();
    await getPool().query(
      `INSERT INTO quota_policies (id, scope, monthly_tokens, max_concurrent_generations)
       VALUES ($1, 'global', 100000, 100)`,
      [globalPolicyId],
    );

    const genA = await seedGeneration(userId, modelId, providerId);
    await withTransaction(reserveFor(userId, genA, modelId, providerId, 4_000, 4_000));
    await withTransaction((tx) =>
      quota.settleOrRelease(
        {
          generationId: genA,
          outcome: 'settled',
          actualTokens: 6_000,
          usage: { inputTokens: 3_000, outputTokens: 3_000, source: 'provider' },
        },
        tx,
      ),
    );

    // Admin updates the policy with applyToCurrentPeriod: true (rebases base_limit_tokens from 100k to 150k)
    await quotaService.updatePolicy({
      scope: 'global',
      targetId: null,
      fields: { monthlyTokens: 150_000 },
      applyToCurrentPeriod: true,
      reason: 'Mid-month bump',
      actorUserId: null,
    });

    const result = await reconciliationHandler();
    const userMismatches = result.mismatches.filter((m) => m.userId === userId);
    expect(userMismatches).toHaveLength(0);
  });

  it('enforces policy max_input_tokens_per_request even when model context window is larger', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();
    await getPool().query(
      `INSERT INTO quota_policies (id, scope, monthly_tokens, max_input_tokens_per_request, max_concurrent_generations)
       VALUES ($1, 'global', 100000, 500, 100)`,
      [Bun.randomUUIDv7()],
    );
    const gen = await seedGeneration(userId, modelId, providerId);
    // Model context window is 128,000, but policy cap is 500. A 600-token prompt must fail.
    await expect(
      withTransaction(reserveFor(userId, gen, modelId, providerId, 600, 500)),
    ).rejects.toThrowError(AppError);
  });

  it('resolves division policy when resolving policy for a user with division', async () => {
    const pool = getPool();
    const divId = Bun.randomUUIDv7();
    await pool.query(`INSERT INTO divisions (id, name) VALUES ($1, 'Div Engineering')`, [divId]);
    const { userId } = await seedUserAndModel();
    await pool.query(`UPDATE users SET division_id = $1 WHERE id = $2`, [divId, userId]);

    await pool.query(
      `INSERT INTO quota_policies (id, scope, division_id, monthly_tokens, max_input_tokens_per_request)
       VALUES ($1, 'division', $2, 500000, 2500)`,
      [Bun.randomUUIDv7(), divId],
    );

    const resolved = await quotaService.resolvePolicyFor(userId);
    expect(resolved.monthlyTokens).toBe(500000);
    expect(resolved.maxInputTokensPerRequest).toBe(2500);
  });

  it('merges policy updates with tri-state semantics and rebases user account directly', async () => {
    const { userId, modelId, providerId } = await seedUserAndModel();

    // 1. Initial policy update for user: set both monthlyTokens and maxInputTokensPerRequest
    await quotaService.updatePolicy({
      scope: 'user',
      targetId: userId,
      fields: {
        monthlyTokens: 500_000,
        maxInputTokensPerRequest: 10_000,
      },
      applyToCurrentPeriod: true,
      reason: 'Initial user policy',
      actorUserId: userId,
    });

    // Create current account via reservation
    const gen = await seedGeneration(userId, modelId, providerId);
    await withTransaction(reserveFor(userId, gen, modelId, providerId, 100, 100));

    let acc = await accounts.findCurrentAccount(userId, new Date());
    expect(acc?.baseLimitTokens).toBe(500_000);

    // 2. Partial update: modify monthlyTokens to 750k; leave maxInputTokensPerRequest as undefined
    await quotaService.updatePolicy({
      scope: 'user',
      targetId: userId,
      fields: {
        monthlyTokens: 750_000,
        // maxInputTokensPerRequest undefined -> should preserve 10,000
      },
      applyToCurrentPeriod: true,
      reason: 'Partial update',
      actorUserId: userId,
    });

    const userPolicyAfterPartial = await policies.findPolicy('user', userId);
    expect(userPolicyAfterPartial?.monthlyTokens).toBe(750_000);
    expect(userPolicyAfterPartial?.maxInputTokensPerRequest).toBe(10_000);

    acc = await accounts.findCurrentAccount(userId, new Date());
    expect(acc?.baseLimitTokens).toBe(750_000);

    // 3. Unset maxInputTokensPerRequest with null
    await quotaService.updatePolicy({
      scope: 'user',
      targetId: userId,
      fields: {
        maxInputTokensPerRequest: null,
      },
      applyToCurrentPeriod: false,
      reason: 'Unset input cap',
      actorUserId: userId,
    });

    const userPolicyAfterNull = await policies.findPolicy('user', userId);
    expect(userPolicyAfterNull?.monthlyTokens).toBe(750_000);
    expect(userPolicyAfterNull?.maxInputTokensPerRequest).toBeNull();
  });
});

afterAll(async () => {
  await closePool();
});
