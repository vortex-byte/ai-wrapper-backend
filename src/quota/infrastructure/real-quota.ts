import type { Clock, IdGenerator } from '@/clock/index.ts';
import { AppError } from '@/errors.ts';
import { runDb } from '@/db/client.ts';
import { getLogger } from '@/observability/logger.ts';
import { and, eq } from 'drizzle-orm';
import { generationJobs } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import { computeReservation, overshootTokens, toQuotaTokens } from '../domain/clamping.ts';
import { costMicros, effectivePriceAt } from '../domain/pricing.ts';
import { resolvePolicy, type ResolvedPolicy } from '../domain/policy.ts';
import { periodEndFor, periodStartFor, resetAtFor } from '../domain/timezone.ts';
import type { QuotaAccountRepository } from '../ports/quota-account-repository.ts';
import type { QuotaPolicyRepository } from '../ports/quota-policy-repository.ts';
import type { UsageRepository } from '../ports/usage-repository.ts';
import type {
  QuotaPort,
  ReserveContext,
  ReservationHandle,
  Settlement,
} from '@/generations/ports/quota-port.ts';

/**
 * Quota accounting service implementation.
 */

const RESERVATION_TTL_MS = 15 * 60 * 1000;

export interface RealQuotaDeps {
  readonly accounts: QuotaAccountRepository;
  readonly policies: QuotaPolicyRepository;
  readonly usage: UsageRepository;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
  readonly quotaTimezone: string;
}

export class RealQuota implements QuotaPort {
  private readonly accounts: QuotaAccountRepository;
  private readonly policies: QuotaPolicyRepository;
  private readonly usage: UsageRepository;
  private readonly clock: Clock;
  private readonly idGen: IdGenerator;
  private readonly quotaTimezone: string;

  constructor(deps: RealQuotaDeps) {
    this.accounts = deps.accounts;
    this.policies = deps.policies;
    this.usage = deps.usage;
    this.clock = deps.clock;
    this.idGen = deps.idGen;
    this.quotaTimezone = deps.quotaTimezone;
  }

  /** Resolve the effective policy for a user (user → division → global, per field). */
  async resolvePolicyForUser(
    userId: string,
    tx?: TransactionContext,
  ): Promise<ResolvedPolicy> {
    const userPolicyRow = await this.policies.findPolicy('user', userId, tx);
    const divisionId = await this.userDivisionId(userId, tx);
    const divisionPolicy = divisionId !== null
      ? await this.policies.findPolicy('division', divisionId, tx)
      : null;
    const globalPolicy = await this.policies.findPolicy('global', null, tx);
    return resolvePolicy(userPolicyRow, divisionPolicy, globalPolicy);
  }

  private async userDivisionId(
    userId: string,
    tx?: TransactionContext,
  ): Promise<string | null> {
    // Read-only lookup for policy resolution; inside the caller's transaction when given so
    // concurrent reservations do not check out a second pool connection.
    return this.usage.userDivisionId(userId, tx);
  }

  async reserve(ctx: ReserveContext, tx: TransactionContext): Promise<ReservationHandle> {
    const now = this.clock.now();

    const policy = await this.resolvePolicyForUser(ctx.userId, tx);

    if (
      ctx.maxInputTokensForRequest !== undefined &&
      ctx.estimatedInputTokens > ctx.maxInputTokensForRequest
    ) {
      throw new AppError('context_too_large', 'The prompt exceeds the per-request input token limit.');
    }

    const account = await this.accounts.getOrCreateAccount(
      {
        id: this.idGen.uuidv7(),
        userId: ctx.userId,
        periodStart: periodStartFor(now, this.quotaTimezone),
        periodEnd: periodEndFor(now, this.quotaTimezone),
        baseLimitTokens: policy.monthlyTokens,
        limits: {
          maxInputTokensPerRequest: policy.maxInputTokensPerRequest,
          maxOutputTokensPerRequest: policy.maxOutputTokensPerRequest,
          maxConcurrentGenerations: policy.maxConcurrentGenerations,
        },
      },
      tx,
    );

    // Count other live generations for this user; exclude the current generation row.
    const activeCount = await tx.client.query<{ count: string }>(
      `SELECT count(*) AS count FROM generation_jobs
        WHERE user_id = $1 AND id <> $2 AND status IN ('pending','generating')`,
      [ctx.userId, ctx.generationId],
    );
    if (Number.parseInt(activeCount.rows[0]?.count ?? '0', 10) >= policy.maxConcurrentGenerations) {
      throw new AppError('concurrency_limit', 'Too many generations are already running.', {
        details: { maxConcurrentGenerations: policy.maxConcurrentGenerations },
      });
    }

    const limitTokens = account.baseLimitTokens + account.adjustmentTokens;
    const decision = computeReservation({
      estimatedInputTokens: ctx.estimatedInputTokens,
      hasMediaParts: ctx.hasMediaParts,
      requestedMaxOutputTokens: ctx.requestedMaxOutputTokens,
      modelMaxOutputTokens: ctx.modelMaxOutputTokens,
      quotaWeight: ctx.quotaWeight,
      limitTokens,
      usedTokens: account.usedTokens,
      reservedTokens: account.reservedTokens,
      maxOutputTokensPerRequest: policy.maxOutputTokensPerRequest,
      marginOverride: ctx.marginOverride,
    });

    if (decision.kind === 'exceeds_input_cap') {
      throw new AppError('context_too_large');
    }
    if (decision.kind === 'quota_exhausted') {
      throw new AppError('quota_exceeded', 'Your monthly token quota is exhausted.', {
        details: {
          remainingTokens: decision.remainingTokens,
          resetAt: resetAtFor(now, this.quotaTimezone),
        },
      });
    }

    // Atomic conditional UPDATE. 0 rows indicates over limit.
    const result = await this.accounts.reserveAtomic(account.id, decision.reservedTokens, tx);
    if (!result.reserved) {
      throw new AppError('quota_exceeded', 'Your monthly token quota is exhausted.', {
        details: {
          remainingTokens: Math.max(
            0,
            limitTokens - account.usedTokens - account.reservedTokens,
          ),
          resetAt: resetAtFor(now, this.quotaTimezone),
        },
      });
    }

    // Reservation row and ledger entry in the same transaction.
    await this.accounts.insertReservation(
      {
        id: this.idGen.uuidv7(),
        generationId: ctx.generationId,
        userId: ctx.userId,
        accountId: account.id,
        reservedTokens: decision.reservedTokens,
        expiresAt: new Date(now.getTime() + RESERVATION_TTL_MS),
      },
      tx,
    );
    await this.accounts.appendLedger(
      {
        userId: ctx.userId,
        accountId: account.id,
        generationId: ctx.generationId,
        entryType: 'reserve',
        tokensDelta: decision.reservedTokens,
        usedAfter: result.usedTokens,
        reservedAfter: result.reservedTokens,
      },
      tx,
    );

    return {
      generationId: ctx.generationId,
      reservedTokens: decision.reservedTokens,
      accountId: account.id,
      effectiveMaxOutputTokens: decision.effectiveMaxOutputTokens,
      remainingTokens: Math.max(0, decision.remainingAfterReserve),
    };
  }

  async settleOrRelease(settlement: Settlement, tx: TransactionContext): Promise<void> {
    // Lock the reservation; non-active status indicates another path already finalized it.
    const reservation = await this.accounts.lockReservationForGeneration(
      settlement.generationId,
      tx,
    );
    if (reservation === null) {
      getLogger().warn(
        { generationId: settlement.generationId },
        'settlement for a generation with no reservation — skipping',
      );
      return;
    }
    if (reservation.status !== 'active') {
      return;
    }

    const isRelease = settlement.outcome === 'released';
    const actualRaw = isRelease ? 0 : settlement.actualTokens;
    const quotaWeight = await this.quotaWeightForGeneration(settlement.generationId, tx);
    const actualQuotaTokens = toQuotaTokens(actualRaw, quotaWeight);

    const account = await this.accounts.applySettlement(
      reservation.accountId,
      reservation.reservedTokens,
      actualQuotaTokens,
      tx,
    );
    if (account === null) {
      throw new Error(
        `quota account ${reservation.accountId} vanished during settlement of ${settlement.generationId}`,
      );
    }

    const usedAfter = account.usedTokens;
    const reservedAfter = account.reservedTokens;

    // Record usage event on settle path.
    const generation = await this.findGeneration(settlement.generationId, tx);
    if (!isRelease && generation !== null) {
      const usage = settlement.usage ?? {
        inputTokens: actualRaw,
        outputTokens: 0,
        source: 'estimated' as const,
      };
      const overshoot = overshootTokens(actualQuotaTokens, reservation.reservedTokens);
      const priceRows = await this.usage.listPrices(generation.modelId, tx);
      const price =
        effectivePriceAt(
          priceRows.map((row) => ({ ...row, effectiveFrom: row.effectiveFrom })),
          generation.createdAt,
        ) ?? null;
      const estCost =
        price !== null
          ? costMicros(
              price,
              usage.inputTokens,
              usage.outputTokens,
              usage.cachedInputTokens ?? null,
            )
          : null;
      const divisionId = await this.usage.userDivisionId(generation.userId, tx);

      await this.usage.insertUsageEvent(
        {
          generationId: settlement.generationId,
          userId: generation.userId,
          divisionId,
          providerId: generation.providerId,
          modelId: generation.modelId,
          accountId: reservation.accountId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens ?? null,
          reasoningTokens: usage.reasoningTokens ?? null,
          quotaTokens: actualQuotaTokens,
          overshootTokens: overshoot,
          usageSource: usage.source,
          estCostMicros: estCost,
          costCurrency: price?.currency ?? 'USD',
          outcome: settlement.outcomeCategory ?? 'completed',
          errorCategory: settlement.errorCategory ?? null,
          durationMs: settlement.durationMs ?? null,
          timeToFirstTokenMs: settlement.timeToFirstTokenMs ?? null,
        },
        tx,
      );
    }

    // Finalize reservation and record ledger entry.
    await this.accounts.finalizeReservation(
      settlement.generationId,
      isRelease ? 'released' : 'settled',
      isRelease ? null : actualQuotaTokens,
      this.clock.now(),
      tx,
    );
    await this.accounts.appendLedger(
      {
        userId: reservation.userId,
        accountId: reservation.accountId,
        generationId: settlement.generationId,
        entryType: isRelease ? 'release' : 'settle',
        tokensDelta: isRelease ? -reservation.reservedTokens : actualQuotaTokens - reservation.reservedTokens,
        usedAfter,
        reservedAfter,
      },
      tx,
    );
  }

  async remainingTokens(userId: string): Promise<number | null> {
    const now = this.clock.now();
    const account = await this.accounts.findCurrentAccount(userId, now);
    if (account === null) return null;
    const limit = account.baseLimitTokens + account.adjustmentTokens;
    return Math.max(0, limit - account.usedTokens - account.reservedTokens);
  }

  private async quotaWeightForGeneration(
    generationId: string,
    tx: TransactionContext,
  ): Promise<number> {
    const result = await tx.client.query<{ quota_weight: string }>(
      `SELECT m.quota_weight
         FROM generation_jobs g
         JOIN ai_models m ON m.id = g.model_id
        WHERE g.id = $1`,
      [generationId],
    );
    const raw = result.rows[0]?.quota_weight;
    const weight = raw === undefined ? NaN : Number.parseFloat(raw);
    return Number.isFinite(weight) && weight > 0 ? weight : 1.0;
  }

  private async findGeneration(
    generationId: string,
    tx: TransactionContext,
  ): Promise<
    | {
        readonly userId: string;
        readonly providerId: string;
        readonly modelId: string;
        readonly createdAt: Date;
      }
    | null
  > {
    const rows = await runDb(tx)
      .select({
        userId: generationJobs.userId,
        providerId: generationJobs.providerId,
        modelId: generationJobs.modelId,
        createdAt: generationJobs.createdAt,
      })
      .from(generationJobs)
      .where(and(eq(generationJobs.id, generationId)))
      .limit(1);
    return rows[0] ?? null;
  }
}
