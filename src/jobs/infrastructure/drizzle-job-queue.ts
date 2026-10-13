import { eq, sql } from 'drizzle-orm';
import { getPool } from '@/db/pool.ts';
import { jobs } from '@/db/schema.ts';
import { runDb } from '@/db/client.ts';
import type { TransactionContext } from '@/db/tx.ts';
import type { Clock } from '@/clock/index.ts';
import type { IdGenerator } from '@/clock/index.ts';
import type { EnqueueJobInput, Job, JobQueue, JobStatus } from '../ports/job-queue.ts';

interface JobRow {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly status: string;
  readonly run_at: Date;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly locked_by: string | null;
  readonly locked_at: Date | null;
  readonly last_error: string | null;
  readonly dedupe_key: string | null;
  readonly created_at: Date;
  readonly finished_at: Date | null;
}

function toJob<T = Record<string, unknown>>(row: JobRow): Job<T> {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload as T,
    status: row.status as JobStatus,
    runAt: row.run_at,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    lastError: row.last_error,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export class DrizzleJobQueue implements JobQueue {
  private readonly clock: Clock;
  private readonly idGen: IdGenerator;

  constructor(clock: Clock, idGen: IdGenerator) {
    this.clock = clock;
    this.idGen = idGen;
  }

  async enqueue<T = Record<string, unknown>>(
    input: EnqueueJobInput<T>,
    tx?: TransactionContext,
  ): Promise<string> {
    const id = input.id ?? this.idGen.uuidv7();
    const runAt = input.runAt !== undefined ? input.runAt : sql`now()`;
    const maxAttempts = input.maxAttempts ?? 5;

    const values = {
      id,
      type: input.type,
      payload: input.payload as Record<string, unknown>,
      status: 'queued',
      runAt,
      maxAttempts,
      dedupeKey: input.dedupeKey ?? null,
      createdAt: sql`now()`,
    };

    if (input.dedupeKey !== undefined) {
      const rows = await runDb(tx)
        .insert(jobs)
        .values(values)
        .onConflictDoNothing({ target: jobs.dedupeKey })
        .returning({ id: jobs.id });

      if (rows[0]?.id !== undefined) {
        return rows[0].id;
      }

      const existing = await runDb(tx)
        .select({ id: jobs.id })
        .from(jobs)
        .where(eq(jobs.dedupeKey, input.dedupeKey))
        .limit(1);

      return existing[0]?.id ?? id;
    }

    const rows = await runDb(tx).insert(jobs).values(values).returning({ id: jobs.id });
    const insertedId = rows[0]?.id;
    if (insertedId === undefined) {
      throw new Error('Failed to insert job');
    }
    return insertedId;
  }

  async claim(lockedBy: string, limit = 5, tx?: TransactionContext): Promise<Job[]> {
    const client = tx?.client ?? getPool();

    const query = `
      WITH due_jobs AS (
        SELECT id
        FROM jobs
        WHERE status = 'queued' AND run_at <= (now() + interval '100 milliseconds')
        ORDER BY run_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE jobs
      SET status = 'running',
          locked_by = $2,
          locked_at = now(),
          attempts = attempts + 1
      WHERE id IN (SELECT id FROM due_jobs)
      RETURNING id, type, payload, status, run_at, attempts, max_attempts,
                locked_by, locked_at, last_error, dedupe_key, created_at, finished_at;
    `;

    const result = await client.query(query, [limit, lockedBy]);
    return (result.rows as JobRow[]).map((row) => toJob(row));
  }

  async complete(id: string, tx?: TransactionContext): Promise<void> {
    await runDb(tx)
      .update(jobs)
      .set({
        status: 'done',
        finishedAt: this.clock.now(),
        lockedBy: null,
        lockedAt: null,
      })
      .where(eq(jobs.id, id));
  }

  async fail(id: string, error: string, tx?: TransactionContext): Promise<void> {
    const now = this.clock.now();

    const rows = await runDb(tx)
      .select({
        attempts: jobs.attempts,
        maxAttempts: jobs.maxAttempts,
      })
      .from(jobs)
      .where(eq(jobs.id, id))
      .limit(1);

    const job = rows[0];
    if (!job) return;

    if (job.attempts >= job.maxAttempts) {
      await runDb(tx)
        .update(jobs)
        .set({
          status: 'dead',
          lastError: error,
          finishedAt: now,
          lockedBy: null,
          lockedAt: null,
        })
        .where(eq(jobs.id, id));
    } else {
      // Exponential backoff with full jitter, capped (AWS-recommended): `base * 2^(attempts-1)`
      // bounded at 5 minutes. Plain linear/multiplied delays synchronize retries of jobs that
      // failed together and hammer a recovering dependency, so spread them out.
      const BASE_MS = 5_000;
      const CAP_MS = 300_000;
      const exponential = Math.min(BASE_MS * 2 ** (job.attempts - 1), CAP_MS);
      const delayMs = Math.floor(Math.random() * exponential);
      const retryAt = new Date(now.getTime() + delayMs);

      await runDb(tx)
        .update(jobs)
        .set({
          status: 'queued',
          lastError: error,
          runAt: retryAt,
          lockedBy: null,
          lockedAt: null,
        })
        .where(eq(jobs.id, id));
    }
  }
}
