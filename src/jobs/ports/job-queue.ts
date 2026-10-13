import type { TransactionContext } from '@/db/tx.ts';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'dead';

export interface Job<T = Record<string, unknown>> {
  readonly id: string;
  readonly type: string;
  readonly payload: T;
  readonly status: JobStatus;
  readonly runAt: Date;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lockedBy?: string | null | undefined;
  readonly lockedAt?: Date | null | undefined;
  readonly lastError?: string | null | undefined;
  readonly dedupeKey?: string | null | undefined;
  readonly createdAt: Date;
  readonly finishedAt?: Date | null | undefined;
}

export interface EnqueueJobInput<T = Record<string, unknown>> {
  readonly id?: string | undefined;
  readonly type: string;
  readonly payload: T;
  readonly runAt?: Date | undefined;
  readonly maxAttempts?: number | undefined;
  readonly dedupeKey?: string | undefined;
}

export interface JobQueue {
  enqueue<T = Record<string, unknown>>(input: EnqueueJobInput<T>, tx?: TransactionContext): Promise<string>;
  claim(lockedBy: string, limit?: number, tx?: TransactionContext): Promise<Job[]>;
  complete(id: string, tx?: TransactionContext): Promise<void>;
  fail(id: string, error: string, tx?: TransactionContext): Promise<void>;
}
