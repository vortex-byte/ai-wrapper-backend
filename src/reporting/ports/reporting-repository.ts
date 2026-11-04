import type { TransactionContext } from '@/db/tx.ts';

export type UsageGroupBy = 'user' | 'model' | 'provider' | 'day' | 'month' | 'division';

export interface UsageReportQuery {
  readonly from: Date;
  readonly to: Date;
  readonly groupBy: UsageGroupBy;
  readonly divisionId?: string | undefined;
}

export interface UsageReportRow {
  readonly key: Readonly<Record<string, string | null>>;
  readonly requests: number;
  readonly failedRequests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly quotaTokens: number;
  readonly estimatedCostUsd: number | null;
  readonly usageSource: Readonly<{ provider: number; estimated: number }>;
}

export interface ErrorEventQuery {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly category?: string | undefined;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly limit: number;
  readonly after?: { readonly occurredAt: Date; readonly id: number } | undefined;
}

export interface ErrorEventRow {
  readonly id: number;
  readonly occurredAt: Date;
  readonly requestId: string | null;
  readonly component: string;
  readonly category: string;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly generationId: string | null;
  readonly message: string;
  readonly context: unknown;
}

export interface AuditLogQuery {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly actorUserId?: string | undefined;
  readonly action?: string | undefined;
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  readonly limit: number;
  readonly after?: { readonly createdAt: Date; readonly id: number } | undefined;
}

export interface AuditActor {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
}

export interface AuditLogRow {
  readonly id: number;
  readonly actorUserId: string | null;
  readonly actor: AuditActor | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly userAgentHash: string | null;
  readonly createdAt: Date;
}

export interface UsageWindowQuery {
  readonly from: Date;
  readonly to: Date;
  readonly divisionId?: string | undefined;
}

export interface UsageSummaryRow {
  readonly totalRequests: number;
  readonly totalFailedRequests: number;
  readonly totalInputTokens: number;
  readonly totalCachedTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCostUsd: number;
}

export interface RecentRequestRow {
  readonly id: string;
  readonly model: string;
  readonly modelName: string;
  readonly provider: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
  readonly status: string;
  readonly timestamp: Date;
}

export interface UsageBreakdownRow {
  readonly id: string;
  readonly name: string;
  readonly provider: string | null;
  readonly tokens: number;
  readonly requests: number;
}

export interface UsageTimeseriesRow {
  readonly date: string;
  readonly tokens: number;
  readonly requests: number;
  readonly costUsd: number;
}

export interface ModelUsageRow {
  readonly modelId: string;
  readonly apiModelId: string;
  readonly displayName: string;
  readonly provider: string;
  readonly requests: number;
  readonly lastUsed: Date | null;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly inputCostUsd: number;
  readonly cachedCostUsd: number;
  readonly outputCostUsd: number;
  readonly totalCostUsd: number;
}

export interface RecentRequestQuery {
  readonly limit: number;
  readonly divisionId?: string | undefined;
}

export interface TimeseriesQuery {
  readonly from: Date;
  readonly to: Date;
  readonly interval: 'hour' | 'day';
  readonly divisionId?: string | undefined;
}

export interface ReportingRepository {
  aggregateUsage(
    query: UsageReportQuery,
    tx?: TransactionContext,
  ): Promise<readonly UsageReportRow[]>;

  usageSummary(query: UsageWindowQuery, tx?: TransactionContext): Promise<UsageSummaryRow>;

  listRecentRequests(
    query: RecentRequestQuery,
    tx?: TransactionContext,
  ): Promise<readonly RecentRequestRow[]>;

  usageBreakdown(
    query: UsageWindowQuery,
    tx?: TransactionContext,
  ): Promise<{
    readonly byProvider: readonly UsageBreakdownRow[];
    readonly byModel: readonly UsageBreakdownRow[];
  }>;

  usageTimeseries(
    query: TimeseriesQuery,
    tx?: TransactionContext,
  ): Promise<readonly UsageTimeseriesRow[]>;

  modelUsage(
    query: UsageWindowQuery,
    tx?: TransactionContext,
  ): Promise<readonly ModelUsageRow[]>;

  listErrorEvents(
    query: ErrorEventQuery,
    tx?: TransactionContext,
  ): Promise<readonly ErrorEventRow[]>;

  listAuditLogs(query: AuditLogQuery, tx?: TransactionContext): Promise<readonly AuditLogRow[]>;
}
