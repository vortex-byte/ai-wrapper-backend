import { withTransaction, type TransactionContext } from '@/db/tx.ts';
import { AppError } from '@/errors.ts';
import { periodEndFor, periodStartFor } from '../domain/timezone.ts';
import { resolvePolicy, type QuotaPolicyRow, type ResolvedPolicy } from '../domain/policy.ts';
import type { QuotaAccountRepository } from '../ports/quota-account-repository.ts';
import type {
  PolicyScope,
  QuotaPolicyRepository,
  UpsertPolicyInput,
} from '../ports/quota-policy-repository.ts';

export interface QuotaSnapshot {
  readonly period: { readonly start: string; readonly end: string };
  readonly limitTokens: number;
  readonly usedTokens: number;
  readonly reservedTokens: number;
  readonly remainingTokens: number;
  readonly limits: {
    readonly maxInputTokensPerRequest: number;
    readonly maxOutputTokensPerRequest: number;
    readonly maxConcurrentGenerations: number;
  };
}

export interface AdjustmentResult {
  readonly entryType: 'adjust' | 'grant';
  readonly tokensDelta: number;
}

export interface QuotaServiceDeps {
  readonly accounts: QuotaAccountRepository;
  readonly policies: QuotaPolicyRepository;
  readonly idGen: () => string;
  readonly quotaTimezone: string;
}

export interface PolicyUpdateInput {
  readonly scope: PolicyScope;
  readonly targetId: string | null;
  readonly fields: {
    readonly monthlyTokens?: number | null | undefined;
    readonly maxInputTokensPerRequest?: number | null | undefined;
    readonly maxOutputTokensPerRequest?: number | null | undefined;
    readonly maxConcurrentGenerations?: number | null | undefined;
    readonly allowedModelIds?: readonly string[] | null | undefined;
  };
  readonly applyToCurrentPeriod: boolean;
  readonly reason: string | undefined;
  readonly actorUserId: string | null;
}

export class QuotaService {
  private readonly accounts: QuotaAccountRepository;
  private readonly policies: QuotaPolicyRepository;
  private readonly idGen: () => string;
  private readonly quotaTimezone: string;

  constructor(deps: QuotaServiceDeps) {
    this.accounts = deps.accounts;
    this.policies = deps.policies;
    this.idGen = deps.idGen;
    this.quotaTimezone = deps.quotaTimezone;
  }

  async getQuotaSnapshot(userId: string): Promise<QuotaSnapshot | null> {
    const now = new Date();
    const account = await this.accounts.findCurrentAccount(userId, now);
    const policy = await this.resolvePolicyFor(userId);
    if (account === null) {
      return {
        period: {
          start: periodStartFor(now, this.quotaTimezone).toISOString(),
          end: periodEndFor(now, this.quotaTimezone).toISOString(),
        },
        limitTokens: policy.monthlyTokens,
        usedTokens: 0,
        reservedTokens: 0,
        remainingTokens: policy.monthlyTokens,
        limits: {
          maxInputTokensPerRequest: policy.maxInputTokensPerRequest,
          maxOutputTokensPerRequest: policy.maxOutputTokensPerRequest,
          maxConcurrentGenerations: policy.maxConcurrentGenerations,
        },
      };
    }
    const limit = account.baseLimitTokens + account.adjustmentTokens;
    return {
      period: {
        start: account.periodStart.toISOString(),
        end: account.periodEnd.toISOString(),
      },
      limitTokens: limit,
      usedTokens: account.usedTokens,
      reservedTokens: account.reservedTokens,
      remainingTokens: Math.max(0, limit - account.usedTokens - account.reservedTokens),
      limits: {
        maxInputTokensPerRequest: policy.maxInputTokensPerRequest,
        maxOutputTokensPerRequest: policy.maxOutputTokensPerRequest,
        maxConcurrentGenerations: policy.maxConcurrentGenerations,
      },
    };
  }

  async resolvePolicyFor(userId: string): Promise<ResolvedPolicy> {
    const userPolicy = await this.policies.findPolicy('user', userId);
    const globalPolicy = await this.policies.findPolicy('global', null);
    return resolvePolicy(userPolicy, null, globalPolicy);
  }

  async listLedger(
    userId: string,
    limit: number,
  ): Promise<
    readonly {
      readonly entryType: string;
      readonly tokensDelta: number;
      readonly reason: string | null;
      readonly createdAt: Date;
      readonly requestId: string | null;
    }[]
  > {
    return this.accounts.listLedger(userId, limit);
  }

  async getPolicy(scope: PolicyScope, targetId: string | null): Promise<QuotaPolicyRow | null> {
    return this.policies.findPolicy(scope, targetId);
  }

  async updatePolicy(input: PolicyUpdateInput): Promise<QuotaPolicyRow> {
    const existing = await this.policies.findPolicy(input.scope, input.targetId);
    const upsert: UpsertPolicyInput = {
      id: this.idGen(),
      scope: input.scope,
      divisionId: input.scope === 'division' ? input.targetId : null,
      userId: input.scope === 'user' ? input.targetId : null,
      monthlyTokens: input.fields.monthlyTokens ?? existing?.monthlyTokens ?? null,
      maxInputTokensPerRequest:
        input.fields.maxInputTokensPerRequest ?? existing?.maxInputTokensPerRequest ?? null,
      maxOutputTokensPerRequest:
        input.fields.maxOutputTokensPerRequest ?? existing?.maxOutputTokensPerRequest ?? null,
      maxConcurrentGenerations:
        input.fields.maxConcurrentGenerations ?? existing?.maxConcurrentGenerations ?? null,
      allowedModelIds:
        input.fields.allowedModelIds !== undefined
          ? input.fields.allowedModelIds
          : existing?.allowedModelIds ?? null,
      updatedBy: input.actorUserId,
    };

    return withTransaction(async (tx: TransactionContext) => {
      const saved = await this.policies.upsertPolicy(upsert, tx);

      if (input.applyToCurrentPeriod && upsert.monthlyTokens !== null) {
        const now = new Date();
        const accounts = await this.accounts.listCurrentAccounts(now, 10_000, tx);
        for (const account of accounts) {
          const inherits = await this.accountInherits(account.userId, input.scope, input.targetId, tx);
          if (!inherits) continue;
          const oldLimit = account.baseLimitTokens;
          const newLimit = upsert.monthlyTokens;
          if (oldLimit === newLimit) continue;
          await this.accounts.adjustLimit(account.id, newLimit - oldLimit, 'base', tx);
          const updated = await this.accounts.findCurrentAccount(account.userId, now, tx);
          await this.accounts.appendLedger(
            {
              userId: account.userId,
              accountId: account.id,
              generationId: null,
              entryType: 'adjust',
              tokensDelta: newLimit - oldLimit,
              usedAfter: updated?.usedTokens ?? account.usedTokens,
              reservedAfter: updated?.reservedTokens ?? account.reservedTokens,
              actorUserId: input.actorUserId ?? undefined,
              reason: input.reason ?? 'Policy update applied to current period',
            },
            tx,
          );
        }
      }
      return saved;
    });
  }

  private async accountInherits(
    userId: string,
    scope: PolicyScope,
    targetId: string | null,
    tx: TransactionContext,
  ): Promise<boolean> {
    if (scope === 'user') return userId === targetId;

    const userPolicy = await tx.client.query<{ monthly_tokens: string | number | null }>(
      `SELECT monthly_tokens FROM quota_policies WHERE scope = 'user' AND user_id = $1`,
      [userId],
    );
    if (userPolicy.rows[0]?.monthly_tokens !== null && userPolicy.rows[0]?.monthly_tokens !== undefined) {
      return false;
    }

    if (scope === 'division') {
      const userRow = await tx.client.query<{ division_id: string | null }>(
        `SELECT division_id FROM users WHERE id = $1`,
        [userId],
      );
      return userRow.rows[0]?.division_id === targetId;
    }

    const userRow = await tx.client.query<{ division_id: string | null }>(
      `SELECT division_id FROM users WHERE id = $1`,
      [userId],
    );
    const divisionId = userRow.rows[0]?.division_id;
    if (divisionId) {
      const divisionPolicy = await tx.client.query<{ monthly_tokens: string | number | null }>(
        `SELECT monthly_tokens FROM quota_policies WHERE scope = 'division' AND division_id = $1`,
        [divisionId],
      );
      if (divisionPolicy.rows[0]?.monthly_tokens !== null && divisionPolicy.rows[0]?.monthly_tokens !== undefined) {
        return false;
      }
    }

    return true;
  }

  async adjustQuota(input: {
    readonly userId: string;
    readonly tokens: number;
    readonly reason: string;
    readonly actorUserId: string;
    readonly requestId?: string | undefined;
  }): Promise<AdjustmentResult> {
    if (input.tokens === 0) {
      throw new AppError('invalid_request', 'Adjustment must be non-zero.');
    }
    const now = new Date();
    return withTransaction(async (tx: TransactionContext) => {
      let account = await this.accounts.findCurrentAccount(input.userId, now, tx);
      if (account === null) {
        const policy = await this.resolvePolicyFor(input.userId);
        const periodStart = periodStartFor(now, this.quotaTimezone);
        const periodEnd = periodEndFor(now, this.quotaTimezone);
        account = await this.accounts.getOrCreateAccount(
          {
            id: this.idGen(),
            userId: input.userId,
            periodStart,
            periodEnd,
            baseLimitTokens: policy.monthlyTokens,
            limits: {
              maxInputTokensPerRequest: policy.maxInputTokensPerRequest,
              maxOutputTokensPerRequest: policy.maxOutputTokensPerRequest,
              maxConcurrentGenerations: policy.maxConcurrentGenerations,
            },
          },
          tx,
        );
      }
      const updated = await this.accounts.adjustLimit(account.id, input.tokens, 'adjustment', tx);
      if (updated === null) {
        throw new AppError('not_found', 'Quota account not found.');
      }
      const entryType: 'adjust' | 'grant' = input.tokens > 0 ? 'grant' : 'adjust';
      await this.accounts.appendLedger(
        {
          userId: input.userId,
          accountId: account.id,
          generationId: null,
          entryType,
          tokensDelta: input.tokens,
          usedAfter: updated.usedTokens,
          reservedAfter: updated.reservedTokens,
          actorUserId: input.actorUserId,
          reason: input.reason,
          requestId: input.requestId,
        },
        tx,
      );
      return { entryType, tokensDelta: input.tokens };
    });
  }
}
