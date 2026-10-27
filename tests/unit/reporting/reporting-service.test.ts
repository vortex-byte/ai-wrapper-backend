import { describe, expect, it } from 'vitest';
import { AppError } from '@/errors.ts';
import { ReportingService } from '@/reporting/application/reporting-service.ts';
import type {
  AuditLogQuery,
  AuditLogRow,
  ErrorEventQuery,
  ErrorEventRow,
  ReportingRepository,
  UsageReportQuery,
  UsageReportRow,
} from '@/reporting/ports/reporting-repository.ts';

const NOW = new Date('2026-10-20T12:00:00.000Z');

class FakeReportingRepository implements ReportingRepository {
  usageQueries: UsageReportQuery[] = [];
  errorQueries: ErrorEventQuery[] = [];
  auditQueries: AuditLogQuery[] = [];

  errorRows: ErrorEventRow[] = [];
  auditRows: AuditLogRow[] = [];
  usageRows: UsageReportRow[] = [];

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

  it('renders usage as standard CSV with a stable header', async () => {
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
      'displayName,modelId,provider,requests,failedRequests,inputTokens,outputTokens,quotaTokens,estimatedCostUsd,usageSourceProvider,usageSourceEstimated',
    );
    expect(row).toContain('"Claude, ""Sonnet"""');
    expect(row).toContain(',3,1,100,20,120,0.000123,0.500000,0.500000');
    expect(csv.endsWith('\r\n')).toBe(true);
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