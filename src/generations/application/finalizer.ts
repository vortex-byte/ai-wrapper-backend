import type { Clock } from '@/clock/index.ts';
import { withTransaction } from '@/db/tx.ts';
import type { TokenUsage } from '@/providers/domain/pal.ts';
import type { ConversationRepository } from '@/conversations/ports/conversation-repository.ts';
import type { GenerationRepository } from '../ports/generation-repository.ts';
import type { QuotaPort } from '../ports/quota-port.ts';
import type { ErrorEventWriter } from '../ports/error-event-writer.ts';
import {
  mapOutcome,
  type CancelReason,
  type GenerationFailureCategory,
  type GenerationOutcome,
  type GenerationStatus,
} from '../domain/generation.ts';
import { getLogger } from '@/observability/logger.ts';

export interface FinalizeInput {
  readonly generationId: string;
  readonly status: GenerationStatus;
  readonly finishReason: string;
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean } | undefined;
  readonly accumulatedText: string;
  readonly usage?: TokenUsage | undefined;
  /**
   * The abort reason stored in `generation_jobs.cancel_reason` (DB CHECK: `user_cancel` |
   * `detached` | `shutdown`). Distinct from `finishReason`, which is the wire-level reason
   * (`cancelled`, `stop`, `error`). Defaults to `user_cancel` for a cancelled generation.
   */
  readonly cancelReason?: string | undefined;
  readonly fallbackPartId?: string | undefined;
  readonly durationMs?: number | null | undefined;
  readonly timeToFirstTokenMs?: number | null | undefined;
}

export interface FinalizerDeps {
  readonly generations: GenerationRepository;
  readonly conversations: ConversationRepository;
  readonly quota: QuotaPort;
  readonly errorEvents: ErrorEventWriter;
  readonly clock: Clock;
}

/**
 * Handles terminal settlement for a generation.
 * Atomically transitions generation_jobs to its terminal state. If already terminalized, returns false (no-op).
 * Updates message and part statuses, flushes text, settles quota, and logs error events.
 */
export class Finalizer {
  private readonly generations: GenerationRepository;
  private readonly conversations: ConversationRepository;
  private readonly quota: QuotaPort;
  private readonly errorEvents: ErrorEventWriter;
  private readonly clock: Clock;

  constructor(deps: FinalizerDeps) {
    this.generations = deps.generations;
    this.conversations = deps.conversations;
    this.quota = deps.quota;
    this.errorEvents = deps.errorEvents;
    this.clock = deps.clock;
  }

  async finalize(input: FinalizeInput): Promise<boolean> {
    if (input.status !== 'completed' && input.status !== 'cancelled' && input.status !== 'failed') {
      return false;
    }

    const now = this.clock.now();

    const outcome = toOutcome(input);
    const initialMapping = mapOutcome(outcome, { hasContent: input.accumulatedText.length > 0 });

    let resolvedText = input.accumulatedText;
    let finishReason = initialMapping.finishReason;

    const record = await withTransaction(async (tx) => {
      // Transition generation to terminal state atomically.
      const transitioned = await this.generations.transitionToTerminal(
        {
          generationId: input.generationId,
          status: initialMapping.generationStatus,
          cancelReason:
            outcome.kind === 'cancelled' ? input.cancelReason ?? outcome.reason : null,
          errorCategory: input.error?.code ?? (outcome.kind === 'interrupted' ? 'generation_interrupted' : null),
          errorDetail: input.error
            ? { message: input.error.message, retryable: input.error.retryable }
            : null,
          finishedAt: now,
        },
        tx,
      );

      if (!transitioned) {
        // Another worker/path already finalized this generation -> idempotent no-op
        return null;
      }

      const generationRecord = await this.generations.findById(input.generationId, tx);
      if (generationRecord === null) {
        return null;
      }

      // Preserve existing checkpointed text if caller passed empty text (e.g. external cancel).
      const messageWithParts = await this.conversations.findMessageForUser(
        generationRecord.assistantMessageId,
        generationRecord.userId,
        tx,
      );

      const existingText =
        messageWithParts?.parts.find((part) => part.type === 'text')?.textContent ?? '';
      resolvedText = input.accumulatedText.length > 0 ? input.accumulatedText : existingText;

      const mapping = mapOutcome(outcome, { hasContent: resolvedText.length > 0 });
      finishReason = mapping.finishReason;
      const { messageStatus, streamingPartStatus: partStatus } = mapping;

      await this.conversations.updateMessage(
        generationRecord.assistantMessageId,
        {
          status: messageStatus,
          finishReason,
          completedAt: now,
        },
        tx,
      );

      if (messageWithParts !== null) {
        const textParts = messageWithParts.parts.filter((part) => part.type === 'text');
        for (const part of textParts) {
          await this.conversations.updatePart(
            part.id,
            {
              status: partStatus,
              textContent: resolvedText,
            },
            tx,
          );
        }

        // Resilience: an adapter that streamed raw `text_delta` without a preceding
        // `part_started`, or a crash that lost the part row, leaves the assistant message with no
        // text part. Persist the accumulated text so the content is recoverable rather than lost.
        if (textParts.length === 0 && resolvedText.length > 0) {
          const position = messageWithParts.parts.length;
          await this.conversations.insertParts(
            [
              {
                id: input.fallbackPartId ?? crypto.randomUUID(),
                messageId: generationRecord.assistantMessageId,
                position,
                type: 'text',
                status: partStatus,
                textContent: resolvedText,
                data: {},
                fileId: null,
                createdAt: now,
                updatedAt: now,
              },
            ],
            tx,
          );
        }
      }

      // Quota settlement in the same transaction so reservations never outlive terminal state.
      const usage =
        input.usage ?? {
          inputTokens: generationRecord.estInputTokens ?? 0,
          outputTokens: Math.ceil(resolvedText.length / 4),
          source: 'estimated' as const,
        };

      const started = generationRecord.startedAt !== null;
      const shouldSettle = started || resolvedText.length > 0;
      const durationMs =
        input.durationMs ??
        (generationRecord.startedAt !== null
          ? Math.max(0, now.getTime() - generationRecord.startedAt.getTime())
          : null);

      await this.quota.settleOrRelease(
        {
          generationId: generationRecord.id,
          outcome: shouldSettle ? 'settled' : 'released',
          actualTokens: shouldSettle ? usage.inputTokens + usage.outputTokens : 0,
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...(usage.cachedInputTokens !== undefined
              ? { cachedInputTokens: usage.cachedInputTokens }
              : {}),
            ...(usage.reasoningTokens !== undefined
              ? { reasoningTokens: usage.reasoningTokens }
              : {}),
            source: usage.source,
          },
          outcomeCategory:
            input.status === 'completed'
              ? 'completed'
              : input.status === 'cancelled'
                ? 'cancelled'
                : 'failed',
          errorCategory: input.error?.code ?? null,
          durationMs,
          timeToFirstTokenMs: input.timeToFirstTokenMs ?? null,
        },
        tx,
      );

      return generationRecord;
    });

    if (record === null) {
      return false;
    }

    const usage =
      input.usage ?? {
        inputTokens: record.estInputTokens ?? 0,
        outputTokens: Math.ceil(resolvedText.length / 4),
        source: 'estimated' as const,
      };

    if (input.status === 'failed' && input.error !== undefined) {
      try {
        await this.errorEvents.record({
          requestId: record.requestId,
          component: 'orchestrator',
          category: input.error.code,
          providerId: record.providerId,
          modelId: record.modelId,
          generationId: record.id,
          message: input.error.message,
          context: { retryable: input.error.retryable },
        });
      } catch {
        // Non-fatal error event write failure
      }
    }

    const durationMs = record.startedAt ? Math.max(0, now.getTime() - record.startedAt.getTime()) : null;
    getLogger().info(
      {
        requestId: record.requestId,
        userId: record.userId,
        generationId: record.id,
        modelId: record.modelId,
        providerId: record.providerId,
        status: input.status,
        finishReason,
        durationMs,
        outputTokens: usage.outputTokens,
      },
      'generation finalized',
    );

    return true;
  }
}

/**
 * Translate the finalizer's flat input into the domain `GenerationOutcome`.
 */
function toOutcome(input: FinalizeInput): GenerationOutcome {
  if (input.status === 'completed') {
    return { kind: 'completed', finishReason: completedFinishReason(input.finishReason) };
  }
  if (input.status === 'cancelled') {
    return { kind: 'cancelled', reason: normaliseCancelReason(input.cancelReason) };
  }
  if (input.finishReason === 'interrupted') {
    return { kind: 'interrupted' };
  }
  return { kind: 'failed', category: failureCategory(input.finishReason) };
}

function completedFinishReason(reason: string): 'stop' | 'length' | 'content_filter' {
  if (reason === 'length') return 'length';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

function normaliseCancelReason(reason: string | undefined): CancelReason {
  if (reason === 'detached' || reason === 'shutdown') return reason;
  return 'user_cancel';
}

/** `timeout` maps to the dedicated category; everything else that failed is a provider-level error. */
function failureCategory(reason: string): GenerationFailureCategory {
  switch (reason) {
    case 'provider_unavailable':
    case 'provider_rate_limited':
    case 'generation_timeout':
    case 'content_filtered':
    case 'incomplete':
    case 'internal_error':
      return reason;
    case 'timeout':
      return 'generation_timeout';
    default:
      return 'internal_error';
  }
}
