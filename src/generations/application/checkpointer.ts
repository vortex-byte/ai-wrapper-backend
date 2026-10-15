import type { Clock } from '@/clock/index.ts';
import type { GenerationRepository } from '../ports/generation-repository.ts';

export interface CheckpointerOptions {
  readonly generationId: string;
  readonly generationRepo: GenerationRepository;
  readonly clock: Clock;
  /** Flush interval in milliseconds (default: 1,000 ms = 1 s). */
  readonly intervalMs?: number | undefined;
  /** Maximum buffered bytes before an immediate flush (default: 2,048 = 2 KB). */
  readonly maxBufferBytes?: number | undefined;
}

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_MAX_BUFFER_BYTES = 2048;

/**
 * Checkpointer for live generation streaming.
 * Buffers text deltas and periodically flushes them to `message_parts` in short transactions
 * while updating heartbeat and sequence markers.
 * Streams hold no database connection between flushes.
 */
export class Checkpointer {
  private readonly generationId: string;
  private readonly generationRepo: GenerationRepository;
  private readonly clock: Clock;
  private readonly intervalMs: number;
  private readonly maxBufferBytes: number;

  private readonly partBuffers = new Map<string, string>();
  private bufferedBytes = 0;
  private lastEventSeq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private disposed = false;

  constructor(options: CheckpointerOptions) {
    this.generationId = options.generationId;
    this.generationRepo = options.generationRepo;
    this.clock = options.clock;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

    this.timer = setInterval(() => {
      void this.flush();
    }, this.intervalMs);
  }

  /**
   * Appends text from a stream delta.
   * If buffered bytes reach the threshold (2 KB), an immediate flush is triggered.
   */
  append(partId: string, text: string, eventSeq: number): void {
    if (this.disposed || text.length === 0) return;

    const existing = this.partBuffers.get(partId) ?? '';
    this.partBuffers.set(partId, existing + text);
    this.bufferedBytes += Buffer.byteLength(text, 'utf-8');
    this.lastEventSeq = Math.max(this.lastEventSeq, eventSeq);

    if (this.bufferedBytes >= this.maxBufferBytes) {
      void this.flush();
    }
  }

  /**
   * Flushes buffered text to the database and touches heartbeat_at.
   * Concurrent callers coalesce onto the single in-flight flush, so a caller that needs a
   * *guaranteed* post-condition (see {@link dispose}) must await the returned promise.
   */
  flush(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    if (this.partBuffers.size === 0) return Promise.resolve();

    const snapshot = new Map(this.partBuffers);
    this.partBuffers.clear();
    this.bufferedBytes = 0;
    const eventSeq = this.lastEventSeq;

    const run = async (): Promise<void> => {
      for (const [partId, chunk] of snapshot.entries()) {
        try {
          await this.generationRepo.checkpointText({
            generationId: this.generationId,
            partId,
            chunk,
            lastEventSeq: eventSeq,
            heartbeatAt: this.clock.now(),
          });
        } catch {
          const current = this.partBuffers.get(partId) ?? '';
          this.partBuffers.set(partId, chunk + current);
          this.bufferedBytes += Buffer.byteLength(chunk, 'utf-8');
        }
      }
    };

    const promise = run().finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });
    this.inFlight = promise;
    return promise;
  }

  /**
   * Disposes the checkpointer timer and performs a final, *complete* flush.
   *
   * Waits for any in-flight flush to settle and then drains whatever accumulated meanwhile, so no
   * delta is dropped and no late write can land after the finalizer has persisted the final text
   * (which would duplicate the tail).
   */
  async dispose(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.disposed = true;

    let guard = 0;
    while ((this.partBuffers.size > 0 || this.inFlight !== null) && guard < 100) {
      guard++;
      const pending = this.inFlight;
      if (pending !== null) {
        await pending;
        continue;
      }
      await this.flush();
    }
  }
}
