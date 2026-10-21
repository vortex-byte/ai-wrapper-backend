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
import { toolTariff } from '@/quota/domain/tariffs.ts';

export interface FinalizeInput {
  readonly generationId: string;
  readonly status: GenerationStatus;
  readonly finishReason: string;
  readonly error?:
    { readonly code: string; readonly message: string; readonly retryable: boolean } | undefined;
  readonly accumulatedText: string;
  readonly usage?: TokenUsage | undefined;
  /** Whether the upstream provider accepted the request (stream connection established / started event). */
  readonly providerAccepted?: boolean | undefined;
  /** Stored cancel reason: user_cancel, detached, or shutdown. */
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

/** Idempotent terminal settlement for a generation, reconciling messages, parts, and quota. */
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
      const transitioned = await this.generations.transitionToTerminal(
        {
          generationId: input.generationId,
          status: initialMapping.generationStatus,
          cancelReason:
            outcome.kind === 'cancelled' ? (input.cancelReason ?? outcome.reason) : null,
          errorCategory:
            input.error?.code ?? (outcome.kind === 'interrupted' ? 'generation_interrupted' : null),
          errorDetail: input.error
            ? { message: input.error.message, retryable: input.error.retryable }
            : null,
          finishedAt: now,
        },
        tx,
      );

      if (!transitioned) {
        return null;
      }

      const generationRecord = await this.generations.findById(input.generationId, tx);
      if (generationRecord === null) {
        return null;
      }

      // An external cancel passes no text; keep whatever the checkpointer already persisted.
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
        if (textParts.length === 1) {
          const singlePart = textParts[0];
          if (singlePart !== undefined) {
            await this.conversations.updatePart(
              singlePart.id,
              {
                status: partStatus,
                textContent: resolvedText,
              },
              tx,
            );
          }
        } else {
          for (const part of textParts) {
            await this.conversations.updatePart(
              part.id,
              {
                status: partStatus,
                ...(part.textContent !== null ? { textContent: part.textContent } : {}),
              },
              tx,
            );
          }
        }

        // Non-text parts stay `streaming` until the ArtifactSink links their bytes, and the DB
        // CHECK forbids `complete` without a `file_id`. Settle them here so a cancel, a failure
        // or a missing artifact cannot leave a part streaming forever.
        for (const part of messageWithParts.parts) {
          if (part.type === 'text' || part.status !== 'streaming') continue;
          await this.conversations.updatePart(
            part.id,
            { status: part.fileId !== null ? 'complete' : 'failed' },
            tx,
          );
        }

        // An adapter that streamed text without `part_started`, or a crash that lost the part
        // row, would drop the whole answer: persist it so the content stays recoverable.
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

      // Same transaction as the terminal transition, so a reservation can never outlive it.
      const usage = input.usage ?? {
        inputTokens: generationRecord.estInputTokens ?? 0,
        outputTokens: Math.ceil(resolvedText.length / 4),
        source: 'estimated' as const,
      };

      const started = generationRecord.startedAt !== null;
      const shouldSettle =
        input.status === 'completed' ||
        (input.providerAccepted === false ? false : started || resolvedText.length > 0);

      const hasCompletedImage =
        messageWithParts?.parts.some(
          (part) =>
            (part.type === 'image' || part.type === 'generated_file') &&
            (part.status === 'complete' || part.fileId !== null),
        ) ?? false;
      const imageTariffTokens = hasCompletedImage
        ? (toolTariff('image_generation')?.tokens ?? 0)
        : 0;

      const durationMs =
        input.durationMs ??
        (generationRecord.startedAt !== null
          ? Math.max(0, now.getTime() - generationRecord.startedAt.getTime())
          : null);

      await this.quota.settleOrRelease(
        {
          generationId: generationRecord.id,
          outcome: shouldSettle ? 'settled' : 'released',
          actualTokens: shouldSettle
            ? usage.inputTokens + usage.outputTokens + imageTariffTokens
            : 0,
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

    const usage = input.usage ?? {
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

    const durationMs = record.startedAt
      ? Math.max(0, now.getTime() - record.startedAt.getTime())
      : null;
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
