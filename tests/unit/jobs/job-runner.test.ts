import { describe, expect, it } from 'vitest';
import { JobRunner } from '@/jobs/application/job-runner.ts';
import type { Job, JobQueue, EnqueueJobInput } from '@/jobs/ports/job-queue.ts';

class FakeJobQueue implements JobQueue {
  jobs: Job[] = [];
  completed: string[] = [];
  failed: Array<{ id: string; error: string }> = [];

  async enqueue<T = Record<string, unknown>>(input: EnqueueJobInput<T>): Promise<string> {
    const id = input.id ?? `job-${this.jobs.length + 1}`;
    this.jobs.push({
      id,
      type: input.type,
      payload: input.payload as Record<string, unknown>,
      status: 'queued',
      runAt: input.runAt ?? new Date(),
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 5,
      createdAt: new Date(),
    });
    return id;
  }

  async claim(_lockedBy: string, limit = 5): Promise<Job[]> {
    const due = this.jobs.filter((j) => j.status === 'queued').slice(0, limit);
    for (const j of due) {
      (j as { status: string }).status = 'running';
    }
    return due;
  }

  async complete(id: string): Promise<void> {
    this.completed.push(id);
    const j = this.jobs.find((job) => job.id === id);
    if (j) (j as { status: string }).status = 'done';
  }

  async fail(id: string, error: string): Promise<void> {
    this.failed.push({ id, error });
    const j = this.jobs.find((job) => job.id === id);
    if (j) (j as { status: string }).status = 'failed';
  }
}

describe('JobRunner (Unit)', () => {
  it('claims jobs, routes to handler, and marks complete', async () => {
    const queue = new FakeJobQueue();
    const runner = new JobRunner(queue, 'runner-1');

    let processedPayload: { msg: string } | null = null;
    runner.registerHandler('greet', async (payload: { msg: string }) => {
      processedPayload = payload;
    });

    await queue.enqueue({ type: 'greet', payload: { msg: 'hello' } });

    const processed = await runner.pollOnce();
    expect(processed).toBe(1);
    expect(processedPayload).toEqual({ msg: 'hello' });
    expect(queue.completed).toEqual(['job-1']);
    expect(queue.failed).toHaveLength(0);
  });

  it('marks job failed when handler throws', async () => {
    const queue = new FakeJobQueue();
    const runner = new JobRunner(queue, 'runner-1');

    runner.registerHandler('fail.me', async () => {
      throw new Error('Explosion');
    });

    await queue.enqueue({ type: 'fail.me', payload: {} });

    const processed = await runner.pollOnce();
    expect(processed).toBe(1);
    expect(queue.completed).toHaveLength(0);
    expect(queue.failed).toEqual([{ id: 'job-1', error: 'Explosion' }]);
  });

  it('marks job failed when no handler is registered', async () => {
    const queue = new FakeJobQueue();
    const runner = new JobRunner(queue, 'runner-1');

    await queue.enqueue({ type: 'unknown.type', payload: {} });

    const processed = await runner.pollOnce();
    expect(processed).toBe(1);
    expect(queue.failed[0]?.error).toContain('No handler registered for job type: unknown.type');
  });
});
