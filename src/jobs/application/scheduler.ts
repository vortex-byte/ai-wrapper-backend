import { withTransaction } from '@/db/tx.ts';
import type { TransactionContext } from '@/db/tx.ts';
import type { JobQueue } from '../ports/job-queue.ts';
import { getLogger } from '@/observability/logger.ts';

export interface SchedulerTask {
  readonly name: string;
  readonly jobType: string;
  readonly intervalMs: number;
}

const DEFAULT_TASKS: readonly SchedulerTask[] = [
  { name: 'reaper', jobType: 'generation.reaper', intervalMs: 30_000 },
  { name: 'idempotency-purge', jobType: 'idempotency.purge', intervalMs: 3_600_000 },
  { name: 'sessions-purge', jobType: 'sessions.purge', intervalMs: 3_600_000 },
  { name: 'quota-reaper', jobType: 'quota.reservations.reaper', intervalMs: 60_000 },
  { name: 'usage-rollup-incremental', jobType: 'usage.rollup.incremental', intervalMs: 300_000 },
  { name: 'usage-rollup-nightly', jobType: 'usage.rollup.nightly', intervalMs: 86_400_000 },
  { name: 'quota-reconcile', jobType: 'quota.reconcile', intervalMs: 86_400_000 },
  { name: 'quota-precreate-periods', jobType: 'quota.precreate_periods', intervalMs: 86_400_000 },
];

export class Scheduler {
  private readonly queue: JobQueue;
  private readonly tasks: readonly SchedulerTask[];
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private isRunning = false;

  constructor(queue: JobQueue, tasks: readonly SchedulerTask[] = DEFAULT_TASKS) {
    this.queue = queue;
    this.tasks = tasks;
  }

  async scheduleTask(task: SchedulerTask): Promise<boolean> {
    const lockKey = `scheduler:${task.name}`;

    try {
      // Transaction-scoped advisory lock: exactly one node schedules each recurring job per interval.
      return await withTransaction(async (tx: TransactionContext) => {
        const lockRes = await tx.client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_xact_lock(hashtext($1)) as acquired',
          [lockKey],
        );

        if (!lockRes.rows[0]?.acquired) {
          return false;
        }

        // Dedupe per interval slot: even if two nodes race the lock, the unique dedupe_key makes
        // the enqueue idempotent.
        const slot = Math.floor(Date.now() / task.intervalMs);
        const dedupeKey = `${task.jobType}:${slot}`;

        await this.queue.enqueue({ type: task.jobType, payload: {}, dedupeKey }, tx);
        return true;
      });
    } catch (err) {
      getLogger().error({ err, task: task.name }, 'error scheduling recurring task');
      return false;
    }
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    for (const task of this.tasks) {
      setTimeout(() => {
        if (this.isRunning) void this.scheduleTask(task);
      }, 1000);

      const timer = setInterval(() => {
        if (this.isRunning) void this.scheduleTask(task);
      }, task.intervalMs);

      this.timers.push(timer);
    }
  }

  stop(): void {
    this.isRunning = false;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }
}
