import type { TransactionContext } from '@/db/tx.ts';

export interface Division {
  readonly id: string;
  readonly name: string;
  readonly externalRef: string | null;
  readonly createdAt: Date;
}

/** Inclusive UTC day window, `YYYY-MM-DD`, matching the `usage_daily` buckets. */
export interface DivisionStatsRange {
  readonly from: string;
  readonly to: string;
}

export interface DivisionUsageStats {
  readonly memberCount: number;
  readonly tokens: number;
  readonly requests: number;
  readonly costUsd: number | null;
  readonly monthlyTokens: number | null;
}

export type DivisionWithStats = Division & DivisionUsageStats;

export interface DivisionReferenceCounts {
  readonly users: number;
  readonly quotaPolicies: number;
  readonly usageEvents: number;
  readonly usageDaily: number;
}

export interface CreateDivisionInput {
  readonly id: string;
  readonly name: string;
  readonly externalRef?: string | null | undefined;
}

export interface UpdateDivisionInput {
  readonly id: string;
  readonly name?: string | undefined;
  readonly externalRef?: string | null | undefined;
}

export interface DivisionRepository {
  findById(id: string, tx?: TransactionContext): Promise<Division | null>;
  findByName(name: string, tx?: TransactionContext): Promise<Division | null>;
  findByExternalRef(externalRef: string, tx?: TransactionContext): Promise<Division | null>;
  findMany(tx?: TransactionContext): Promise<Division[]>;
  findManyWithStats(
    range: DivisionStatsRange,
    tx?: TransactionContext,
  ): Promise<DivisionWithStats[]>;
  findWithStats(
    id: string,
    range: DivisionStatsRange,
    tx?: TransactionContext,
  ): Promise<DivisionWithStats | null>;
  create(input: CreateDivisionInput, tx?: TransactionContext): Promise<Division>;
  update(input: UpdateDivisionInput, tx?: TransactionContext): Promise<Division>;
  countReferences(id: string, tx?: TransactionContext): Promise<DivisionReferenceCounts>;
  delete(id: string, tx?: TransactionContext): Promise<boolean>;
}
