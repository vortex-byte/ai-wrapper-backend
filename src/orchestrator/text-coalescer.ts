export interface TextCoalescerOptions {
  readonly flushIntervalMs?: number;
  readonly maxBufferedChars?: number;
  readonly onFlush: (partId: string, delta: string) => void;
}

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

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.accumulated = '';
    this.currentPartId = null;
  }
}
