export interface TextCoalescerOptions {
  /** Maximum delay between flushes in milliseconds (default: 50 ms = max 20 flushes/sec). */
  readonly flushIntervalMs?: number;
  /** Maximum buffered characters before an immediate flush (default: 2048 chars). */
  readonly maxBufferedChars?: number;
  /** Callback invoked when a coalesced chunk is flushed. */
  readonly onFlush: (partId: string, delta: string) => void;
}

/**
 * Coalesces streaming text deltas to avoid saturating clients with micro-frames.
 * Flushes periodically or immediately when buffer fills or `flush()` is called.
 */
export class TextCoalescer {
  private readonly flushIntervalMs: number;
  private readonly maxBufferedChars: number;
  private readonly onFlush: (partId: string, delta: string) => void;

  private currentPartId: string | null = null;
  private accumulated = '';
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: TextCoalescerOptions) {
    this.flushIntervalMs = options.flushIntervalMs ?? 50;
    this.maxBufferedChars = options.maxBufferedChars ?? 2048;
    this.onFlush = options.onFlush;
  }

  /**
   * Append a text chunk for a part. If the part ID changes, existing text is flushed immediately.
   */
  append(partId: string, text: string): void {
    if (text.length === 0) return;

    if (this.currentPartId !== null && this.currentPartId !== partId) {
      this.flush();
    }

    this.currentPartId = partId;
    this.accumulated += text;

    if (this.accumulated.length >= this.maxBufferedChars) {
      this.flush();
      return;
    }

    if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flush();
      }, this.flushIntervalMs);
    }
  }

  /**
   * Flush any buffered text immediately.
   */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.currentPartId !== null && this.accumulated.length > 0) {
      const partId = this.currentPartId;
      const text = this.accumulated;
      this.accumulated = '';
      this.onFlush(partId, text);
    }
  }

  /**
   * Clean up any pending timer and reset buffer.
   */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.accumulated = '';
    this.currentPartId = null;
  }
}
