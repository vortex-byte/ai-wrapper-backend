import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import {
  aiModelPrices,
  aiModels,
  aiProviders,
  auditLogs,
  divisions,
  errorEvents,
  usageDaily,
  usageEvents,
  users,
} from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import type {
  AuditLogQuery,
  AuditLogRow,
  ErrorEventQuery,
  ErrorEventRow,
  ModelUsageRow,
  RecentRequestQuery,
  RecentRequestRow,
  ReportingRepository,
  TimeseriesQuery,
  UsageBreakdownRow,
  UsageReportQuery,
  UsageReportRow,
  UsageSummaryRow,
  UsageTimeseriesRow,
  UsageWindowQuery,
} from '../ports/reporting-repository.ts';

const MICROS_PER_USD = 1_000_000;

const WINDOW_START_CLAUSE = (from: Date, to: Date, divisionId?: string): SQL => {
  const start = sql`${usageEvents.createdAt} >= ${from.toISOString()}`;
  const end = sql`${usageEvents.createdAt} <= ${to.toISOString()}`;
  const scope = divisionId === undefined ? undefined : eq(usageEvents.divisionId, divisionId);
  return scope === undefined ? sql`${start} AND ${end}` : sql`${start} AND ${end} AND ${scope}`;
};

export class DrizzleReportingRepository implements ReportingRepository {
  async aggregateUsage(
    query: UsageReportQuery,
    tx?: TransactionContext,
  ): Promise<readonly UsageReportRow[]> {
    const fromDay = query.from.toISOString().slice(0, 10);
    const toDay = query.to.toISOString().slice(0, 10);
    const conditions: SQL[] = [gte(usageDaily.day, fromDay), lte(usageDaily.day, toDay)];
    if (query.divisionId !== undefined) {
      conditions.push(eq(usageDaily.divisionId, query.divisionId));
    }
    const where = and(...conditions);

    const sums = {
      requests: sql<number>`COALESCE(sum(${usageDaily.requests}), 0)::int`,
      failedRequests: sql<number>`COALESCE(sum(${usageDaily.failedRequests}), 0)::int`,
      providerSourced: sql<number>`COALESCE(sum(${usageDaily.providerSourcedRequests}), 0)::int`,
      inputTokens: sql<number>`COALESCE(sum(${usageDaily.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`COALESCE(sum(${usageDaily.outputTokens}), 0)::bigint`,
      quotaTokens: sql<number>`COALESCE(sum(${usageDaily.quotaTokens}), 0)::bigint`,
      estCostMicros: sql<number | null>`sum(${usageDaily.estCostMicros})::bigint`,
    };

    interface SumRow {
      requests: number;
      failedRequests: number;
      providerSourced: number;
      inputTokens: number;
      outputTokens: number;
      quotaTokens: number;
      estCostMicros: number | null;
    }

    const toRow = (key: Record<string, string | null>, row: SumRow): UsageReportRow => {
      const requests = Number(row.requests);
      const providerSourced = Number(row.providerSourced);
      return {
        key,
        requests,
        failedRequests: Number(row.failedRequests),
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        quotaTokens: Number(row.quotaTokens),
        estimatedCostUsd:
          row.estCostMicros === null ? null : Number(row.estCostMicros) / MICROS_PER_USD,
        usageSource: {
          provider: requests === 0 ? 0 : providerSourced / requests,
          estimated: requests === 0 ? 0 : (requests - providerSourced) / requests,
        },
      };
    };

    const db = runDb(tx);

    switch (query.groupBy) {
      case 'user': {
        const rows = await db
          .select({
            key: usageDaily.userId,
            email: users.email,
            displayName: users.displayName,
            ...sums,
          })
          .from(usageDaily)
          .leftJoin(users, eq(users.id, usageDaily.userId))
          .where(where)
          .groupBy(usageDaily.userId, users.email, users.displayName)
          .orderBy(desc(sums.quotaTokens), usageDaily.userId);
        return rows.map((row) =>
          toRow({ userId: row.key, email: row.email, displayName: row.displayName }, row),
        );
      }
      case 'division': {
        const rows = await db
          .select({ key: usageDaily.divisionId, name: divisions.name, ...sums })
          .from(usageDaily)
          .leftJoin(divisions, eq(divisions.id, usageDaily.divisionId))
          .where(where)
          .groupBy(usageDaily.divisionId, divisions.name)
          .orderBy(desc(sums.quotaTokens), usageDaily.divisionId);
        return rows.map((row) => toRow({ divisionId: row.key, name: row.name }, row));
      }
      case 'model': {
        const rows = await db
          .select({
            key: usageDaily.modelId,
            modelKey: aiModels.apiModelId,
            displayName: aiModels.displayName,
            provider: aiProviders.key,
            ...sums,
          })
          .from(usageDaily)
          .leftJoin(aiModels, eq(aiModels.id, usageDaily.modelId))
          .leftJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
          .where(where)
          .groupBy(usageDaily.modelId, aiModels.apiModelId, aiModels.displayName, aiProviders.key)
          .orderBy(usageDaily.modelId);
        return rows.map((row) =>
          toRow(
            {
              modelId: row.key,
              modelKey: row.modelKey,
              displayName: row.displayName,
              provider: row.provider,
            },
            row,
          ),
        );
      }
      case 'provider': {
        const rows = await db
          .select({
            key: usageDaily.providerId,
            providerKey: aiProviders.key,
            displayName: aiProviders.displayName,
            ...sums,
          })
          .from(usageDaily)
          .leftJoin(aiProviders, eq(aiProviders.id, usageDaily.providerId))
          .where(where)
          .groupBy(usageDaily.providerId, aiProviders.key, aiProviders.displayName)
          .orderBy(usageDaily.providerId);
        return rows.map((row) =>
          toRow(
            { providerId: row.key, providerKey: row.providerKey, displayName: row.displayName },
            row,
          ),
        );
      }
      case 'month': {
        const monthExpr = sql<string>`to_char(${usageDaily.day}, 'YYYY-MM')`;
        const rows = await db
          .select({ key: monthExpr, ...sums })
          .from(usageDaily)
          .where(where)
          .groupBy(monthExpr)
          .orderBy(monthExpr);
        return rows.map((row) => toRow({ month: row.key }, row));
      }
      case 'day':
      default: {
        const rows = await db
          .select({ key: usageDaily.day, ...sums })
          .from(usageDaily)
          .where(where)
          .groupBy(usageDaily.day)
          .orderBy(usageDaily.day);
        return rows.map((row) => toRow({ day: row.key }, row));
      }
    }
  }

  async usageSummary(query: UsageWindowQuery, tx?: TransactionContext): Promise<UsageSummaryRow> {
    const rows = await runDb(tx)
      .select({
        totalRequests: sql<number>`count(*)::int`,
        totalFailedRequests: sql<number>`count(*) FILTER (WHERE ${usageEvents.outcome} = 'failed')::int`,
        totalInputTokens: sql<number>`COALESCE(sum(${usageEvents.inputTokens}), 0)::bigint`,
        totalCachedTokens: sql<number>`COALESCE(sum(${usageEvents.cachedInputTokens}), 0)::bigint`,
        totalOutputTokens: sql<number>`COALESCE(sum(${usageEvents.outputTokens}), 0)::bigint`,
        totalCostMicros: sql<number>`COALESCE(sum(${usageEvents.estCostMicros}), 0)::bigint`,
      })
      .from(usageEvents)
      .where(WINDOW_START_CLAUSE(query.from, query.to, query.divisionId));

    const row = rows[0];
    if (row === undefined) {
      return {
        totalRequests: 0,
        totalFailedRequests: 0,
        totalInputTokens: 0,
        totalCachedTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
      };
    }
    return {
      totalRequests: Number(row.totalRequests),
      totalFailedRequests: Number(row.totalFailedRequests),
      totalInputTokens: Number(row.totalInputTokens),
      totalCachedTokens: Number(row.totalCachedTokens),
      totalOutputTokens: Number(row.totalOutputTokens),
      totalCostUsd: Number(row.totalCostMicros) / MICROS_PER_USD,
    };
  }

  async listRecentRequests(
    query: RecentRequestQuery,
    tx?: TransactionContext,
  ): Promise<readonly RecentRequestRow[]> {
    const rows = await runDb(tx)
      .select({
        id: usageEvents.id,
        model: aiModels.apiModelId,
        modelName: aiModels.displayName,
        provider: aiProviders.key,
        promptTokens: usageEvents.inputTokens,
        completionTokens: usageEvents.outputTokens,
        cachedTokens: usageEvents.cachedInputTokens,
        outcome: usageEvents.outcome,
        createdAt: usageEvents.createdAt,
      })
      .from(usageEvents)
      .leftJoin(aiModels, eq(aiModels.id, usageEvents.modelId))
      .leftJoin(aiProviders, eq(aiProviders.id, usageEvents.providerId))
      .where(
        query.divisionId === undefined
          ? undefined
          : eq(usageEvents.divisionId, query.divisionId),
      )
      .orderBy(desc(usageEvents.createdAt))
      .limit(query.limit);

    return rows.map((row) => ({
      id: row.id,
      model: row.model ?? 'unknown',
      modelName: row.modelName ?? row.model ?? 'unknown',
      provider: row.provider ?? 'unknown',
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
      cachedTokens: Number(row.cachedTokens ?? 0),
      status: row.outcome === 'failed' ? 'error' : 'ok',
      timestamp: row.createdAt,
    }));
  }

  async usageBreakdown(
    query: UsageWindowQuery,
    tx?: TransactionContext,
  ): Promise<{
    readonly byProvider: readonly UsageBreakdownRow[];
    readonly byModel: readonly UsageBreakdownRow[];
  }> {
    const where = WINDOW_START_CLAUSE(query.from, query.to, query.divisionId);
    const tokenExpr = sql<number>`COALESCE(sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens}), 0)::bigint`;

    const db = runDb(tx);

    const providerQuery = db
      .select({
        id: aiProviders.id,
        name: aiProviders.displayName,
        tokens: tokenExpr,
        requests: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .leftJoin(aiProviders, eq(aiProviders.id, usageEvents.providerId))
      .where(where)
      .groupBy(aiProviders.id, aiProviders.displayName)
      .orderBy(desc(tokenExpr));

    const modelQuery = db
      .select({
        id: aiModels.id,
        name: aiModels.displayName,
        provider: aiProviders.key,
        tokens: tokenExpr,
        requests: sql<number>`count(*)::int`,
      })
      .from(usageEvents)
      .leftJoin(aiModels, eq(aiModels.id, usageEvents.modelId))
      .leftJoin(aiProviders, eq(aiProviders.id, usageEvents.providerId))
      .where(where)
      .groupBy(aiModels.id, aiModels.displayName, aiProviders.key)
      .orderBy(desc(tokenExpr));

    const [providerRows, modelRows] = tx
      ? [await providerQuery, await modelQuery]
      : await Promise.all([providerQuery, modelQuery]);

    const toBreakdown = (row: {
      id: string | null;
      name: string | null;
      provider?: string | null;
      tokens: number;
      requests: number;
    }): UsageBreakdownRow => ({
      id: row.id ?? 'unknown',
      name: row.name ?? 'Unknown',
      provider: row.provider ?? null,
      tokens: Number(row.tokens),
      requests: Number(row.requests),
    });

    return {
      byProvider: providerRows.map(toBreakdown),
      byModel: modelRows.map(toBreakdown),
    };
  }

  async usageTimeseries(
    query: TimeseriesQuery,
    tx?: TransactionContext,
  ): Promise<readonly UsageTimeseriesRow[]> {
    const interval = query.interval === 'hour' ? 'hour' : 'day';
    const bucket = sql<string>`to_char(date_trunc(${sql.raw(`'${interval}'`)}, ${usageEvents.createdAt} AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI')`;
    const rows = await runDb(tx)
      .select({
        bucket,
        tokens: sql<number>`COALESCE(sum(${usageEvents.inputTokens} + ${usageEvents.outputTokens}), 0)::bigint`,
        requests: sql<number>`count(*)::int`,
        costMicros: sql<number>`COALESCE(sum(${usageEvents.estCostMicros}), 0)::bigint`,
      })
      .from(usageEvents)
      .where(WINDOW_START_CLAUSE(query.from, query.to, query.divisionId))
      .groupBy(bucket)
      .orderBy(bucket);

    return rows.map((row) => ({
      date: row.bucket,
      tokens: Number(row.tokens),
      requests: Number(row.requests),
      costUsd: Number(row.costMicros) / MICROS_PER_USD,
    }));
  }

  async modelUsage(
    query: UsageWindowQuery,
    tx?: TransactionContext,
  ): Promise<readonly ModelUsageRow[]> {
    const where = WINDOW_START_CLAUSE(query.from, query.to, query.divisionId);
    const rows = await runDb(tx)
      .select({
        modelId: aiModels.id,
        apiModelId: aiModels.apiModelId,
        displayName: aiModels.displayName,
        provider: aiProviders.displayName,
        requests: sql<number>`count(*)::int`,
        lastUsed: sql<Date | null>`max(${usageEvents.createdAt})`,
        inputTokens: sql<number>`COALESCE(sum(${usageEvents.inputTokens}), 0)::bigint`,
        cachedTokens: sql<number>`COALESCE(sum(${usageEvents.cachedInputTokens}), 0)::bigint`,
        outputTokens: sql<number>`COALESCE(sum(${usageEvents.outputTokens}), 0)::bigint`,
      })
      .from(usageEvents)
      .leftJoin(aiModels, eq(aiModels.id, usageEvents.modelId))
      .leftJoin(aiProviders, eq(aiProviders.id, usageEvents.providerId))
      .where(where)
      .groupBy(aiModels.id, aiModels.apiModelId, aiModels.displayName, aiProviders.displayName);

    const prices = await runDb(tx)
      .select({
        modelId: aiModelPrices.modelId,
        inputMicrosPerMtok: aiModelPrices.inputMicrosPerMtok,
        outputMicrosPerMtok: aiModelPrices.outputMicrosPerMtok,
        cachedInputMicrosPerMtok: aiModelPrices.cachedInputMicrosPerMtok,
      })
      .from(aiModelPrices);

    const priceByModel = new Map<string, (typeof prices)[number]>();
    for (const price of prices) {
      if (!priceByModel.has(price.modelId)) priceByModel.set(price.modelId, price);
    }

    return rows.map((row) => {
      const inputTokens = Number(row.inputTokens);
      const cachedTokens = Number(row.cachedTokens);
      const outputTokens = Number(row.outputTokens);
      const price = row.modelId === null ? undefined : priceByModel.get(row.modelId);
      const nonCachedInput = Math.max(0, inputTokens - cachedTokens);
      const inputCostUsd =
        price === undefined ? 0 : (nonCachedInput * price.inputMicrosPerMtok) / MICROS_PER_USD / 1_000_000;
      const cachedMicros = price?.cachedInputMicrosPerMtok ?? price?.inputMicrosPerMtok;
      const cachedCostUsd =
        cachedMicros === undefined || cachedMicros === null
          ? 0
          : (cachedTokens * cachedMicros) / MICROS_PER_USD / 1_000_000;
      const outputCostUsd =
        price === undefined ? 0 : (outputTokens * price.outputMicrosPerMtok) / MICROS_PER_USD / 1_000_000;
      return {
        modelId: row.modelId ?? 'unknown',
        apiModelId: row.apiModelId ?? 'unknown',
        displayName: row.displayName ?? row.apiModelId ?? 'Unknown',
        provider: row.provider ?? 'unknown',
        requests: Number(row.requests),
        lastUsed: row.lastUsed === null ? null : new Date(row.lastUsed),
        inputTokens,
        cachedTokens,
        outputTokens,
        inputCostUsd,
        cachedCostUsd,
        outputCostUsd,
        totalCostUsd: inputCostUsd + cachedCostUsd + outputCostUsd,
      };
    });
  }

  async listErrorEvents(
    query: ErrorEventQuery,
    tx?: TransactionContext,
  ): Promise<readonly ErrorEventRow[]> {
    const conditions: SQL[] = [];
    if (query.from !== undefined) conditions.push(gte(errorEvents.occurredAt, query.from));
    if (query.to !== undefined) conditions.push(lt(errorEvents.occurredAt, query.to));
    if (query.category !== undefined) conditions.push(eq(errorEvents.category, query.category));
    if (query.providerId !== undefined) conditions.push(eq(errorEvents.providerId, query.providerId));
    if (query.modelId !== undefined) conditions.push(eq(errorEvents.modelId, query.modelId));
    if (query.after !== undefined) {
      const keyset = or(
        lt(errorEvents.occurredAt, query.after.occurredAt),
        and(eq(errorEvents.occurredAt, query.after.occurredAt), lt(errorEvents.id, query.after.id)),
      );
      if (keyset !== undefined) conditions.push(keyset);
    }

    const rows = await runDb(tx)
      .select({
        id: errorEvents.id,
        occurredAt: errorEvents.occurredAt,
        requestId: errorEvents.requestId,
        component: errorEvents.component,
        category: errorEvents.category,
        providerId: errorEvents.providerId,
        modelId: errorEvents.modelId,
        generationId: errorEvents.generationId,
        message: errorEvents.message,
        context: errorEvents.context,
      })
      .from(errorEvents)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(errorEvents.occurredAt), desc(errorEvents.id))
      .limit(query.limit);

    return rows.map((row) => ({
      id: Number(row.id),
      occurredAt: row.occurredAt,
      requestId: row.requestId,
      component: row.component,
      category: row.category,
      providerId: row.providerId,
      modelId: row.modelId,
      generationId: row.generationId,
      message: row.message,
      context: row.context,
    }));
  }

  async listAuditLogs(
    query: AuditLogQuery,
    tx?: TransactionContext,
  ): Promise<readonly AuditLogRow[]> {
    const conditions: SQL[] = [];
    if (query.from !== undefined) conditions.push(gte(auditLogs.createdAt, query.from));
    if (query.to !== undefined) conditions.push(lte(auditLogs.createdAt, query.to));
    if (query.actorUserId !== undefined) {
      conditions.push(eq(auditLogs.actorUserId, query.actorUserId));
    }
    if (query.action !== undefined) conditions.push(eq(auditLogs.action, query.action));
    if (query.targetType !== undefined) conditions.push(eq(auditLogs.targetType, query.targetType));
    if (query.targetId !== undefined) conditions.push(eq(auditLogs.targetId, query.targetId));
    if (query.after !== undefined) {
      const keyset = or(
        lt(auditLogs.createdAt, query.after.createdAt),
        and(eq(auditLogs.createdAt, query.after.createdAt), lt(auditLogs.id, query.after.id)),
      );
      if (keyset !== undefined) conditions.push(keyset);
    }

    const rows = await runDb(tx)
      .select({
        id: auditLogs.id,
        actorUserId: auditLogs.actorUserId,
        actorDisplayName: users.displayName,
        actorEmail: users.email,
        action: auditLogs.action,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        before: auditLogs.before,
        after: auditLogs.after,
        requestId: auditLogs.requestId,
        ip: auditLogs.ip,
        userAgentHash: auditLogs.userAgentHash,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.actorUserId, users.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(query.limit);

    return rows.map((row) => ({
      id: Number(row.id),
      actorUserId: row.actorUserId,
      actor:
        row.actorUserId && row.actorDisplayName && row.actorEmail
          ? {
              id: row.actorUserId,
              displayName: row.actorDisplayName,
              email: row.actorEmail,
            }
          : null,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      before: row.before,
      after: row.after,
      requestId: row.requestId,
      ip: row.ip,
      userAgentHash: row.userAgentHash,
      createdAt: row.createdAt,
    }));
  }
}
