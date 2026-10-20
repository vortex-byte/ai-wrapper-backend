import type { SSEFrame } from './events.ts';

export interface SubscriberOptions {
  readonly maxQueueBytes?: number | undefined;
  readonly onKick?: ((subscriberId: string, reason: string) => void) | undefined;
  readonly onDisconnect?: ((subscriberId: string) => void) | undefined;
}

const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024;

/**
 * One connected SSE stream, exposed as an `AsyncIterable`. Kicks the subscriber when backpressure
 * exceeds `maxQueueBytes` so a slow client cannot grow node memory.
 */
export class Subscriber implements AsyncIterable<SSEFrame> {
  readonly id: string;
  private readonly maxQueueBytes: number;
  private readonly onKick?: ((subscriberId: string, reason: string) => void) | undefined;
  private readonly onDisconnect?: ((subscriberId: string) => void) | undefined;

  private readonly queue: SSEFrame[] = [];
  private queuedBytes = 0;
  private waiter: ((result: IteratorResult<SSEFrame>) => void) | null = null;
  private closed = false;

  constructor(id: string, options: SubscriberOptions = {}) {
    this.id = id;
    this.maxQueueBytes = options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    this.onKick = options.onKick;
    this.onDisconnect = options.onDisconnect;
  }

  push(frame: SSEFrame): boolean {
    if (this.closed) return false;

    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: frame, done: false });
      return true;
    }

    if (this.queuedBytes + frame.byteLength > this.maxQueueBytes) {
      this.kick('backpressure_exceeded');
      return false;
    }

    this.queue.push(frame);
    this.queuedBytes += frame.byteLength;
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined, done: true });
    }

    this.onDisconnect?.(this.id);
  }

  kick(reason: string): void {
    if (this.closed) return;
    this.onKick?.(this.id, reason);
    this.close();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get bufferBytes(): number {
    return this.queuedBytes;
  }

  [Symbol.asyncIterator](): AsyncIterator<SSEFrame> {
    return {
      next: (): Promise<IteratorResult<SSEFrame>> => {
        if (this.queue.length > 0) {
          const frame = this.queue.shift();
          if (frame !== undefined) {
            this.queuedBytes -= frame.byteLength;
            return Promise.resolve({ value: frame, done: false });
          }
        }

        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }

        return new Promise<IteratorResult<SSEFrame>>((resolve) => {
          this.waiter = resolve;
        });
      },
      return: (): Promise<IteratorResult<SSEFrame>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
