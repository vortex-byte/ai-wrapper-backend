import type { UsageRepository } from '../ports/usage-repository.ts';

/**
 * Usage reporting service.
 */

export interface UsageServiceDeps {
  readonly usage: UsageRepository;
}

function defaultRange(): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
  return { from, to };
}

export class UsageService {
  private readonly usage: UsageRepository;

  constructor(deps: UsageServiceDeps) {
    this.usage = deps.usage;
  }

  /** `GET /me/usage` — the user's own aggregates, last 30 days by default. */
  async userUsage(input: {
    readonly userId: string;
    readonly from?: string | undefined;
    readonly to?: string | undefined;
    readonly groupBy: 'day' | 'model';
  }): Promise<
    readonly {
      readonly day: string | null;
      readonly modelId: string | null;
      readonly requests: number;
      readonly failedRequests: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly quotaTokens: number;
      readonly estimatedCostUsd: number | null;
    }[]
  > {
    const fallback = defaultRange();
    const from = input.from !== undefined ? parseDate(input.from, fallback.from) : fallback.from;
    const to = input.to !== undefined ? parseDate(input.to, fallback.to) : fallback.to;
    const rows = await this.usage.aggregateForUser({
      userId: input.userId,
      from,
      to,
      groupBy: input.groupBy,
    });
    return rows.map((row) => ({
      day: row.day,
      modelId: row.modelId,
      requests: row.requests,
      failedRequests: row.failedRequests,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      quotaTokens: row.quotaTokens,
      estimatedCostUsd: row.estCostMicros === null ? null : row.estCostMicros / 1_000_000,
    }));
  }

  /** `GET /admin/usage` — system-wide aggregates. */
  async adminUsage(input: {
    readonly from?: string | undefined;
    readonly to?: string | undefined;
    readonly groupBy: 'user' | 'model' | 'provider' | 'day' | 'month' | 'division';
  }): Promise<
    readonly {
      readonly key: Record<string, string | null>;
      readonly requests: number;
      readonly failedRequests: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly quotaTokens: number;
      readonly estimatedCostUsd: number | null;
    }[]
  > {
    const fallback = defaultRange();
    const from = input.from !== undefined ? parseDate(input.from, fallback.from) : fallback.from;
    const to = input.to !== undefined ? parseDate(input.to, fallback.to) : fallback.to;
    const rows = await this.usage.aggregateAdmin({ from, to, groupBy: input.groupBy });
    return rows.map((row) => ({
      key: row.key,
      requests: row.requests,
      failedRequests: row.failedRequests,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      quotaTokens: row.quotaTokens,
      estimatedCostUsd: row.estCostMicros === null ? null : row.estCostMicros / 1_000_000,
    }));
  }
}

function parseDate(raw: string, fallback: Date): Date {
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}
