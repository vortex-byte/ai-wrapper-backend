/**
 * Usage-event persistence and reporting reads.
 *
 * `usage_events` is the source of truth (one row per settled generation); `usage_daily` is a
 * rollup maintained incrementally and rebuilt nightly.
 */
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

export interface AdminUsageQuery {
  readonly from: Date;
  readonly to: Date;
  readonly groupBy: 'user' | 'model' | 'provider' | 'day' | 'month' | 'division';
}

export interface AdminUsageRow {
  readonly key: Record<string, string | null>;
  readonly requests: number;
  readonly failedRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly quotaTokens: number;
  readonly estCostMicros: number | null;
}

export interface UsageRepository {
  /**
   * Write the usage event on the settlement path. `generation_id` is UNIQUE so a replayed
   * settlement cannot double-count; a conflicting replay is a silent no-op.
   */
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

  /** Admin usage aggregates (`GET /admin/usage`) from `usage_events`. */
  aggregateAdmin(
    query: AdminUsageQuery,
    tx?: TransactionContext,
  ): Promise<readonly AdminUsageRow[]>;

  /**
   * Incremental 5-min rollup: recompute today's (or the given day's) rows from `usage_events`
   * and upsert into `usage_daily`. Idempotent — re-running never double-counts.
   */
  rollupDay(day: string, tx?: TransactionContext): Promise<number>;

  /** Division of a user (for usage_events.division_id at settlement time). */
  userDivisionId(userId: string, tx?: TransactionContext): Promise<string | null>;
}
