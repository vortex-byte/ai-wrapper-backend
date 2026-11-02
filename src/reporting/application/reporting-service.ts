import { AppError } from '@/errors.ts';
import { redactValue } from '../domain/redaction.ts';
import type {
  AuditLogQuery,
  AuditLogRow,
  ErrorEventQuery,
  ErrorEventRow,
  ReportingRepository,
  UsageGroupBy,
  UsageReportRow,
  RecentRequestRow,
  UsageSummaryRow,
} from '../ports/reporting-repository.ts';

export interface ReportingServiceDeps {
  readonly repository: ReportingRepository;
  readonly now?: (() => Date) | undefined;
}

export interface UsageReportInput {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly groupBy: UsageGroupBy;
  readonly divisionId?: string | undefined;
}

export interface UsageWindowInput {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly divisionId?: string | undefined;
}

export interface UsageSummaryInput extends UsageWindowInput {
  readonly period?: string | undefined;
}

export interface UsageTimeseriesInput extends UsageWindowInput {
  readonly interval: 'hour' | 'day';
}

export interface ErrorExplorerInput {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly category?: string | undefined;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface AuditSearchInput {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly action?: string | undefined;
  readonly targetType?: string | undefined;
  readonly targetId?: string | undefined;
  readonly limit: number;
  readonly cursor?: string | undefined;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface WireErrorEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly requestId: string | null;
  readonly component: string;
  readonly category: string;
  readonly providerId: string | null;
  readonly modelId: string | null;
  readonly generationId: string | null;
  readonly message: string;
  readonly context: unknown;
}

export interface WireAuditActor {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
}

export interface WireAuditLog {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly actor: WireAuditActor | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly requestId: string | null;
  readonly ip: string | null;
  readonly createdAt: string;
}

export interface WireBreakdownEntry {
  readonly id: string;
  readonly name: string;
  readonly provider: string | null;
  readonly tokens: number;
  readonly requests: number;
}

export interface UsageBreakdownResult {
  readonly byProvider: readonly WireBreakdownEntry[];
  readonly byModel: readonly WireBreakdownEntry[];
}

export interface WireTimeseriesPoint {
  readonly date: string;
  readonly label: string;
  readonly tokens: number;
  readonly requests: number;
  readonly costUsd: number;
}

export interface WireModelUsage {
  readonly modelId: string;
  readonly apiModelId: string;
  readonly displayName: string;
  readonly provider: string;
  readonly requests: number;
  readonly lastUsed: string | null;
  readonly inputTokens: number;
  readonly cachedTokens: number;
  readonly outputTokens: number;
  readonly inputCostUsd: number;
  readonly cachedCostUsd: number;
  readonly outputCostUsd: number;
  readonly totalCostUsd: number;
}

export type { UsageSummaryRow };

const DEFAULT_RANGE_DAYS = 30;

function encodeCursor(date: Date, id: number): string {
  return Buffer.from(`${date.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { date: Date; id: number } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) return null;
    const date = new Date(decoded.slice(0, separator));
    const id = Number(decoded.slice(separator + 1));
    if (Number.isNaN(date.getTime()) || !Number.isSafeInteger(id)) return null;
    return { date, id };
  } catch {
    return null;
  }
}

function parseDate(raw: string | undefined): Date | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export class ReportingService {
  private readonly repository: ReportingRepository;
  private readonly now: () => Date;

  constructor(deps: ReportingServiceDeps) {
    this.repository = deps.repository;
    this.now = deps.now ?? (() => new Date());
  }

  private range(from: string | undefined, to: string | undefined): { from: Date; to: Date } {
    const now = this.now();
    const resolvedTo = parseDate(to) ?? now;
    const resolvedFrom =
      parseDate(from) ?? new Date(resolvedTo.getTime() - DEFAULT_RANGE_DAYS * 24 * 3600 * 1000);
    return { from: resolvedFrom, to: resolvedTo };
  }

  private periodRange(
    period: string | undefined,
    from: string | undefined,
    to: string | undefined,
  ): { from: Date; to: Date } {
    const now = this.now();
    if (period === undefined || period === 'all') return this.range(from, to);
    if (period === 'today') {
      const start = new Date(now);
      start.setUTCHours(0, 0, 0, 0);
      return { from: start, to: now };
    }
    const hours: Record<string, number> = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30, '90d': 24 * 90 };
    const span = hours[period];
    if (span === undefined) return this.range(from, to);
    return { from: new Date(now.getTime() - span * 3600 * 1000), to: now };
  }

  async usage(input: UsageReportInput): Promise<readonly UsageReportRow[]> {
    const { from, to } = this.range(input.from, input.to);
    return this.repository.aggregateUsage({
      from,
      to,
      groupBy: input.groupBy,
      divisionId: input.divisionId,
    });
  }

  async usageSummary(input: UsageSummaryInput): Promise<UsageSummaryRow> {
    const { from, to } = this.periodRange(input.period, input.from, input.to);
    return this.repository.usageSummary({ from, to, divisionId: input.divisionId });
  }

  async recentRequests(input: { limit: number }): Promise<readonly RecentRequestRow[]> {
    return this.repository.listRecentRequests({ limit: input.limit });
  }

  async usageBreakdown(input: UsageWindowInput): Promise<UsageBreakdownResult> {
    const { from, to } = this.range(input.from, input.to);
    const result = await this.repository.usageBreakdown({ from, to, divisionId: input.divisionId });
    return {
      byProvider: result.byProvider.map(toWireBreakdown),
      byModel: result.byModel.map(toWireBreakdown),
    };
  }

  async usageTimeseries(input: UsageTimeseriesInput): Promise<readonly WireTimeseriesPoint[]> {
    const { from, to } = this.range(input.from, input.to);
    const rows = await this.repository.usageTimeseries({
      from,
      to,
      interval: input.interval,
      divisionId: input.divisionId,
    });
    return rows.map((row) => ({
      date: row.date,
      label: formatBucketLabel(row.date, input.interval),
      tokens: row.tokens,
      requests: row.requests,
      costUsd: row.costUsd,
    }));
  }

  async modelUsage(input: UsageWindowInput): Promise<readonly WireModelUsage[]> {
    const { from, to } = this.range(input.from, input.to);
    const rows = await this.repository.modelUsage({ from, to, divisionId: input.divisionId });
    return rows.map((row) => ({
      modelId: row.modelId,
      apiModelId: row.apiModelId,
      displayName: row.displayName,
      provider: row.provider,
      requests: row.requests,
      lastUsed: row.lastUsed === null ? null : row.lastUsed.toISOString(),
      inputTokens: row.inputTokens,
      cachedTokens: row.cachedTokens,
      outputTokens: row.outputTokens,
      inputCostUsd: row.inputCostUsd,
      cachedCostUsd: row.cachedCostUsd,
      outputCostUsd: row.outputCostUsd,
      totalCostUsd: row.totalCostUsd,
    }));
  }

  async usageCsv(input: UsageReportInput): Promise<string> {
    const rows = await this.usage(input);
    const keyColumns = Array.from(
      new Set(rows.flatMap((row) => Object.keys(row.key))),
    ).sort();

    const header = [
      ...keyColumns,
      'requests',
      'failedRequests',
      'inputTokens',
      'outputTokens',
      'quotaTokens',
      'estimatedCostUsd',
      'usageSourceProvider',
      'usageSourceEstimated',
    ];

    const lines = [header.join(',')];
    for (const row of rows) {
      const values = [
        ...keyColumns.map((column) => csvCell(row.key[column] ?? '')),
        String(row.requests),
        String(row.failedRequests),
        String(row.inputTokens),
        String(row.outputTokens),
        String(row.quotaTokens),
        row.estimatedCostUsd === null ? '' : row.estimatedCostUsd.toFixed(6),
        row.usageSource.provider.toFixed(6),
        row.usageSource.estimated.toFixed(6),
      ];
      lines.push(values.join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  async errors(input: ErrorExplorerInput): Promise<Page<WireErrorEvent>> {
    const after = this.cursorOrThrow(input.cursor, 'error');
    const query: ErrorEventQuery = {
      from: parseDate(input.from),
      to: parseDate(input.to),
      category: input.category,
      providerId: input.providerId,
      modelId: input.modelId,
      limit: input.limit + 1,
      after: after === null ? undefined : { occurredAt: after.date, id: after.id },
    };
    const rows = await this.repository.listErrorEvents(query);
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toWireErrorEvent),
      nextCursor:
        rows.length > input.limit && last !== undefined
          ? encodeCursor(last.occurredAt, last.id)
          : null,
    };
  }

  async auditLogs(input: AuditSearchInput): Promise<Page<WireAuditLog>> {
    const after = this.cursorOrThrow(input.cursor, 'audit');
    const query: AuditLogQuery = {
      from: parseDate(input.from),
      to: parseDate(input.to),
      actorUserId: input.actorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      limit: input.limit + 1,
      after: after === null ? undefined : { createdAt: after.date, id: after.id },
    };
    const rows = await this.repository.listAuditLogs(query);
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toWireAuditLog),
      nextCursor:
        rows.length > input.limit && last !== undefined
          ? encodeCursor(last.createdAt, last.id)
          : null,
    };
  }

  private cursorOrThrow(
    cursor: string | undefined,
    kind: 'error' | 'audit',
  ): { date: Date; id: number } | null {
    if (cursor === undefined || cursor === '') return null;
    const parsed = decodeCursor(cursor);
    if (parsed === null) {
      throw new AppError('invalid_request', `Invalid ${kind} pagination cursor.`, {
        details: { cursor: 'malformed' },
      });
    }
    return parsed;
  }
}

function csvCell(value: string): string {
  if (value === '') return '';
  // Neutralize CSV formula injection: prefix leading formula triggers with a single quote.
  const sanitized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(sanitized)) return `"${sanitized.replaceAll('"', '""')}"`;
  return sanitized;
}

function toWireErrorEvent(row: ErrorEventRow): WireErrorEvent {
  return {
    id: String(row.id),
    occurredAt: row.occurredAt.toISOString(),
    requestId: row.requestId,
    component: row.component,
    category: row.category,
    providerId: row.providerId,
    modelId: row.modelId,
    generationId: row.generationId,
    message: row.message,
    context: redactValue(row.context),
  };
}

function toWireBreakdown(row: {
  readonly id: string;
  readonly name: string;
  readonly provider: string | null;
  readonly tokens: number;
  readonly requests: number;
}): WireBreakdownEntry {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    tokens: row.tokens,
    requests: row.requests,
  };
}

const bucketLabelDay = new Intl.DateTimeFormat('id-ID', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

function formatBucketLabel(date: string, interval: 'hour' | 'day'): string {
  const instant = new Date(
    interval === 'hour' ? `${date.replace(' ', 'T')}:00Z` : `${date}T00:00:00Z`,
  );
  if (Number.isNaN(instant.getTime())) return date;
  if (interval === 'hour') {
    return new Intl.DateTimeFormat('id-ID', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      timeZone: 'UTC',
    }).format(instant);
  }
  return bucketLabelDay.format(instant);
}

function toWireAuditLog(row: AuditLogRow): WireAuditLog {
  return {
    id: String(row.id),
    actorUserId: row.actorUserId,
    actor: row.actor,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    before: redactValue(row.before),
    after: redactValue(row.after),
    requestId: row.requestId,
    ip: row.ip,
    createdAt: row.createdAt.toISOString(),
  };
}
