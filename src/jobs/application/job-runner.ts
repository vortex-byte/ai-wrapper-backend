import type { Job, JobQueue } from '../ports/job-queue.ts';
import { getLogger } from '@/observability/logger.ts';

export type JobHandler<T = Record<string, unknown>> = (payload: T, job: Job<T>) => Promise<unknown>;

export class JobRunner {
  private readonly queue: JobQueue;
  private readonly runnerId: string;
  private readonly handlers = new Map<string, JobHandler<never>>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  private isProcessing = false;
  private isStopping = false;
  private pollIntervalMs = 1000;
  private pollIntervalIdleMs = 5000;

  constructor(queue: JobQueue, runnerId: string) {
    this.queue = queue;
    this.runnerId = runnerId;
  }

  registerHandler<T = Record<string, unknown>>(type: string, handler: JobHandler<T>): void {
    this.handlers.set(type, handler as JobHandler<never>);
  }

  async pollOnce(limit = 5): Promise<number> {
    if (this.isStopping) return 0;

    let claimedJobs: Job[];
    try {
      claimedJobs = await this.queue.claim(this.runnerId, limit);
    } catch (err) {
      getLogger().error({ err }, 'failed to claim jobs from queue');
      return 0;
    }

    if (claimedJobs.length === 0) return 0;

    for (const job of claimedJobs) {
      const handler = this.handlers.get(job.type);
      if (!handler) {
        getLogger().warn({ jobId: job.id, type: job.type }, 'no handler registered for job type');
        await this.queue.fail(job.id, `No handler registered for job type: ${job.type}`);
        continue;
      }

      try {
        await handler(job.payload as never, job as never);
        await this.queue.complete(job.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        getLogger().error({ err, jobId: job.id, type: job.type }, 'job execution failed');
        await this.queue.fail(job.id, message);
      }
    }

    return claimedJobs.length;
  }

  start(pollIntervalMs = 1000, pollIntervalIdleMs = 5000): void {
    if (this.timer !== null) return;
    this.pollIntervalMs = pollIntervalMs;
    this.pollIntervalIdleMs = pollIntervalIdleMs;
    this.isStopping = false;
    this.scheduleNext(this.pollIntervalMs);
  }

  private scheduleNext(delayMs: number): void {
    if (this.isStopping) return;
    this.timer = setTimeout(async () => {
      if (this.isProcessing || this.isStopping) return;
      this.isProcessing = true;
      let nextDelay = this.pollIntervalMs;
      try {
        const count = await this.pollOnce();
        nextDelay = count > 0 ? this.pollIntervalMs : this.pollIntervalIdleMs;
      } catch (err) {
        getLogger().error({ err }, 'job poll cycle failed');
      } finally {
        this.isProcessing = false;
        if (!this.isStopping) {
          this.scheduleNext(nextDelay);
        }
      }
    }, delayMs);
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    while (this.isProcessing) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
