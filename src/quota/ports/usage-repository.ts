/** Persistence port for usage events and daily reporting aggregates. */
import type { TransactionContext } from '@/db/tx.ts';

export interface UsageEventInput {
  readonly generationId: string;
  readonly userId: string;
  readonly divisionId: string | null;
  readonly providerId: string;
  readonly modelId: string;
  readonly accountId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly quotaTokens: number;
  readonly overshootTokens: number;
  readonly usageSource: 'provider' | 'estimated';
  readonly estCostMicros: number | null;
  readonly costCurrency: string;
  readonly outcome: 'completed' | 'cancelled' | 'failed';
  readonly errorCategory: string | null;
  readonly durationMs: number | null;
  readonly timeToFirstTokenMs: number | null;
}

export interface UsageQuery {
  readonly userId: string;
  readonly from: Date;
  readonly to: Date;
  readonly groupBy: 'day' | 'model';
}

export interface UsageAggregateRow {
  readonly day: string | null;
  readonly modelId: string | null;
  readonly requests: number;
  readonly failedRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly quotaTokens: number;
  readonly estCostMicros: number | null;
}

export interface UsageRepository {
  /** Records a settled generation usage event. */
  insertUsageEvent(input: UsageEventInput, tx: TransactionContext): Promise<void>;

  /** Effective-dated price rows for a model (caller picks with `effectivePriceAt`). */
  listPrices(
    modelId: string,
    tx?: TransactionContext,
  ): Promise<
    readonly {
      readonly effectiveFrom: Date;
      readonly inputMicrosPerMtok: number;
      readonly outputMicrosPerMtok: number;
      readonly cachedInputMicrosPerMtok: number | null;
      readonly currency: string;
    }[]
  >;

  /** User usage aggregates (`GET /me/usage`) from `usage_events`. */
  aggregateForUser(query: UsageQuery, tx?: TransactionContext): Promise<readonly UsageAggregateRow[]>;

  /** Upserts aggregated daily usage rows for a given date. */
  rollupDay(day: string, tx?: TransactionContext): Promise<number>;

  /** Division of a user (for usage_events.division_id at settlement time). */
  userDivisionId(userId: string, tx?: TransactionContext): Promise<string | null>;
}
