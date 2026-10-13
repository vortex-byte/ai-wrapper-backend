import type { SSEEventType, SSEFrame } from './events.ts';

export interface RingBufferOptions {
  /** Maximum number of events to retain (default: 2000). */
  readonly maxEvents?: number;
  /** Maximum total byte size of retained payloads (default: 1 MB = 1,048,576 bytes). */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_EVENTS = 2000;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Ring buffer retaining SSE events for replay on reconnect.
 * Assigns monotonic sequence IDs. When capacity (event count or byte size) is reached,
 * the oldest frames roll off.
 */
export class RingBuffer {
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly frames: SSEFrame[] = [];
  private totalBytes = 0;
  private nextSeq = 1;

  constructor(options: RingBufferOptions = {}) {
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  /**
   * Pushes a new event into the buffer, assigning the next monotonic seq.
   * Drops oldest frames if event count or byte size limits are exceeded.
   */
  push(event: SSEEventType, payload: unknown): SSEFrame {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const id = this.nextSeq++;
    // SSE formatted length: "id: <id>\nevent: <event>\ndata: <data>\n\n"
    const frameContent = `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;
    const byteLength = Buffer.byteLength(frameContent, 'utf-8');

    const frame: SSEFrame = {
      id,
      event,
      data,
      byteLength,
    };

    this.frames.push(frame);
    this.totalBytes += byteLength;

    this.evictOverflow();

    return frame;
  }

  /**
   * Checks whether the buffer can cleanly replay events starting strictly after `lastEventSeq`.
   * Returns false if the requested sequence has already rolled off (gap in history).
   */
  canReplay(lastEventSeq: number): boolean {
    if (this.frames.length === 0) {
      return lastEventSeq >= this.nextSeq - 1;
    }
    const oldest = this.frames[0];
    if (oldest === undefined) return true;
    return lastEventSeq >= oldest.id - 1;
  }

  /**
   * Returns all frames whose seq is strictly greater than `lastEventSeq`.
   */
  replayFrom(lastEventSeq: number): readonly SSEFrame[] {
    if (lastEventSeq <= 0) {
      return [...this.frames];
    }
    return this.frames.filter((f) => f.id > lastEventSeq);
  }

  get size(): number {
    return this.frames.length;
  }

  get byteLength(): number {
    return this.totalBytes;
  }

  get firstSeq(): number | null {
    return this.frames[0]?.id ?? null;
  }

  get lastSeq(): number | null {
    return this.frames[this.frames.length - 1]?.id ?? null;
  }

  getAll(): readonly SSEFrame[] {
    return [...this.frames];
  }

  private evictOverflow(): void {
    while (
      this.frames.length > 0 &&
      (this.frames.length > this.maxEvents || this.totalBytes > this.maxBytes)
    ) {
      const removed = this.frames.shift();
      if (removed !== undefined) {
        this.totalBytes -= removed.byteLength;
      }
    }
  }
}
