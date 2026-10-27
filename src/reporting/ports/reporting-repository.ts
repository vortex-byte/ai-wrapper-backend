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

export interface AuditLogRow {
  readonly id: number;
  readonly actorUserId: string | null;
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

export interface ReportingRepository {
  aggregateUsage(
    query: UsageReportQuery,
    tx?: TransactionContext,
  ): Promise<readonly UsageReportRow[]>;

  listErrorEvents(
    query: ErrorEventQuery,
    tx?: TransactionContext,
  ): Promise<readonly ErrorEventRow[]>;

  listAuditLogs(query: AuditLogQuery, tx?: TransactionContext): Promise<readonly AuditLogRow[]>;
}
