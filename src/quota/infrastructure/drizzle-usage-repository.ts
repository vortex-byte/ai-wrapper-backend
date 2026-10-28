import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { aiModelPrices, usageEvents, users } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import type {
  UsageAggregateRow,
  UsageEventInput,
  UsageQuery,
  UsageRepository,
} from '../ports/usage-repository.ts';

/**
 * Drizzle implementation for usage events and read aggregations.
 */
export class DrizzleUsageRepository implements UsageRepository {
  async insertUsageEvent(input: UsageEventInput, tx: TransactionContext): Promise<void> {
    await runDb(tx)
      .insert(usageEvents)
      .values({
        id: crypto.randomUUID(),
        generationId: input.generationId,
        userId: input.userId,
        divisionId: input.divisionId,
        providerId: input.providerId,
        modelId: input.modelId,
        accountId: input.accountId,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedInputTokens: input.cachedInputTokens,
        reasoningTokens: input.reasoningTokens,
        quotaTokens: input.quotaTokens,
        overshootTokens: input.overshootTokens,
        usageSource: input.usageSource,
        estCostMicros: input.estCostMicros,
        costCurrency: input.costCurrency,
        outcome: input.outcome,
        errorCategory: input.errorCategory,
        durationMs: input.durationMs,
        timeToFirstTokenMs: input.timeToFirstTokenMs,
      })
      .onConflictDoNothing({ target: usageEvents.generationId });
  }

  async listPrices(
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
  > {
    const rows = await runDb(tx)
      .select({
        effectiveFrom: aiModelPrices.effectiveFrom,
        inputMicrosPerMtok: aiModelPrices.inputMicrosPerMtok,
        outputMicrosPerMtok: aiModelPrices.outputMicrosPerMtok,
        cachedInputMicrosPerMtok: aiModelPrices.cachedInputMicrosPerMtok,
        currency: aiModelPrices.currency,
      })
      .from(aiModelPrices)
      .where(eq(aiModelPrices.modelId, modelId))
      .orderBy(aiModelPrices.effectiveFrom);
    return rows;
  }

  async userDivisionId(userId: string, tx?: TransactionContext): Promise<string | null> {
    const rows = await runDb(tx)
      .select({ divisionId: users.divisionId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.divisionId ?? null;
  }

  async aggregateForUser(
    query: UsageQuery,
    tx?: TransactionContext,
  ): Promise<readonly UsageAggregateRow[]> {
    const dayExpr = sql<string>`to_char(${usageEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
    const groupExpr = query.groupBy === 'day' ? dayExpr : usageEvents.modelId;
    const rows = await runDb(tx)
      .select({
        key: groupExpr,
        requests: sql<number>`count(*)::int`,
        failedRequests: sql<number>`count(*) FILTER (WHERE ${usageEvents.outcome} = 'failed')::int`,
        inputTokens: sql<number>`COALESCE(sum(${usageEvents.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`COALESCE(sum(${usageEvents.outputTokens}), 0)::bigint`,
        quotaTokens: sql<number>`COALESCE(sum(${usageEvents.quotaTokens}), 0)::bigint`,
        estCostMicros: sql<number | null>`COALESCE(sum(${usageEvents.estCostMicros}), 0)::bigint`,
      })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.userId, query.userId),
          gte(usageEvents.createdAt, query.from),
          lt(usageEvents.createdAt, query.to),
        ),
      )
      .groupBy(groupExpr)
      .orderBy(groupExpr);

    return rows.map((row) => ({
      day: query.groupBy === 'day' ? String(row.key) : null,
      modelId: query.groupBy === 'model' ? String(row.key) : null,
      requests: Number(row.requests),
      failedRequests: Number(row.failedRequests),
      inputTokens: Number(row.inputTokens),
      outputTokens: Number(row.outputTokens),
      quotaTokens: Number(row.quotaTokens),
      estCostMicros: row.estCostMicros === null ? null : Number(row.estCostMicros),
    }));
  }

  async rollupDay(day: string, tx?: TransactionContext): Promise<number> {
    const result = await runDb(tx).execute<{ rolled: number }>(sql`
      WITH daily AS (
        SELECT
          (${usageEvents.createdAt} AT TIME ZONE 'UTC')::date AS day,
          ${usageEvents.userId} AS user_id,
          min(${usageEvents.divisionId}::text)::uuid AS division_id,
          ${usageEvents.providerId} AS provider_id,
          ${usageEvents.modelId} AS model_id,
          count(*)::int AS requests,
          count(*) FILTER (WHERE ${usageEvents.outcome} = 'failed')::int AS failed_requests,
          count(*) FILTER (WHERE ${usageEvents.usageSource} = 'provider')::int
            AS provider_sourced_requests,
          COALESCE(sum(${usageEvents.inputTokens}), 0) AS input_tokens,
          COALESCE(sum(${usageEvents.outputTokens}), 0) AS output_tokens,
          COALESCE(sum(${usageEvents.quotaTokens}), 0) AS quota_tokens,
          sum(${usageEvents.estCostMicros})::bigint AS est_cost_micros
        FROM ${usageEvents}
        WHERE ${usageEvents.createdAt} >= (${day}::date AT TIME ZONE 'UTC')
          AND ${usageEvents.createdAt} < ((${day}::date + interval '1 day') AT TIME ZONE 'UTC')
        GROUP BY 1, 2, 4, 5
      )
      INSERT INTO usage_daily
        (day, user_id, division_id, provider_id, model_id, requests, failed_requests,
         provider_sourced_requests, input_tokens, output_tokens, quota_tokens, est_cost_micros)
      SELECT day, user_id, division_id, provider_id, model_id, requests, failed_requests,
             provider_sourced_requests, input_tokens, output_tokens, quota_tokens, est_cost_micros
      FROM daily
      ON CONFLICT (day, user_id, model_id) DO UPDATE SET
        division_id    = EXCLUDED.division_id,
        provider_id    = EXCLUDED.provider_id,
        requests       = EXCLUDED.requests,
        failed_requests = EXCLUDED.failed_requests,
        provider_sourced_requests = EXCLUDED.provider_sourced_requests,
        input_tokens   = EXCLUDED.input_tokens,
        output_tokens  = EXCLUDED.output_tokens,
        quota_tokens   = EXCLUDED.quota_tokens,
        est_cost_micros = EXCLUDED.est_cost_micros
      RETURNING 1 AS rolled
    `);
    return result.rows.length;
  }
}
