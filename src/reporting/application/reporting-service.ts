import { AppError } from '@/errors.ts';
import { redactValue } from '../domain/redaction.ts';
import type {
  AuditLogQuery,
  AuditLogRow,
  ErrorEventQuery,
  ErrorEventRow,
  ModelUsageRow,
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

export const USAGE_REPORT_SECTIONS = [
  'summary',
  'recent',
  'breakdown',
  'timeseries',
  'models',
  'byDivision',
  'byUser',
] as const;

export type UsageReportSection = (typeof USAGE_REPORT_SECTIONS)[number];

export interface UsageTableSection {
  readonly pagination: {
    readonly page: number;
    readonly limit: number;
    readonly totalItems: number;
    readonly totalPages: number;
  };
  readonly items: readonly UsageReportRow[];
}

export interface UsageWindowInput {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly divisionId?: string | undefined;
  readonly sections?: readonly UsageReportSection[] | undefined;
  readonly page?: number | undefined;
  readonly limit?: number | undefined;
  readonly search?: string | undefined;
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

export interface WireRecentRequest {
  readonly id: string;
  readonly model: string;
  readonly modelName: string;
  readonly provider: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
  readonly status: string;
  readonly timestamp: string;
}

export interface WireWindow {
  readonly from: string;
  readonly to: string;
}

export interface DashboardReport {
  readonly window: WireWindow;
  readonly summary: UsageSummaryRow;
  readonly recent: readonly WireRecentRequest[];
  readonly breakdown: UsageBreakdownResult;
  readonly models: readonly WireModelUsage[];
  readonly departmentUsage: readonly UsageReportRow[];
}

export interface UsageReportResult {
  readonly window: WireWindow;
  readonly pagination?: UsageTableSection['pagination'] | undefined;
  readonly items?: readonly UsageReportRow[] | undefined;
  readonly summary?: UsageSummaryRow | undefined;
  readonly recent?: readonly WireRecentRequest[] | undefined;
  readonly breakdown?: UsageBreakdownResult | undefined;
  readonly timeseries?: readonly WireTimeseriesPoint[] | undefined;
  readonly models?: readonly WireModelUsage[] | undefined;
  readonly byDivision?: readonly UsageReportRow[] | undefined;
  readonly byUser?: readonly UsageReportRow[] | undefined;
}

export type { UsageSummaryRow };

const DEFAULT_RANGE_DAYS = 30;

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;

interface CsvHeaders {
  readonly keyColumns: Readonly<Record<string, string>>;
  readonly requests: string;
  readonly failedRequests: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly quotaTokens: string;
  readonly estimatedCostUsd: string;
  readonly usageSourceProvider: string;
  readonly usageSourceEstimated: string;
}

const CSV_HEADERS_ID: CsvHeaders = {
  keyColumns: {
    userId: 'ID Pengguna',
    email: 'Email',
    displayName: 'Nama Lengkap',
    divisionId: 'ID Departemen',
    name: 'Nama Departemen',
    modelId: 'ID Model',
    modelKey: 'Kode Model',
    provider: 'Provider',
    providerId: 'ID Provider',
    providerKey: 'Kode Provider',
    day: 'Tanggal',
    month: 'Bulan',
  },
  requests: 'Total Permintaan',
  failedRequests: 'Permintaan Gagal',
  inputTokens: 'Token Input',
  outputTokens: 'Token Output',
  quotaTokens: 'Token Terpakai',
  estimatedCostUsd: 'Estimasi Biaya (USD)',
  usageSourceProvider: 'Sumber Penggunaan (Provider)',
  usageSourceEstimated: 'Sumber Penggunaan (Estimasi)',
};

function matchesSearch(row: UsageReportRow, search: string): boolean {
  if (search === '') return true;
  return Object.values(row.key).some(
    (value) => value !== null && value.toLowerCase().includes(search),
  );
}

function paginateUsageRows(
  rows: readonly UsageReportRow[],
  search: string | undefined,
  page: number | undefined,
  limit: number | undefined,
): UsageTableSection {
  const needle = (search ?? '').trim().toLowerCase();
  const filtered = needle === '' ? rows : rows.filter((row) => matchesSearch(row, needle));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, limit ?? DEFAULT_PAGE_SIZE));
  const pageIndex = Math.max(1, page ?? 1);
  const totalItems = filtered.length;
  const start = (pageIndex - 1) * pageSize;

  return {
    pagination: {
      page: pageIndex,
      limit: pageSize,
      totalItems,
      totalPages: totalItems === 0 ? 0 : Math.ceil(totalItems / pageSize),
    },
    items: filtered.slice(start, start + pageSize),
  };
}

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

  async usage(input: UsageReportInput): Promise<readonly UsageReportRow[]> {
    const { from, to } = this.range(input.from, input.to);
    return this.repository.aggregateUsage({
      from,
      to,
      groupBy: input.groupBy,
      divisionId: input.divisionId,
    });
  }

  async dashboard(): Promise<DashboardReport> {
    const now = this.now();
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(now);
    dayEnd.setUTCHours(23, 59, 59, 999);

    const [summary, recentRows, breakdown, modelRows, departmentUsage] = await Promise.all([
      this.repository.usageSummary({ from: dayStart, to: dayEnd }),
      this.repository.listRecentRequests({ limit: 20 }),
      this.repository.usageBreakdown({ from: dayStart, to: dayEnd }),
      this.repository.modelUsage({ from: dayStart, to: dayEnd }),
      this.repository.aggregateUsage({ from: dayStart, to: dayEnd, groupBy: 'division' }),
    ]);

    return {
      window: { from: dayStart.toISOString(), to: dayEnd.toISOString() },
      summary,
      recent: recentRows.map(toWireRecentRequest),
      breakdown: {
        byProvider: breakdown.byProvider.map(toWireBreakdown),
        byModel: breakdown.byModel.map(toWireBreakdown),
      },
      models: modelRows.map(toWireModelUsage),
      departmentUsage,
    };
  }

  async usageReport(input: UsageWindowInput): Promise<UsageReportResult> {
    const { from, to } = this.range(input.from, input.to);
    const divisionId = input.divisionId;
    const wanted = new Set<UsageReportSection>(input.sections ?? USAGE_REPORT_SECTIONS);
    const wants = (section: UsageReportSection) => wanted.has(section);

    const table = wants('byDivision')
      ? ('division' as const)
      : wants('byUser')
        ? ('user' as const)
        : undefined;

    const [summary, recentRows, breakdown, timeseriesRows, modelRows, tableRows] =
      await Promise.all([
        wants('summary') ? this.repository.usageSummary({ from, to, divisionId }) : undefined,
        wants('recent') ? this.repository.listRecentRequests({ limit: 20, divisionId }) : undefined,
        wants('breakdown') ? this.repository.usageBreakdown({ from, to, divisionId }) : undefined,
        wants('timeseries')
          ? this.repository.usageTimeseries({ from, to, interval: 'day', divisionId })
          : undefined,
        wants('models') ? this.repository.modelUsage({ from, to, divisionId }) : undefined,
        table === undefined
          ? undefined
          : this.repository.aggregateUsage({ from, to, groupBy: table, divisionId }),
      ]);

    const tableSection =
      tableRows === undefined
        ? undefined
        : paginateUsageRows(tableRows, input.search, input.page, input.limit);

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      ...(tableSection === undefined ? {} : { pagination: tableSection.pagination }),
      ...(tableSection === undefined ? {} : { items: tableSection.items }),
      ...(summary === undefined ? {} : { summary }),
      ...(recentRows === undefined ? {} : { recent: recentRows.map(toWireRecentRequest) }),
      ...(breakdown === undefined
        ? {}
        : {
            breakdown: {
              byProvider: breakdown.byProvider.map(toWireBreakdown),
              byModel: breakdown.byModel.map(toWireBreakdown),
            },
          }),
      ...(timeseriesRows === undefined
        ? {}
        : {
            timeseries: timeseriesRows.map((row) => ({
              date: row.date,
              label: formatBucketLabel(row.date, 'day'),
              tokens: row.tokens,
              requests: row.requests,
              costUsd: row.costUsd,
            })),
          }),
      ...(modelRows === undefined ? {} : { models: modelRows.map(toWireModelUsage) }),
      ...(table === 'division' && tableSection !== undefined
        ? { byDivision: tableSection.items }
        : {}),
      ...(table === 'user' && tableSection !== undefined ? { byUser: tableSection.items } : {}),
    };
  }

  async usageCsv(input: UsageReportInput): Promise<string> {
    const rows = await this.usage(input);
    const keyColumns = Array.from(new Set(rows.flatMap((row) => Object.keys(row.key)))).sort();

    const header = [
      ...keyColumns.map((column) => CSV_HEADERS_ID.keyColumns[column] ?? column),
      CSV_HEADERS_ID.requests,
      CSV_HEADERS_ID.failedRequests,
      CSV_HEADERS_ID.inputTokens,
      CSV_HEADERS_ID.outputTokens,
      CSV_HEADERS_ID.quotaTokens,
      CSV_HEADERS_ID.estimatedCostUsd,
      CSV_HEADERS_ID.usageSourceProvider,
      CSV_HEADERS_ID.usageSourceEstimated,
    ];

    const lines = [header.map(csvCell).join(',')];
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

function toWireRecentRequest(row: RecentRequestRow): WireRecentRequest {
  return {
    id: row.id,
    model: row.model,
    modelName: row.modelName,
    provider: row.provider,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    cachedTokens: row.cachedTokens,
    status: row.status,
    timestamp: row.timestamp.toISOString(),
  };
}

function toWireModelUsage(row: ModelUsageRow): WireModelUsage {
  return {
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
