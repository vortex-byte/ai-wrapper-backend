import { and, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import {
  aiModels,
  aiProviders,
  auditLogs,
  divisions,
  errorEvents,
  usageDaily,
  users,
} from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import type {
  AuditLogQuery,
  AuditLogRow,
  ErrorEventQuery,
  ErrorEventRow,
  ReportingRepository,
  UsageReportQuery,
  UsageReportRow,
} from '../ports/reporting-repository.ts';

const MICROS_PER_USD = 1_000_000;

export class DrizzleReportingRepository implements ReportingRepository {
  async aggregateUsage(
    query: UsageReportQuery,
    tx?: TransactionContext,
  ): Promise<readonly UsageReportRow[]> {
    const monthExpr = sql<string>`to_char(${usageDaily.day}, 'YYYY-MM')`;

    const dimension = (() => {
      switch (query.groupBy) {
        case 'user':
          return { expr: usageDaily.userId, column: 'userId' as const };
        case 'model':
          return { expr: usageDaily.modelId, column: 'modelId' as const };
        case 'provider':
          return { expr: usageDaily.providerId, column: 'providerId' as const };
        case 'division':
          return { expr: usageDaily.divisionId, column: 'divisionId' as const };
        case 'month':
          return { expr: monthExpr, column: 'month' as const };
        case 'day':
        default:
          return { expr: usageDaily.day, column: 'day' as const };
      }
    })();

    const where = query.divisionId === undefined
      ? and(
          gte(usageDaily.day, query.from.toISOString().slice(0, 10)),
          lte(usageDaily.day, query.to.toISOString().slice(0, 10)),
        )
      : and(
          gte(usageDaily.day, query.from.toISOString().slice(0, 10)),
          lte(usageDaily.day, query.to.toISOString().slice(0, 10)),
          eq(usageDaily.divisionId, query.divisionId),
        );

    const rows = await runDb(tx)
      .select({
        key: sql<string | null>`${dimension.expr}`,
        requests: sql<number>`COALESCE(sum(${usageDaily.requests}), 0)::int`,
        failedRequests: sql<number>`COALESCE(sum(${usageDaily.failedRequests}), 0)::int`,
        providerSourced: sql<number>`COALESCE(sum(${usageDaily.providerSourcedRequests}), 0)::int`,
        inputTokens: sql<number>`COALESCE(sum(${usageDaily.inputTokens}), 0)::bigint`,
        outputTokens: sql<number>`COALESCE(sum(${usageDaily.outputTokens}), 0)::bigint`,
        quotaTokens: sql<number>`COALESCE(sum(${usageDaily.quotaTokens}), 0)::bigint`,
        estCostMicros: sql<number | null>`sum(${usageDaily.estCostMicros})::bigint`,
      })
      .from(usageDaily)
      .where(where)
      .groupBy(dimension.expr)
      .orderBy(
        ...(query.groupBy === 'user' || query.groupBy === 'division'
          ? [desc(sql`COALESCE(sum(${usageDaily.quotaTokens}), 0)`), dimension.expr]
          : [dimension.expr]),
      );

    const labels = await this.resolveLabels(
      query.groupBy,
      rows.map((row) => (row.key === null ? null : String(row.key))),
      tx,
    );

    return rows.map((row) => {
      const rawKey = row.key === null ? null : String(row.key);
      const key: Record<string, string | null> = {
        [dimension.column]: rawKey,
        ...(labels.get(rawKey ?? '') ?? {}),
      };
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
    });
  }

  private async resolveLabels(
    groupBy: UsageReportQuery['groupBy'],
    keys: readonly (string | null)[],
    tx?: TransactionContext,
  ): Promise<Map<string, Record<string, string | null>>> {
    const out = new Map<string, Record<string, string | null>>();
    const ids = Array.from(
      new Set(keys.filter((key): key is string => key !== null && key.length > 0)),
    );
    if (ids.length === 0) return out;

    if (groupBy === 'user') {
      const rows = await runDb(tx)
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, ids));
      for (const row of rows) {
        out.set(row.id, { email: row.email, displayName: row.displayName });
      }
      return out;
    }

    if (groupBy === 'division') {
      const rows = await runDb(tx)
        .select({ id: divisions.id, name: divisions.name })
        .from(divisions)
        .where(inArray(divisions.id, ids));
      for (const row of rows) out.set(row.id, { name: row.name });
      return out;
    }

    if (groupBy === 'model') {
      const rows = await runDb(tx)
        .select({
          id: aiModels.id,
          key: aiModels.key,
          displayName: aiModels.displayName,
          providerKey: aiProviders.key,
        })
        .from(aiModels)
        .leftJoin(aiProviders, eq(aiProviders.id, aiModels.providerId))
        .where(inArray(aiModels.id, ids));
      for (const row of rows) {
        out.set(row.id, {
          modelKey: row.key,
          displayName: row.displayName,
          provider: row.providerKey,
        });
      }
      return out;
    }

    if (groupBy === 'provider') {
      const rows = await runDb(tx)
        .select({ id: aiProviders.id, key: aiProviders.key, displayName: aiProviders.displayName })
        .from(aiProviders)
        .where(inArray(aiProviders.id, ids));
      for (const row of rows) {
        out.set(row.id, { providerKey: row.key, displayName: row.displayName });
      }
    }

    return out;
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
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(query.limit);

    return rows.map((row) => ({
      id: Number(row.id),
      actorUserId: row.actorUserId,
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
