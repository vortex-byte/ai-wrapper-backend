import { createHash } from 'node:crypto';
import type { Clock, IdGenerator } from '@/clock/index.ts';
import type { Config } from '@/config/index.ts';
import { AppError, isUniqueViolationOf } from '@/errors.ts';
import { withTransaction } from '@/db/tx.ts';
import { buildContext } from '@/context-builder/context-builder.ts';
import type { ConversationRepository } from '@/conversations/ports/conversation-repository.ts';
import type { Conversation, Message, MessagePart } from '@/conversations/domain/conversation.ts';
import { deriveTitleFromText } from '@/conversations/domain/conversation.ts';
import type { ModelRegistry } from '@/providers/ports/model-registry.ts';
import type { NormalizedPart } from '@/providers/domain/pal.ts';
import type { GenerationRepository, GenerationRecord } from '../ports/generation-repository.ts';
import type { QuotaPort } from '../ports/quota-port.ts';
import type { GenerationEnqueuer, EnqueueGenerationInput } from '../ports/generation-enqueuer.ts';

/**
 * Transactional, idempotent send service.
 *
 * All durable effects — the idempotency claim, sequence allocation, user message and parts,
 * assistant placeholder, generation record, and quota reservation — commit together in one transaction.
 * The provider call is handed to the orchestrator only after this transaction commits.
 */

export interface SendMessageDeps {
  readonly conversations: ConversationRepository;
  readonly generations: GenerationRepository;
  readonly quota: QuotaPort;
  readonly registry: ModelRegistry;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
  readonly config: Config;
  readonly orchestrator?: GenerationEnqueuer | undefined;
}

/** One content block of the new user turn, as it arrives from the wire. */
export type SendPartInput =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'file'; readonly fileId: string };

export interface SendMessageInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly parts: readonly SendPartInput[];
  readonly options?: { readonly maxOutputTokens?: number | undefined } | undefined;
}

/**
 * The wire payload representation stored for idempotent replay.
 */
export interface SendMessagePayload {
  readonly userMessage: WireMessage;
  readonly assistantMessage: WireMessage;
  readonly generation: { readonly id: string; readonly status: string; readonly streamUrl: string };
  readonly quota: { readonly reservedTokens: number; readonly remainingTokens: number | null } | null;
}

interface WireMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: string;
  readonly status: string;
  readonly finishReason: string | null;
  readonly createdAt: string;
  readonly generationId: string | null;
  readonly parts: readonly unknown[];
}

export interface RetryMessageInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly options?: { readonly maxOutputTokens?: number | undefined } | undefined;
}

export interface SendOutcome {
  readonly replayed: boolean;
  readonly payload: SendMessagePayload;
}

export interface SendService {
  send(input: SendMessageInput): Promise<SendOutcome>;
  retry(input: RetryMessageInput): Promise<SendOutcome>;
}

const MAX_CONTENT_CHARS = 200_000;

export function createSendService(deps: SendMessageDeps): SendService {
  /**
   * Post-commit recovery for a generation the orchestrator refused to enqueue (in-memory capacity
   * or draining gate). The send transaction already committed, so mark it terminal here rather
   * than waiting for the reaper sweep.
   */
  const recoverUnenqueuedGeneration = async (generationId: string): Promise<void> => {
    try {
      await deps.generations.transitionToTerminal({
        generationId,
        status: 'failed',
        errorCategory: 'service_busy',
        errorDetail: { message: 'The server could not start this generation.', retryable: true },
        finishedAt: deps.clock.now(),
      });
    } catch {
      // Best-effort: the reaper remains the backstop if this write fails too.
    }
  };

  return {
    async send(input) {
      const conversation = await deps.conversations.findByIdForUser(
        input.conversationId,
        input.userId,
      );
      if (conversation === null) {
        throw new AppError('not_found', 'Conversation not found.');
      }

      const resolved = await deps.registry.getRuntimeConfig(conversation.modelId);
      if (resolved === null || resolved.provider.status !== 'active') {
        throw new AppError('model_unavailable', 'This model is not available.');
      }
      if (resolved.model.status !== 'active') {
        throw new AppError('model_unavailable', 'This model is not available.');
      }
      const { model, provider, runtime } = resolved;

      for (const part of input.parts) {
        if (part.type === 'file') {
          throw new AppError(
            'unsupported_for_model',
            'File attachments are not supported yet.',
          );
        }
      }
      const textParts = input.parts.filter(
        (part): part is { type: 'text'; text: string } => part.type === 'text',
      );
      if (textParts.length === 0 || textParts.every((part) => part.text.trim().length === 0)) {
        throw new AppError('invalid_request', 'A message needs at least one non-empty text part.');
      }
      const contentChars = textParts.reduce((total, part) => total + part.text.length, 0);
      if (contentChars > MAX_CONTENT_CHARS) {
        throw new AppError('invalid_request', 'The message is too long.');
      }

      const requestHash = canonicalRequestHash(input.conversationId, input.parts, input.options);
      const newParts: NormalizedPart[] = textParts.map((part) => ({
        type: 'text',
        text: part.text,
      }));

      if (deps.orchestrator?.isDraining) {
        throw new AppError('service_busy', 'Server is shutting down.', {
          details: { retryAfterSeconds: 5 },
        });
      }
      const active = await deps.generations.countActiveNodeWide();
      if (active >= deps.config.MAX_ACTIVE_GENERATIONS) {
        throw new AppError('service_busy', undefined, {
          details: { retryAfterSeconds: 5 },
        });
      }

      const generationId = deps.idGen.uuidv7();
      const userIdHash = createHash('sha256').update(input.userId).digest('hex').slice(0, 32);
      let enqueuePayload: EnqueueGenerationInput | null = null;

      const outcome = await withTransaction(async (tx) => {
        // Idempotency claim. A replay returns the stored response and writes nothing else.
        const claim = await deps.generations.claimIdempotencyKey(
          {
            userId: input.userId,
            key: input.idempotencyKey,
            endpoint: 'POST /api/conversations/:id/messages',
            requestHash,
            expiresAt: new Date(deps.clock.now().getTime() + 24 * 60 * 60 * 1000),
          },
          tx,
        );
        if (!claim.claimed) {
          if (claim.stored.requestHash !== requestHash) {
            throw new AppError(
              'idempotency_key_reuse',
              'This idempotency key was used with a different request.',
            );
          }
          if (claim.stored.responseStatus === 0 || !claim.stored.responseBody) {
            throw new AppError(
              'conflict',
              'A generation with this idempotency key is currently in progress.',
            );
          }
          return { replayed: true, payload: claim.stored.responseBody as SendMessagePayload };
        }

        // Build context inside transaction for atomic budgeting.
        const history = await deps.conversations.listMessagesWithParts(
          { conversationId: conversation.id, limit: 200, before: null },
          tx,
        );
        const platformSystemPrompt = await readPlatformSystemPrompt();
        const maxOutputTokens = clampMaxOutputTokens(
          input.options?.maxOutputTokens,
          model.defaultMaxOutputTokens,
          model.maxOutputTokens,
        );
        const built = buildContext({
          requestId: input.requestId,
          generationId,
          model: runtime.model,
          provider: runtime.provider,
          ...(platformSystemPrompt !== undefined ? { platformSystemPrompt } : {}),
          newParts,
          history: history.items,
          maxOutputTokensOverride: maxOutputTokens,
          userIdHash,
        });

        // Allocate sequence numbers for user and assistant messages.
        const seqs = await deps.conversations.allocateSeqPair(conversation.id, tx);
        if (seqs === null) {
          throw new AppError('not_found', 'Conversation not found.');
        }

        const now = deps.clock.now();
        const userMessage: Message = {
          id: deps.idGen.uuidv7(),
          conversationId: conversation.id,
          seq: seqs.userSeq,
          role: 'user',
          status: 'complete',
          finishReason: null,
          supersededBy: null,
          metadata: {},
          createdAt: now,
          completedAt: now,
        };
        const userParts: MessagePart[] = textParts.map((part, index) => ({
          id: deps.idGen.uuidv7(),
          messageId: userMessage.id,
          position: index,
          type: 'text',
          status: 'complete',
          textContent: part.text,
          data: {},
          fileId: null,
          createdAt: now,
          updatedAt: now,
        }));

        await deps.conversations.insertMessage(userMessage, tx);
        await deps.conversations.insertParts(userParts, tx);

        // Assistant streaming placeholder.
        const assistantMessage: Message = {
          id: deps.idGen.uuidv7(),
          conversationId: conversation.id,
          seq: seqs.assistantSeq,
          role: 'assistant',
          status: 'streaming',
          finishReason: null,
          supersededBy: null,
          metadata: {},
          createdAt: now,
          completedAt: null,
        };
        await deps.conversations.insertMessage(assistantMessage, tx);

        // Insert generation row before quota reservation.
        let generation: GenerationRecord;
        try {
          generation = await deps.generations.insert(
            {
              id: generationId,
              requestId: input.requestId,
              userId: input.userId,
              conversationId: conversation.id,
              assistantMessageId: assistantMessage.id,
              modelId: model.id,
              providerId: provider.id,
              estInputTokens: built.estimatedTokens,
              maxOutputTokens,
              modelLock: { modelId: model.id, providerId: provider.id, configVersion: null },
              options: input.options ?? {},
              contextInfo: {
                truncated: built.truncation.truncated,
                droppedMessageCount: built.truncation.droppedMessageCount,
              },
            },
            tx,
          );
        } catch (error) {
          if (isUniqueViolationOf(error, 'one_active_generation_per_conversation')) {
            throw new AppError(
              'generation_in_progress',
              'A generation is already running for this conversation.',
            );
          }
          throw error;
        }

        // Quota reservation. Rejection rolls back the transaction.
        const reservation = await deps.quota.reserve(
          {
            userId: input.userId,
            generationId,
            providerId: provider.id,
            modelId: model.id,
            estimatedInputTokens: built.estimatedTokens,
            requestedMaxOutputTokens: maxOutputTokens,
            modelMaxOutputTokens: model.maxOutputTokens,
            quotaWeight: runtime.model.quotaWeight,
            hasMediaParts: newParts.some((part) => part.type !== 'text'),
            maxInputTokensForRequest: runtime.model.capabilities.contextWindow,
          },
          tx,
        );
        // When remaining quota is short, the reservation shrinks the output bound.
        // The provider max_tokens must match so the bound is physically enforced.
        const effectiveMaxOutput =
          reservation.effectiveMaxOutputTokens !== null &&
          reservation.effectiveMaxOutputTokens < maxOutputTokens
            ? reservation.effectiveMaxOutputTokens
            : maxOutputTokens;
        const chatRequest =
          effectiveMaxOutput === maxOutputTokens
            ? built.request
            : { ...built.request, maxOutputTokens: effectiveMaxOutput };
        if (effectiveMaxOutput !== maxOutputTokens) {
          await deps.generations.updateMaxOutputTokens(generation.id, effectiveMaxOutput, tx);
          generation = { ...generation, maxOutputTokens: effectiveMaxOutput };
        }

        // First-message auto-title, only while the title is still the default.
        const firstText = firstUserText(conversation, textParts);
        if (firstText !== null) {
          await deps.conversations.setTitleIfDefault(
            conversation.id,
            deriveTitleFromText(firstText),
            tx,
          );
        }

        enqueuePayload = {
          generation,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          chatRequest,
          contextInfo: {
            truncated: built.truncation.truncated,
            droppedMessageCount: built.truncation.droppedMessageCount,
          },
        };

        const payload: SendMessagePayload = {
          userMessage: toWireMessage(userMessage, userParts),
          assistantMessage: toWireMessage(assistantMessage, [], generationId),
          generation: {
            id: generation.id,
            status: generation.status,
            streamUrl: `/api/generations/${generation.id}/stream`,
          },
          quota:
            reservation.accountId === null
              ? null
              : {
                  reservedTokens: reservation.reservedTokens,
                  remainingTokens: reservation.remainingTokens,
                },
        };

        await deps.generations.storeIdempotentResponse(
          {
            userId: input.userId,
            key: input.idempotencyKey,
            responseStatus: 202,
            responseBody: payload,
          },
          tx,
        );

        return { replayed: false, payload };
      });

      // After commit only: handoff to orchestrator.enqueue() (never inside tx).
      // `enqueue` re-checks the *in-memory* capacity gate, which the DB count above cannot see, so
      // it may still refuse a committed generation. Recover instead of leaving an orphan: finalize
      // the row we just wrote so the conversation is not blocked until the reaper sweeps it.
      const pendingEnqueue: EnqueueGenerationInput | null = enqueuePayload;
      if (!outcome.replayed && deps.orchestrator !== undefined && pendingEnqueue !== null) {
        const pendingGenerationId = outcome.payload.generation.id;
        try {
          deps.orchestrator.enqueue(pendingEnqueue);
        } catch (error) {
          await recoverUnenqueuedGeneration(pendingGenerationId);
          throw error;
        }
      }

      return outcome;
    },

    async retry(input) {
      const conversation = await deps.conversations.findByIdForUser(
        input.conversationId,
        input.userId,
      );
      if (conversation === null) {
        throw new AppError('not_found', 'Conversation not found.');
      }

      const userMsgWithParts = await deps.conversations.findMessageForUser(
        input.userMessageId,
        input.userId,
      );
      if (
        userMsgWithParts === null ||
        userMsgWithParts.message.conversationId !== conversation.id ||
        userMsgWithParts.message.role !== 'user'
      ) {
        throw new AppError('not_found', 'User message not found.');
      }

      const pairedAssistant = await deps.conversations.findPairedAssistantMessage(
        userMsgWithParts.message.seq,
        conversation.id,
      );
      if (pairedAssistant === null) {
        throw new AppError('not_found', 'Paired assistant message not found.');
      }

      const oldAssistant = pairedAssistant.message;
      const isFailedOrCancelled =
        oldAssistant.status === 'failed' ||
        oldAssistant.status === 'incomplete' ||
        oldAssistant.finishReason === 'error' ||
        oldAssistant.finishReason === 'cancelled' ||
        oldAssistant.finishReason === 'timeout' ||
        oldAssistant.finishReason === 'interrupted';

      if (!isFailedOrCancelled) {
        throw new AppError(
          'conflict',
          'Only failed or cancelled assistant messages can be retried.',
        );
      }

      const resolved = await deps.registry.getRuntimeConfig(conversation.modelId);
      if (resolved === null || resolved.provider.status !== 'active' || resolved.model.status !== 'active') {
        throw new AppError('model_unavailable', 'This model is not available.');
      }
      const { model, provider, runtime } = resolved;

      if (deps.orchestrator?.isDraining) {
        throw new AppError('service_busy', 'Server is shutting down.', {
          details: { retryAfterSeconds: 5 },
        });
      }
      const active = await deps.generations.countActiveNodeWide();
      if (active >= deps.config.MAX_ACTIVE_GENERATIONS) {
        throw new AppError('service_busy', undefined, {
          details: { retryAfterSeconds: 5 },
        });
      }

      const userParts: NormalizedPart[] = userMsgWithParts.parts
        .filter((part) => part.type === 'text')
        .map((part) => ({
          type: 'text',
          text: part.textContent ?? '',
        }));

      const requestHash = createHash('sha256')
        .update(JSON.stringify({ retryUserMessageId: input.userMessageId, options: input.options }))
        .digest('hex');

      const generationId = deps.idGen.uuidv7();
      const userIdHash = createHash('sha256').update(input.userId).digest('hex').slice(0, 32);
      let enqueuePayload: EnqueueGenerationInput | null = null;

      const outcome = await withTransaction(async (tx) => {
        const claim = await deps.generations.claimIdempotencyKey(
          {
            userId: input.userId,
            key: input.idempotencyKey,
            endpoint: `POST /api/conversations/:id/messages/${input.userMessageId}/retry`,
            requestHash,
            expiresAt: new Date(deps.clock.now().getTime() + 24 * 60 * 60 * 1000),
          },
          tx,
        );
        if (!claim.claimed) {
          if (claim.stored.requestHash !== requestHash) {
            throw new AppError(
              'idempotency_key_reuse',
              'This idempotency key was used with a different request.',
            );
          }
          if (claim.stored.responseStatus === 0 || !claim.stored.responseBody) {
            throw new AppError(
              'conflict',
              'A generation with this idempotency key is currently in progress.',
            );
          }
          return { replayed: true, payload: claim.stored.responseBody as SendMessagePayload };
        }

        const history = await deps.conversations.listMessagesWithParts(
          { conversationId: conversation.id, limit: 200, before: { seq: userMsgWithParts.message.seq } },
          tx,
        );
        const platformSystemPrompt = await readPlatformSystemPrompt();
        const maxOutputTokens = clampMaxOutputTokens(
          input.options?.maxOutputTokens,
          model.defaultMaxOutputTokens,
          model.maxOutputTokens,
        );
        const built = buildContext({
          requestId: input.requestId,
          generationId,
          model: runtime.model,
          provider: runtime.provider,
          ...(platformSystemPrompt !== undefined ? { platformSystemPrompt } : {}),
          newParts: userParts,
          history: history.items,
          maxOutputTokensOverride: maxOutputTokens,
          userIdHash,
        });

        // Allocate new assistant sequence number.
        const newAssistantSeq = await deps.conversations.allocateSeq(conversation.id, 1, tx);
        if (newAssistantSeq === null) {
          throw new AppError('not_found', 'Conversation not found.');
        }

        const now = deps.clock.now();
        const newAssistantMessage: Message = {
          id: deps.idGen.uuidv7(),
          conversationId: conversation.id,
          seq: newAssistantSeq,
          role: 'assistant',
          status: 'streaming',
          finishReason: null,
          supersededBy: null,
          metadata: {},
          createdAt: now,
          completedAt: null,
        };
        await deps.conversations.insertMessage(newAssistantMessage, tx);

        await deps.conversations.updateMessage(
          oldAssistant.id,
          { supersededBy: newAssistantMessage.id },
          tx,
        );

        let generation: GenerationRecord;
        try {
          generation = await deps.generations.insert(
            {
              id: generationId,
              requestId: input.requestId,
              userId: input.userId,
              conversationId: conversation.id,
              assistantMessageId: newAssistantMessage.id,
              modelId: model.id,
              providerId: provider.id,
              estInputTokens: built.estimatedTokens,
              maxOutputTokens,
              modelLock: { modelId: model.id, providerId: provider.id, configVersion: null },
              options: input.options ?? {},
              contextInfo: {
                truncated: built.truncation.truncated,
                droppedMessageCount: built.truncation.droppedMessageCount,
              },
            },
            tx,
          );
        } catch (error) {
          if (isUniqueViolationOf(error, 'one_active_generation_per_conversation')) {
            throw new AppError(
              'generation_in_progress',
              'A generation is already running for this conversation.',
            );
          }
          throw error;
        }

        // Quota reservation. Rejection rolls back the transaction.
        const reservation = await deps.quota.reserve(
          {
            userId: input.userId,
            generationId,
            providerId: provider.id,
            modelId: model.id,
            estimatedInputTokens: built.estimatedTokens,
            requestedMaxOutputTokens: maxOutputTokens,
            modelMaxOutputTokens: model.maxOutputTokens,
            quotaWeight: runtime.model.quotaWeight,
            hasMediaParts: userParts.some((part) => part.type !== 'text'),
            maxInputTokensForRequest: runtime.model.capabilities.contextWindow,
          },
          tx,
        );
        const effectiveMaxOutput =
          reservation.effectiveMaxOutputTokens !== null &&
          reservation.effectiveMaxOutputTokens < maxOutputTokens
            ? reservation.effectiveMaxOutputTokens
            : maxOutputTokens;
        const chatRequest =
          effectiveMaxOutput === maxOutputTokens
            ? built.request
            : { ...built.request, maxOutputTokens: effectiveMaxOutput };
        if (effectiveMaxOutput !== maxOutputTokens) {
          await deps.generations.updateMaxOutputTokens(generation.id, effectiveMaxOutput, tx);
          generation = { ...generation, maxOutputTokens: effectiveMaxOutput };
        }

        enqueuePayload = {
          generation,
          userMessageId: userMsgWithParts.message.id,
          assistantMessageId: newAssistantMessage.id,
          chatRequest,
          contextInfo: {
            truncated: built.truncation.truncated,
            droppedMessageCount: built.truncation.droppedMessageCount,
          },
        };

        const payload: SendMessagePayload = {
          userMessage: toWireMessage(userMsgWithParts.message, userMsgWithParts.parts),
          assistantMessage: toWireMessage(newAssistantMessage, [], generationId),
          generation: {
            id: generation.id,
            status: generation.status,
            streamUrl: `/api/generations/${generation.id}/stream`,
          },
          quota:
            reservation.accountId === null
              ? null
              : {
                  reservedTokens: reservation.reservedTokens,
                  remainingTokens: reservation.remainingTokens,
                },
        };

        await deps.generations.storeIdempotentResponse(
          {
            userId: input.userId,
            key: input.idempotencyKey,
            responseStatus: 202,
            responseBody: payload,
          },
          tx,
        );

        return { replayed: false, payload };
      });

      const pendingEnqueue: EnqueueGenerationInput | null = enqueuePayload;
      if (!outcome.replayed && deps.orchestrator !== undefined && pendingEnqueue !== null) {
        const pendingGenerationId = outcome.payload.generation.id;
        try {
          deps.orchestrator.enqueue(pendingEnqueue);
        } catch (error) {
          await recoverUnenqueuedGeneration(pendingGenerationId);
          throw error;
        }
      }

      return outcome;
    },
  };
}

function toWireMessage(
  message: Message,
  parts: readonly MessagePart[],
  generationId: string | null = null,
): WireMessage {
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    status: message.status,
    finishReason: message.finishReason,
    createdAt: message.createdAt.toISOString(),
    generationId,
    parts: parts.map((part) => ({
      id: part.id,
      position: part.position,
      type: part.type,
      format: 'markdown',
      text: part.textContent ?? '',
    })),
  };
}

/** Canonical, order-sensitive hash of the fields that define "the same request". */
export function canonicalRequestHash(
  conversationId: string,
  parts: readonly SendPartInput[],
  options: { readonly maxOutputTokens?: number | undefined } | undefined,
): string {
  const canonical = JSON.stringify({
    conversationId,
    parts: parts.map((part) =>
      part.type === 'text' ? { type: 'text', text: part.text } : { type: 'file', fileId: part.fileId },
    ),
    maxOutputTokens: options?.maxOutputTokens ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function clampMaxOutputTokens(
  requested: number | undefined,
  modelDefault: number,
  modelMax: number,
): number {
  const base = requested ?? modelDefault;
  return Math.max(1, Math.min(base, modelMax));
}

/** The auto-title only applies to the conversation's opening turn. */
function firstUserText(
  conversation: Conversation,
  textParts: readonly { readonly type: 'text'; readonly text: string }[],
): string | null {
  if (conversation.messageCount > 0) return null;
  return textParts.map((part) => part.text).join('\n');
}

/**
 * Reads platform system prompt when configured.
 */
async function readPlatformSystemPrompt(): Promise<string | undefined> {
  return undefined;
}
