import type { Clock, IdGenerator } from '@/clock/index.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationEvent, TokenUsage } from '@/providers/domain/pal.ts';
import type { ProviderAdapter } from '@/providers/ports/provider-adapter.ts';
import type { GenerationRecord } from '@/generations/ports/generation-repository.ts';
import type { GenerationStatus } from '@/generations/domain/generation.ts';
import { RingBuffer } from './ring-buffer.ts';
import { Subscriber } from './subscriber.ts';
import { TextCoalescer } from './text-coalescer.ts';
import type { SSEFrame, GenerationCompletedPayload } from './events.ts';

export interface GenerationRunConfig {
  readonly detachTimeoutSeconds: number;
  readonly generationTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly maxBufferEvents?: number;
  readonly maxBufferBytes?: number;
}

export interface GenerationRunPartStartedInput {
  readonly partId: string;
  readonly position: number;
  readonly type: 'text' | 'image' | 'file';
  readonly name?: string | undefined;
  readonly mimeType?: string | undefined;
}

/** Provider-emitted binary artifact awaiting hydration. */
export interface GenerationRunArtifactInput {
  readonly partId: string;
  readonly providerFileId: string;
  readonly filename: string;
  readonly mimeType?: string | undefined;
  readonly sizeBytes?: number | undefined;
  /** Provider-returned bytes (image tool base64); when set there is nothing to download. */
  readonly bytes?: Uint8Array | undefined;
}

export interface GenerationRunHooks {
  readonly onStart?: ((generationId: string) => Promise<void>) | undefined;
  readonly onPartStarted?: ((input: GenerationRunPartStartedInput) => Promise<void>) | undefined;
  readonly onPartDone?: ((partId: string, text: string) => Promise<void>) | undefined;
  readonly onArtifact?:
    ((input: GenerationRunArtifactInput) => Promise<{ attachmentId: string } | null>) | undefined;
  readonly onTextChunk?:
    ((partId: string, chunk: string, lastEventSeq: number) => void) | undefined;
  readonly onHeartbeat?: ((generationId: string) => Promise<void>) | undefined;
  readonly onFinalize?: ((input: RunFinalizeInput) => Promise<void>) | undefined;
}

export interface RunFinalizeInput {
  readonly generationId: string;
  readonly status: GenerationStatus;
  readonly finishReason: string;
  readonly error?:
    { readonly code: string; readonly message: string; readonly retryable: boolean } | undefined;
  readonly accumulatedText: string;
  readonly usage?: TokenUsage | undefined;
  /** Whether the upstream provider accepted the request (stream connection established / started event). */
  readonly providerAccepted?: boolean | undefined;
  /** Abort reason for a cancelled run (`user_cancel` | `detached`) — the DB `cancel_reason` value. */
  readonly cancelReason?: string | undefined;
  /** Part the run streamed text into, so the finalizer can persist text if the part row is missing. */
  readonly fallbackPartId?: string | undefined;
}

export interface GenerationRunInput {
  readonly generation: GenerationRecord;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly chatRequest: NormalizedChatRequest;
  readonly adapter: ProviderAdapter;
  readonly contextInfo: {
    readonly truncated: boolean;
    readonly droppedMessageCount?: number | undefined;
  };
  readonly clock: Clock;
  readonly idGen: IdGenerator;
  readonly config: GenerationRunConfig;
  readonly hooks?: GenerationRunHooks | undefined;
}

interface NextResult<T> {
  readonly done: boolean;
  readonly value?: T;
  readonly aborted?: boolean;
}

/** Races an async iterator next() against an AbortSignal. */
async function nextWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<NextResult<T>> {
  if (signal.aborted) {
    return { done: true, aborted: true };
  }

  let abortHandler: (() => void) | undefined;
  const abortPromise = new Promise<NextResult<T>>((resolve) => {
    abortHandler = (): void => {
      resolve({ done: true, aborted: true });
    };
    signal.addEventListener('abort', abortHandler, { once: true });
  });

  try {
    const nextPromise = iterator.next().then((res) => ({
      done: res.done ?? false,
      value: res.value,
      aborted: false,
    }));
    nextPromise.catch(() => {});
    return await Promise.race([nextPromise, abortPromise]);
  } finally {
    if (abortHandler !== undefined) {
      signal.removeEventListener('abort', abortHandler);
    }
  }
}

/** Extracts the `command` field from a container tool's input, when present and string-typed. */
function commandFromToolInput(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('command' in input)) return undefined;
  return typeof input.command === 'string' ? input.command : undefined;
}

/** A file part's kind follows its MIME type; documents and unknown types render as `file`. */
function mimeForArtifact(mimeType: string | undefined, filename: string): 'image' | 'file' {
  const mime = mimeType ?? '';
  if (mime.startsWith('image/')) return 'image';
  // Fall back to the extension when the provider omits a MIME type.
  if (mime === '' && /\.(png|jpe?g|webp|gif)$/i.test(filename)) return 'image';
  return 'file';
}

/** Owns execution lifecycle, ring buffer, subscriber fan-out, and coalescing for a run. */
export class GenerationRun {
  readonly generationId: string;
  readonly conversationId: string;
  readonly userId: string;
  readonly modelId: string;
  readonly providerId: string;

  private status: GenerationStatus = 'pending';
  private readonly abortController = new AbortController();
  readonly ringBuffer: RingBuffer;
  readonly subscribers = new Map<string, Subscriber>();

  private readonly clock: Clock;
  private readonly idGen: IdGenerator;
  private readonly config: GenerationRunConfig;
  private readonly hooks?: GenerationRunHooks | undefined;
  private readonly adapter: ProviderAdapter;
  private readonly chatRequest: NormalizedChatRequest;

  private detachTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSubscriberAt: Date;

  private readonly textCoalescer: TextCoalescer;
  private currentPartId: string | null = null;
  private accumulatedText = '';
  /** Next `message_parts.position` — one allocator per assistant message, emission order. */
  private nextPartPosition = 0;
  /** File/image parts by adapter block index — `artifact_emitted` associates by index when given. */
  private readonly filePartIdsByIndex = new Map<number, string>();
  /** File parts opened in order — the fallback association for an index-less `artifact_emitted`. */
  private readonly openFilePartIds: string[] = [];
  private readonly completedFilePartIds = new Set<string>();
  private providerAccepted = false;
  private providerRequestId: string | null = null;
  private capturedUsage?: TokenUsage | undefined;
  /** Wall-clock start of the provider call and the first text delta, for the TTFT histogram. */
  private runStartedAt: Date | null = null;
  private firstTextAt: Date | null = null;

  constructor(input: GenerationRunInput) {
    this.generationId = input.generation.id;
    this.conversationId = input.generation.conversationId;
    this.userId = input.generation.userId;
    this.modelId = input.generation.modelId;
    this.providerId = input.generation.providerId;
    this.adapter = input.adapter;
    this.chatRequest = input.chatRequest;
    this.clock = input.clock;
    this.idGen = input.idGen;
    this.config = input.config;
    this.hooks = input.hooks;
    this.lastSubscriberAt = input.clock.now();

    this.ringBuffer = new RingBuffer({
      maxEvents: input.config.maxBufferEvents ?? 2000,
      maxBytes: input.config.maxBufferBytes ?? 1024 * 1024,
    });

    this.textCoalescer = new TextCoalescer({
      flushIntervalMs: 50,
      onFlush: (partId, delta) => {
        this.emitFrame('text.delta', { partId, delta });
      },
    });

    /** Frame #1: message.created (pre-subscribe, at enqueue). */
    this.ringBuffer.push('message.created', {
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
    });

    /** Frame #2: generation.state (generating). */
    this.ringBuffer.push('generation.state', { state: 'generating' });

    if (input.contextInfo.truncated) {
      this.ringBuffer.push('context.truncated', {
        droppedMessages: input.contextInfo.droppedMessageCount ?? 0,
      });
    }

    /** Arm detach timer initially: if no subscriber attaches within timeout, abort. */
    this.armDetachTimer();
  }

  get currentStatus(): GenerationStatus {
    return this.status;
  }

  get activeSubscriberCount(): number {
    return this.subscribers.size;
  }

  get totalAccumulatedText(): string {
    return this.accumulatedText;
  }

  /** Seconds from provider call start to first text delta; `null` if no text was produced. */
  get timeToFirstTokenSeconds(): number | null {
    if (this.runStartedAt === null || this.firstTextAt === null) return null;
    return (this.firstTextAt.getTime() - this.runStartedAt.getTime()) / 1000;
  }

  /** Wall-clock seconds the provider call has been running (until now or the terminal moment). */
  durationSeconds(until: Date): number | null {
    if (this.runStartedAt === null) return null;
    return (until.getTime() - this.runStartedAt.getTime()) / 1000;
  }

  get lastSeenSubscriberAt(): Date {
    return this.lastSubscriberAt;
  }

  get currentProviderRequestId(): string | null {
    return this.providerRequestId;
  }

  get isTerminal(): boolean {
    return this.status === 'completed' || this.status === 'cancelled' || this.status === 'failed';
  }

  /** Attaches a subscriber to this run, validating replay capability. */
  subscribe(
    subscriberId: string,
    lastEventSeq?: number,
  ): { readonly canReplay: boolean; readonly subscriber: Subscriber } {
    if (lastEventSeq !== undefined && lastEventSeq > 0) {
      if (!this.ringBuffer.canReplay(lastEventSeq)) {
        const dummy = new Subscriber(subscriberId);
        dummy.close();
        return { canReplay: false, subscriber: dummy };
      }
    }

    this.disarmDetachTimer();

    const subscriber = new Subscriber(subscriberId, {
      onDisconnect: (id) => {
        this.subscribers.delete(id);
        this.lastSubscriberAt = this.clock.now();
        if (this.subscribers.size === 0 && !this.isTerminal) {
          this.armDetachTimer();
        }
      },
      onKick: (_id, _reason) => {
        this.subscribers.delete(_id);
      },
    });

    const replayFrames =
      lastEventSeq !== undefined && lastEventSeq > 0
        ? this.ringBuffer.replayFrom(lastEventSeq)
        : this.ringBuffer.getAll();

    for (const frame of replayFrames) {
      subscriber.push(frame);
    }

    if (this.isTerminal) {
      subscriber.close();
    } else {
      this.subscribers.set(subscriberId, subscriber);
    }

    return { canReplay: true, subscriber };
  }

  /**
   * Explicitly aborts this generation with a reason (e.g. 'user_cancel', 'detached', 'shutdown').
   */
  abort(reason: string): void {
    if (this.isTerminal || this.abortController.signal.aborted) return;
    this.abortController.abort(reason);
  }

  /** Exposed so long-running side work (artifact downloads) obeys run cancellation. */
  get abortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Begins generation execution, streaming events until completion or error. */
  async start(): Promise<void> {
    if (this.status !== 'pending') return;
    this.status = 'generating';
    this.runStartedAt = this.clock.now();

    if (this.hooks?.onStart !== undefined) {
      try {
        await this.hooks.onStart(this.generationId);
      } catch {
        // Non-fatal hook error
      }
    }

    this.startHeartbeatTimer();

    const timeoutMs = this.config.generationTimeoutMs ?? 300_000;
    const deadline = this.clock.now().getTime() + timeoutMs;
    const signal = this.abortController.signal;

    const timeoutTimer = setTimeout(() => {
      this.abort('timeout');
    }, timeoutMs);

    let terminalReason = 'stop';
    let terminalError: { code: string; message: string; retryable: boolean } | undefined;

    const iterable = this.adapter.execute(this.chatRequest, { signal, deadline });
    const iterator = iterable[Symbol.asyncIterator]();

    try {
      while (true) {
        const res = await nextWithAbort(iterator, signal);
        if (res.aborted) {
          break;
        }
        if (res.done) {
          break;
        }

        const event = res.value;
        if (!event) continue;

        await this.handlePALEvent(event);
        if (event.type === 'finished' || event.type === 'error') {
          if (event.type === 'finished') {
            terminalReason = event.reason;
          } else {
            terminalReason = 'error';
            terminalError = {
              code: event.error.category,
              message: event.error.safeMessage,
              retryable: event.error.retryable,
            };
          }
          break;
        }
      }
    } catch (err) {
      terminalReason = 'error';
      const providerError = this.adapter.translateError(err);
      terminalError = {
        code: providerError.category,
        message: providerError.safeMessage,
        retryable: providerError.retryable,
      };
    } finally {
      clearTimeout(timeoutTimer);
      // Release the provider's socket promptly. Bounded: a generator suspended inside an
      // `await` ignores `return()` until it resumes, and that must not delay the terminal state.
      try {
        const closed = await Promise.race([
          Promise.resolve(iterator.return?.(undefined)).then(
            () => true,
            () => true,
          ),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
        ]);
        void closed;
      } catch {
        // Best-effort cleanup; a throwing return() must not mask the terminal outcome.
      }

      this.textCoalescer.flush();
      await this.finalizeRun(terminalReason, terminalError);
    }
  }

  private async handlePALEvent(event: GenerationEvent): Promise<void> {
    if (event.type !== 'error') {
      this.providerAccepted = true;
    }
    switch (event.type) {
      case 'started':
        if (event.providerRequestId !== undefined) {
          this.providerRequestId = event.providerRequestId;
        }
        break;

      case 'part_started':
        if (event.partType === 'text') {
          this.currentPartId = this.idGen.uuidv7();
          const position = this.nextPartPosition++;
          if (this.hooks?.onPartStarted !== undefined) {
            await this.hooks.onPartStarted({
              partId: this.currentPartId,
              position,
              type: 'text',
            });
          }
          this.emitFrame('part.started', {
            partId: this.currentPartId,
            position,
            type: 'text',
            mimeType: event.mimeType,
            name: event.name,
          });
          break;
        }
        await this.openFilePart(event.index, event.partType, event.name, event.mimeType);
        break;

      case 'text_delta': {
        // Some adapters stream text without `part_started`; without the row every checkpoint
        // and the final write silently update 0 rows.
        if (this.currentPartId === null) {
          this.currentPartId = this.idGen.uuidv7();
          const createdPosition = this.nextPartPosition++;
          if (this.hooks?.onPartStarted !== undefined) {
            await this.hooks.onPartStarted({
              partId: this.currentPartId,
              position: createdPosition,
              type: 'text',
            });
          }
          this.emitFrame('part.started', {
            partId: this.currentPartId,
            position: createdPosition,
            type: 'text',
          });
        }
        this.accumulatedText += event.text;
        if (this.firstTextAt === null) this.firstTextAt = this.clock.now();
        this.textCoalescer.append(this.currentPartId, event.text);
        if (this.hooks?.onTextChunk !== undefined) {
          this.hooks.onTextChunk(this.currentPartId, event.text, this.ringBuffer.lastSeq ?? 0);
        }
        break;
      }

      case 'artifact_chunk':
        this.abortController.abort('unsupported_modality');
        throw new Error('Adapter emitted unsupported artifact_chunk');

      case 'tool_started': {
        const command = commandFromToolInput(event.input);
        this.emitFrame('tool.started', {
          partId: this.currentPartId ?? '',
          toolCallId: event.toolCallId,
          tool: event.name,
          ...(command !== undefined ? { command } : {}),
        });
        break;
      }

      case 'tool_delta':
        this.emitFrame('tool.delta', {
          partId: this.currentPartId ?? '',
          toolCallId: event.toolCallId,
          delta: event.delta,
        });
        break;

      case 'tool_completed':
        this.emitFrame('tool.completed', {
          partId: this.currentPartId ?? '',
          toolCallId: event.toolCallId,
          status: event.status,
        });
        break;

      case 'artifact_emitted':
        await this.hydrateArtifact(event);
        break;

      case 'part_done':
        this.textCoalescer.flush();
        if (event.fileId !== undefined) {
          const filePartId = this.filePartIdForIndex(event.index) ?? this.currentPartId ?? '';
          // Hydration already resolved (or failed) this part; a duplicate must not flip a
          // failed part back to complete.
          if (filePartId === '' || this.completedFilePartIds.has(filePartId)) break;
          this.emitFrame('part.completed', {
            partId: filePartId,
            status: 'complete',
            fileId: event.fileId,
            downloadUrl: `/api/files/${event.fileId}/content`,
          });
          break;
        }
        if (this.currentPartId !== null) {
          if (this.hooks?.onPartDone !== undefined) {
            await this.hooks.onPartDone(this.currentPartId, this.accumulatedText);
          }
          this.emitFrame('part.completed', {
            partId: this.currentPartId,
            status: 'complete',
          });
        }
        break;

      case 'progress':
        this.emitFrame('progress', {
          stage: event.stage,
          percent: event.percent,
        });
        break;

      case 'usage':
        this.capturedUsage = event.usage;
        this.emitFrame('usage.updated', {
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
        });
        break;

      case 'finished':
      case 'error':
        // Terminal markers handled in start() loop
        break;
    }
  }

  /** Opens a non-text (file or image) part in streaming status. */
  private async openFilePart(
    index: number,
    partType: 'image' | 'file',
    name?: string,
    mimeType?: string,
  ): Promise<void> {
    const partId = this.idGen.uuidv7();
    const position = this.nextPartPosition++;
    this.filePartIdsByIndex.set(index, partId);
    this.openFilePartIds.push(partId);

    if (this.hooks?.onPartStarted !== undefined) {
      await this.hooks.onPartStarted({
        partId,
        position,
        type: partType,
        ...(name !== undefined ? { name } : {}),
        ...(mimeType !== undefined ? { mimeType } : {}),
      });
    }

    this.emitFrame('part.started', {
      partId,
      position,
      type: partType,
      name,
      mimeType,
    });
  }

  /** Association order: explicit index first, else the oldest still-open file part. */
  private filePartIdForIndex(index: number | undefined): string | null {
    if (index !== undefined) {
      const byIndex = this.filePartIdsByIndex.get(index);
      if (byIndex !== undefined) return byIndex;
    }
    return this.openFilePartIds.find((id) => !this.completedFilePartIds.has(id)) ?? null;
  }

  /** Hydrates a provider artifact and emits completion frame with download URL. */
  private async hydrateArtifact(event: {
    readonly providerFileId: string;
    readonly filename: string;
    readonly mimeType?: string | undefined;
    readonly sizeBytes?: number | undefined;
    readonly bytes?: Uint8Array | undefined;
    readonly index?: number | undefined;
  }): Promise<void> {
    let partId = this.filePartIdForIndex(event.index);
    if (partId === null) {
      await this.openFilePart(
        event.index ?? this.filePartIdsByIndex.size,
        mimeForArtifact(event.mimeType, event.filename),
        event.filename,
        event.mimeType,
      );
      partId = this.filePartIdForIndex(event.index);
    }
    if (partId === null) return;

    let attachmentId: string | null = null;
    if (this.hooks?.onArtifact !== undefined) {
      try {
        const result = await this.hooks.onArtifact({
          partId,
          providerFileId: event.providerFileId,
          filename: event.filename,
          ...(event.mimeType !== undefined ? { mimeType: event.mimeType } : {}),
          ...(event.sizeBytes !== undefined ? { sizeBytes: event.sizeBytes } : {}),
          ...(event.bytes !== undefined ? { bytes: event.bytes } : {}),
        });
        attachmentId = result?.attachmentId ?? null;
      } catch {
        attachmentId = null;
      }
    }

    this.completedFilePartIds.add(partId);
    this.emitFrame(
      'part.completed',
      attachmentId !== null
        ? {
            partId,
            status: 'complete',
            fileId: attachmentId,
            downloadUrl: `/api/files/${attachmentId}/content`,
          }
        : { partId, status: 'failed' },
    );
  }

  private async finalizeRun(
    finishReason: string,
    error?: { code: string; message: string; retryable: boolean },
  ): Promise<void> {
    if (this.isTerminal) return;

    this.disarmDetachTimer();
    this.stopHeartbeatTimer();

    // The abort reason (`user_cancel` | `detached` | `shutdown`) is what the DB
    // `cancel_reason` CHECK accepts — distinct from the wire `finishReason` ('cancelled').
    let cancelReason: string | undefined;

    const signal = this.abortController.signal;
    if (signal.aborted) {
      const abortReason = signal.reason ?? 'user_cancel';
      if (abortReason === 'user_cancel' || abortReason === 'detached') {
        this.status = 'cancelled';
        finishReason = 'cancelled';
        cancelReason = String(abortReason);
        this.emitFrame('generation.cancelled', { reason: String(abortReason) });
      } else if (abortReason === 'timeout') {
        this.status = 'failed';
        finishReason = 'timeout';
        const code = 'generation_timeout';
        const msg = 'The generation timed out.';
        this.emitFrame('generation.failed', {
          error: { code, message: msg, retryable: true },
        });
        error = { code, message: msg, retryable: true };
      } else {
        this.status = 'failed';
        finishReason = abortReason === 'shutdown' ? 'interrupted' : 'error';
        const code =
          abortReason === 'shutdown'
            ? 'generation_interrupted'
            : abortReason === 'unsupported_modality'
              ? 'internal_error'
              : 'generation_cancelled';
        const msg =
          abortReason === 'shutdown'
            ? 'The generation was interrupted by server shutdown.'
            : 'The generation was cancelled.';
        this.emitFrame('generation.failed', {
          error: { code, message: msg, retryable: false },
        });
        error = { code, message: msg, retryable: false };
      }
    } else if (error !== undefined) {
      this.status = 'failed';
      this.emitFrame('generation.failed', { error });
    } else {
      this.status = 'completed';
      const completedPayload: GenerationCompletedPayload = {
        finishReason: (finishReason as GenerationCompletedPayload['finishReason']) || 'stop',
        usage: {
          input: this.capturedUsage?.inputTokens ?? 0,
          output: this.capturedUsage?.outputTokens ?? Math.ceil(this.accumulatedText.length / 4),
          quotaTokens:
            this.capturedUsage?.outputTokens ?? Math.ceil(this.accumulatedText.length / 4),
        },
        remainingQuota: null,
      };
      this.emitFrame('generation.completed', completedPayload);
    }

    if (this.hooks?.onFinalize !== undefined) {
      try {
        await this.hooks.onFinalize({
          generationId: this.generationId,
          status: this.status,
          finishReason,
          error,
          accumulatedText: this.accumulatedText,
          usage: this.capturedUsage,
          providerAccepted: this.providerAccepted,
          ...(cancelReason !== undefined ? { cancelReason } : {}),
          ...(this.currentPartId !== null ? { fallbackPartId: this.currentPartId } : {}),
        });
      } catch {
        // Suppress hook errors in run loop
      }
    }

    for (const sub of this.subscribers.values()) {
      sub.close();
    }
    this.subscribers.clear();
  }

  private emitFrame(event: SSEFrame['event'], payload: unknown): SSEFrame {
    const frame = this.ringBuffer.push(event, payload);
    for (const sub of this.subscribers.values()) {
      sub.push(frame);
    }
    return frame;
  }

  private armDetachTimer(): void {
    if (this.detachTimer !== null || this.isTerminal) return;
    const timeoutSec = this.config.detachTimeoutSeconds;
    if (timeoutSec <= 0) return;

    this.detachTimer = setTimeout(() => {
      this.detachTimer = null;
      if (this.subscribers.size === 0 && !this.isTerminal) {
        this.abort('detached');
      }
    }, timeoutSec * 1000);
  }

  private disarmDetachTimer(): void {
    if (this.detachTimer !== null) {
      clearTimeout(this.detachTimer);
      this.detachTimer = null;
    }
  }

  private startHeartbeatTimer(): void {
    if (this.heartbeatTimer !== null) return;
    const intervalMs = this.config.heartbeatIntervalMs ?? 15_000;

    this.heartbeatTimer = setInterval(() => {
      if (this.isTerminal) {
        this.stopHeartbeatTimer();
        return;
      }
      if (this.status === 'generating') {
        for (const sub of this.subscribers.values()) {
          sub.push({
            id: 0,
            event: 'generation.state',
            data: '',
            byteLength: 0,
            comment: true,
          });
        }
        if (this.hooks?.onHeartbeat !== undefined) {
          // A transient DB failure here is retried on the next beat; it must never become
          // an unhandled rejection from the floating interval callback.
          this.hooks.onHeartbeat(this.generationId).catch(() => {});
        }
      }
    }, intervalMs);
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
