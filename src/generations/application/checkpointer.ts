import type { Clock } from '@/clock/index.ts';
import type { GenerationRepository } from '../ports/generation-repository.ts';

export interface CheckpointerOptions {
  readonly generationId: string;
  readonly generationRepo: GenerationRepository;
  readonly clock: Clock;
  readonly intervalMs?: number | undefined;
  readonly maxBufferBytes?: number | undefined;
}

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_MAX_BUFFER_BYTES = 2048;

/** Buffers streaming text deltas and periodically flushes them with heartbeat updates. */
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

  /** Flushes buffered text chunks and updates heartbeat timestamp. */
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

  /** Disposes interval timer and awaits a final complete buffer flush. */
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
