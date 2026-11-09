import { describe, expect, it } from 'vitest';
import { AppError } from '@/errors.ts';
import { ReportingService } from '@/reporting/application/reporting-service.ts';
import type {
  AuditLogQuery,
  AuditLogRow,
  ErrorEventQuery,
  ErrorEventRow,
  ModelUsageRow,
  RecentRequestRow,
  ReportingRepository,
  UsageBreakdownRow,
  UsageReportQuery,
  UsageReportRow,
  UsageSummaryRow,
  UsageTimeseriesRow,
} from '@/reporting/ports/reporting-repository.ts';

const NOW = new Date('2026-10-20T12:00:00.000Z');

class FakeReportingRepository implements ReportingRepository {
  usageQueries: UsageReportQuery[] = [];
  errorQueries: ErrorEventQuery[] = [];
  auditQueries: AuditLogQuery[] = [];
  summaryQueries: { from: Date; to: Date; divisionId?: string | undefined }[] = [];
  recentQueries: { limit: number; divisionId?: string | undefined }[] = [];

  errorRows: ErrorEventRow[] = [];
  auditRows: AuditLogRow[] = [];
  usageRows: UsageReportRow[] = [];
  recentRows: RecentRequestRow[] = [];
  breakdownRows: { byProvider: UsageBreakdownRow[]; byModel: UsageBreakdownRow[] } = {
    byProvider: [],
    byModel: [],
  };
  timeseriesRows: UsageTimeseriesRow[] = [];
  modelUsageRows: ModelUsageRow[] = [];

  async aggregateUsage(query: UsageReportQuery): Promise<readonly UsageReportRow[]> {
    this.usageQueries.push(query);
    return this.usageRows;
  }

  async listErrorEvents(query: ErrorEventQuery): Promise<readonly ErrorEventRow[]> {
    this.errorQueries.push(query);
    return this.errorRows;
  }

  async listAuditLogs(query: AuditLogQuery): Promise<readonly AuditLogRow[]> {
    this.auditQueries.push(query);
    return this.auditRows;
  }

  async usageSummary(query: {
    from: Date;
    to: Date;
    divisionId?: string | undefined;
  }): Promise<UsageSummaryRow> {
    this.summaryQueries.push(query);
    return {
      totalRequests: 0,
      totalFailedRequests: 0,
      totalInputTokens: 0,
      totalCachedTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
    };
  }

  async listRecentRequests(query: {
    limit: number;
    divisionId?: string | undefined;
  }): Promise<readonly RecentRequestRow[]> {
    this.recentQueries.push(query);
    return this.recentRows;
  }

  async usageBreakdown(): Promise<{
    byProvider: readonly UsageBreakdownRow[];
    byModel: readonly UsageBreakdownRow[];
  }> {
    return this.breakdownRows;
  }

  async usageTimeseries(): Promise<readonly UsageTimeseriesRow[]> {
    return this.timeseriesRows;
  }

  async modelUsage(): Promise<readonly ModelUsageRow[]> {
    return this.modelUsageRows;
  }
}

function service(repository: FakeReportingRepository): ReportingService {
  return new ReportingService({ repository, now: () => NOW });
}

function errorRow(id: number, occurredAt: Date): ErrorEventRow {
  return {
    id,
    occurredAt,
    requestId: `req-${id}`,
    component: 'orchestrator',
    category: 'provider_error',
    providerId: null,
    modelId: null,
    generationId: null,
    message: 'upstream failed',
    context: { apiKey: 'sk-live-secret' },
  };
}

function auditRow(id: number, createdAt: Date): AuditLogRow {
  return {
    id,
    actorUserId: null,
    actor: null,
    action: 'user.update',
    targetType: 'user',
    targetId: 'u-1',
    before: { password: 'old' },
    after: { displayName: 'New' },
    requestId: null,
    ip: '203.0.113.7',
    userAgentHash: null,
    createdAt,
  };
}

describe('ReportingService.usage', () => {
  it('defaults to the last 30 days when no range is given', async () => {
    const repository = new FakeReportingRepository();
    await service(repository).usage({ groupBy: 'day' });

    const query = repository.usageQueries[0];
    expect(query?.to).toEqual(NOW);
    expect(query?.from).toEqual(new Date(NOW.getTime() - 30 * 86_400_000));
    expect(query?.groupBy).toBe('day');
  });

  it('forwards a division filter to the repository', async () => {
    const repository = new FakeReportingRepository();
    await service(repository).usage({ groupBy: 'user', divisionId: 'div-1' });

    expect(repository.usageQueries[0]?.divisionId).toBe('div-1');
  });

  it('forwards the division filter into the CSV export', async () => {
    const repository = new FakeReportingRepository();
    await service(repository).usageCsv({ groupBy: 'user', divisionId: 'div-1' });

    expect(repository.usageQueries[0]?.divisionId).toBe('div-1');
  });

  it('renders usage as Indonesian CSV with a stable header', async () => {
    const repository = new FakeReportingRepository();
    repository.usageRows = [
      {
        key: { modelId: 'm-1', displayName: 'Claude, "Sonnet"', provider: 'anthropic' },
        requests: 3,
        failedRequests: 1,
        inputTokens: 100,
        outputTokens: 20,
        quotaTokens: 120,
        estimatedCostUsd: 0.000123,
        usageSource: { provider: 0.5, estimated: 0.5 },
      },
    ];

    const csv = await service(repository).usageCsv({ groupBy: 'model' });
    const [header, row] = csv.split('\r\n');

    expect(header).toBe(
      'Nama Lengkap,ID Model,Provider,Total Permintaan,Permintaan Gagal,Token Input,Token Output,Token Terpakai,Estimasi Biaya (USD),Sumber Penggunaan (Provider),Sumber Penggunaan (Estimasi)',
    );
    expect(row).toContain('"Claude, ""Sonnet"""');
    expect(row).toContain(',3,1,100,20,120,0.000123,0.500000,0.500000');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('renders division usage headers in Indonesian', async () => {
    const repository = new FakeReportingRepository();
    repository.usageRows = [
      {
        key: { divisionId: 'div-1', name: 'Engineering' },
        requests: 3,
        failedRequests: 1,
        inputTokens: 100,
        outputTokens: 20,
        quotaTokens: 120,
        estimatedCostUsd: 0.5,
        usageSource: { provider: 1, estimated: 0 },
      },
    ];

    const csv = await service(repository).usageCsv({ groupBy: 'division' });
    const [header] = csv.split('\r\n');

    expect(header).toBe(
      'ID Departemen,Nama Departemen,Total Permintaan,Permintaan Gagal,Token Input,Token Output,Token Terpakai,Estimasi Biaya (USD),Sumber Penggunaan (Provider),Sumber Penggunaan (Estimasi)',
    );
  });

  it('neutralizes formula injection characters in CSV fields', async () => {
    const repository = new FakeReportingRepository();
    repository.usageRows = [
      {
        key: { modelId: 'm-2', displayName: '=cmd|"/C calc"!A0', provider: '@evil' },
        requests: 1,
        failedRequests: 0,
        inputTokens: 10,
        outputTokens: 10,
        quotaTokens: 20,
        estimatedCostUsd: 0.00001,
        usageSource: { provider: 1, estimated: 0 },
      },
    ];

    const csv = await service(repository).usageCsv({ groupBy: 'model' });
    const [, row] = csv.split('\r\n');
    expect(row).toContain("'=cmd");
    expect(row).toContain("'@evil");
  });
});

describe('ReportingService.dashboard', () => {
  it('uses the UTC day for the summary and department usage', async () => {
    const repository = new FakeReportingRepository();
    await service(repository).dashboard();

    const summary = repository.summaryQueries[0];
    expect(summary?.from).toEqual(new Date('2026-10-20T00:00:00.000Z'));
    expect(summary?.to).toEqual(new Date('2026-10-20T23:59:59.999Z'));

    const divisionQuery = repository.usageQueries[0];
    expect(divisionQuery?.groupBy).toBe('division');
    expect(divisionQuery?.from).toEqual(new Date('2026-10-20T00:00:00.000Z'));
    expect(divisionQuery?.to).toEqual(new Date('2026-10-20T23:59:59.999Z'));
  });

  it('returns the window, summary, recent, breakdown and models in one report', async () => {
    const repository = new FakeReportingRepository();
    repository.recentRows = [
      {
        id: 'u-1',
        model: 'gpt-4o',
        modelName: 'GPT-4o',
        provider: 'openai',
        promptTokens: 10,
        completionTokens: 5,
        cachedTokens: 0,
        status: 'ok',
        timestamp: new Date('2026-10-20T10:00:00.000Z'),
      },
    ];

    const report = await service(repository).dashboard();
    expect(report.window).toEqual({
      from: '2026-10-20T00:00:00.000Z',
      to: '2026-10-20T23:59:59.999Z',
    });
    expect(report.recent[0]?.timestamp).toBe('2026-10-20T10:00:00.000Z');
    expect(report.departmentUsage).toEqual([]);
    expect(report.breakdown).toEqual({ byProvider: [], byModel: [] });
  });
});

describe('ReportingService.usageReport', () => {
  it('resolves the default range to the last 30 days', async () => {
    const repository = new FakeReportingRepository();
    await service(repository).usageReport({});

    const summary = repository.summaryQueries[0];
    expect(summary?.to).toEqual(NOW);
    expect(summary?.from).toEqual(new Date(NOW.getTime() - 30 * 86_400_000));
  });

  it('computes one aggregate for the table section', async () => {
    const repository = new FakeReportingRepository();
    await service(repository).usageReport({
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-31T23:59:59.999Z',
    });

    expect(repository.usageQueries.map((q) => q.groupBy)).toEqual(['division']);
    expect(repository.usageQueries[0]?.from).toEqual(new Date('2026-10-01T00:00:00.000Z'));
    expect(repository.usageQueries[0]?.to).toEqual(new Date('2026-10-31T23:59:59.999Z'));
  });

  it('forwards the division filter into every block', async () => {
    const repository = new FakeReportingRepository();
    await service(repository).usageReport({ divisionId: 'div-1' });

    expect(repository.summaryQueries[0]?.divisionId).toBe('div-1');
    expect(repository.recentQueries[0]?.divisionId).toBe('div-1');
    expect(repository.usageQueries.every((q) => q.divisionId === 'div-1')).toBe(true);
  });

  it('runs only the requested sections', async () => {
    const repository = new FakeReportingRepository();
    const report = await service(repository).usageReport({ sections: ['byUser'] });

    expect(report.byUser).toEqual([]);
    expect(report.summary).toBeUndefined();
    expect(report.recent).toBeUndefined();
    expect(report.breakdown).toBeUndefined();
    expect(report.timeseries).toBeUndefined();
    expect(report.models).toBeUndefined();
    expect(report.byDivision).toBeUndefined();
    expect(repository.summaryQueries).toHaveLength(0);
    expect(repository.recentQueries).toHaveLength(0);
    expect(repository.usageQueries.map((q) => q.groupBy)).toEqual(['user']);
  });

  it('runs every section when none are requested', async () => {
    const repository = new FakeReportingRepository();
    await service(repository).usageReport({});

    expect(repository.summaryQueries).toHaveLength(1);
    expect(repository.recentQueries).toHaveLength(1);
    expect(repository.usageQueries.map((q) => q.groupBy)).toEqual(['division']);
  });

  it('pages the table section and reports the pagination envelope', async () => {
    const repository = new FakeReportingRepository();
    repository.usageRows = Array.from({ length: 25 }, (_, index) => ({
      key: { divisionId: `div-${index}`, name: `Division ${index}` },
      requests: 1,
      failedRequests: 0,
      inputTokens: 10,
      outputTokens: 5,
      quotaTokens: 15,
      estimatedCostUsd: null,
      usageSource: { provider: 1, estimated: 0 },
    }));

    const report = await service(repository).usageReport({ sections: ['byDivision'], page: 2, limit: 10 });

    expect(report.pagination).toEqual({ page: 2, limit: 10, totalItems: 25, totalPages: 3 });
    expect(report.items).toHaveLength(10);
    expect(report.items?.[0]?.key['divisionId']).toBe('div-10');
    expect(report.byDivision).toEqual(report.items);
  });

  it('filters the table section by search over the grouping labels', async () => {
    const repository = new FakeReportingRepository();
    repository.usageRows = [
      {
        key: { divisionId: 'div-eng', name: 'Engineering' },
        requests: 1,
        failedRequests: 0,
        inputTokens: 10,
        outputTokens: 5,
        quotaTokens: 15,
        estimatedCostUsd: null,
        usageSource: { provider: 1, estimated: 0 },
      },
      {
        key: { divisionId: 'div-legal', name: 'Legal' },
        requests: 1,
        failedRequests: 0,
        inputTokens: 10,
        outputTokens: 5,
        quotaTokens: 15,
        estimatedCostUsd: null,
        usageSource: { provider: 1, estimated: 0 },
      },
    ];

    const report = await service(repository).usageReport({ sections: ['byDivision'], search: 'eng' });

    expect(report.pagination?.totalItems).toBe(1);
    expect(report.items?.map((row) => row.key['name'])).toEqual(['Engineering']);
  });

  it('maps timeseries rows to display labels', async () => {
    const repository = new FakeReportingRepository();
    repository.timeseriesRows = [
      { date: '2026-10-18', tokens: 100, requests: 2, costUsd: 0.5 },
    ];

    const report = await service(repository).usageReport({});
    expect(report.timeseries?.[0]).toMatchObject({
      date: '2026-10-18',
      tokens: 100,
      requests: 2,
      costUsd: 0.5,
    });
    expect(report.timeseries?.[0]?.label).toBeTruthy();
  });
});

describe('ReportingService.error explorer', () => {
  it('returns a full page with no cursor when fewer rows than the limit', async () => {
    const repository = new FakeReportingRepository();
    repository.errorRows = [errorRow(2, new Date('2026-10-19T00:00:00Z'))];

    const page = await service(repository).errors({ limit: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect(repository.errorQueries[0]?.limit).toBe(51);
  });

  it('emits a cursor that resumes strictly after the last row', async () => {
    const repository = new FakeReportingRepository();
    const newest = new Date('2026-10-19T10:00:00Z');
    const older = new Date('2026-10-19T09:00:00Z');
    repository.errorRows = [errorRow(9, newest), errorRow(8, older)];

    const page = await service(repository).errors({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();

    repository.errorRows = [errorRow(8, older)];
    const next = await service(repository).errors({ limit: 1, cursor: page.nextCursor ?? '' });
    expect(next.items[0]?.id).toBe('8');

    const resume = repository.errorQueries.at(-1)?.after;
    expect(resume?.id).toBe(9);
    expect(resume?.occurredAt).toEqual(newest);
  });

  it('rejects a malformed cursor as invalid_request', async () => {
    const repository = new FakeReportingRepository();
    await expect(service(repository).errors({ limit: 10, cursor: 'not-a-cursor' })).rejects.toThrow(
      AppError,
    );
  });
});

describe('ReportingService.audit search', () => {
  it('redacts secrets in before/after before returning them', async () => {
    const repository = new FakeReportingRepository();
    repository.auditRows = [auditRow(4, new Date('2026-10-19T00:00:00Z'))];

    const page = await service(repository).auditLogs({ limit: 10 });
    expect(page.items[0]?.before).toEqual({ password: '[redacted]' });
    expect(page.items[0]?.after).toEqual({ displayName: 'New' });
    expect(page.items[0]?.ip).toBe('203.0.113.7');
  });

  it('redacts secrets inside the error context', async () => {
    const repository = new FakeReportingRepository();
    repository.errorRows = [errorRow(1, new Date('2026-10-19T00:00:00Z'))];

    const page = await service(repository).errors({ limit: 10 });
    expect(page.items[0]?.context).toEqual({ apiKey: '[redacted]' });
  });
});