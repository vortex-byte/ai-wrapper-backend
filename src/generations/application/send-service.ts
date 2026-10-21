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
import type { AttachmentService } from '@/attachments/application/attachment-service.ts';
import type { AttachmentRepository } from '@/attachments/ports/attachment-repository.ts';
import type { Attachment, ResolvedAttachmentPart } from '@/attachments/domain/attachment.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import { validatePartsForModel } from '@/providers/domain/capability-validation.ts';
import type { SettingsService } from '@/settings/application/settings-service.ts';
import type { Finalizer } from './finalizer.ts';

/** Maps attachment-domain resolved parts into normalized PAL parts. */
function toPalParts(parts: readonly ResolvedAttachmentPart[]): NormalizedPart[] {
  return parts.map((part) =>
    part.type === 'image'
      ? { type: 'image', file: part.file }
      : {
          type: 'document',
          file: part.file,
          ...(part.extractedText !== undefined ? { extractedText: part.extractedText } : {}),
          preferNative: part.preferNative,
        },
  );
}

export interface SendMessageDeps {
  readonly conversations: ConversationRepository;
  readonly generations: GenerationRepository;
  readonly quota: QuotaPort;
  readonly registry: ModelRegistry;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
  readonly config: Config;
  readonly orchestrator?: GenerationEnqueuer | undefined;
  readonly attachments?: AttachmentService | undefined;
  readonly attachmentRepo?: AttachmentRepository | undefined;
  readonly finalizer?: Finalizer | undefined;
  readonly settings?: SettingsService | undefined;
}

export type SendPartInput =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'file'; readonly fileId: string };

export interface GenerationOptions {
  readonly maxOutputTokens?: number | undefined;
  readonly tools?: { readonly imageGeneration?: boolean | undefined } | undefined;
}

export interface SendMessageInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly parts: readonly SendPartInput[];
  readonly options?: GenerationOptions | undefined;
}

export interface SendMessagePayload {
  readonly userMessage: WireMessage;
  readonly assistantMessage: WireMessage;
  readonly generation: { readonly id: string; readonly status: string; readonly streamUrl: string };
  readonly quota: {
    readonly reservedTokens: number;
    readonly remainingTokens: number | null;
  } | null;
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
  readonly options?: GenerationOptions | undefined;
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
  /** Finalizes a committed generation that could not be enqueued into the orchestrator. */
  const recoverUnenqueuedGeneration = async (generationId: string): Promise<void> => {
    try {
      await deps.finalizer?.finalize({
        generationId,
        status: 'failed',
        finishReason: 'error',
        accumulatedText: '',
        error: {
          code: 'service_busy',
          message: 'The server could not start this generation.',
          retryable: true,
        },
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

      const fileParts = input.parts.filter(
        (part): part is { type: 'file'; fileId: string } => part.type === 'file',
      );
      if (fileParts.length > 0 && deps.attachments === undefined) {
        throw new AppError('unsupported_for_model', 'File attachments are not supported yet.');
      }

      const wantsImageOutput = input.options?.tools?.imageGeneration === true;
      if (wantsImageOutput && !model.capabilities.imageGeneration) {
        throw new AppError('unsupported_for_model', 'The selected model cannot generate images.');
      }

      let resolvedAttachmentParts: NormalizedPart[] = [];
      let resolvedAttachments: Attachment[] = [];
      const fileIds = fileParts.map((p) => p.fileId);

      if (fileIds.length > 0 && deps.attachments !== undefined) {
        // Pinned to this conversation and to an unbound upload: a file id belonging to another
        // conversation (or already consumed by another message) is refused, never re-bound.
        const resolved = await deps.attachments.resolveParts(fileIds, input.userId, {
          conversationId: input.conversationId,
          requireUnbound: true,
        });
        resolvedAttachmentParts = toPalParts(resolved.parts);
        resolvedAttachments = resolved.attachments;

        const hasImages = resolvedAttachments.some((a) => a.kind === 'image');
        if (hasImages && !model.capabilities.vision) {
          throw new AppError(
            'unsupported_for_model',
            'The selected model does not support image attachments.',
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
      const newParts: NormalizedPart[] = [
        ...textParts.map((part) => ({
          type: 'text' as const,
          text: part.text,
        })),
        ...resolvedAttachmentParts,
      ];

      const capabilityCheck = validatePartsForModel(model.capabilities, newParts);
      if (!capabilityCheck.ok) {
        throw new AppError(
          'unsupported_for_model',
          `Content not supported by model: ${capabilityCheck.violation}`,
          { details: { violation: capabilityCheck.violation } },
        );
      }

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

        // Inside the transaction so history and budgeting read one consistent snapshot.
        const history = await deps.conversations.listMessagesWithParts(
          { conversationId: conversation.id, limit: 200, before: null },
          tx,
        );
        const platformSystemPrompt = await readPlatformSystemPrompt(deps.settings);
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
          ...(wantsImageOutput ? { imageGeneration: true } : {}),
        });

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
        const userParts: MessagePart[] = [];
        let position = 0;
        for (const part of input.parts) {
          if (part.type === 'text') {
            userParts.push({
              id: deps.idGen.uuidv7(),
              messageId: userMessage.id,
              position: position++,
              type: 'text',
              status: 'complete',
              textContent: part.text,
              data: {},
              fileId: null,
              createdAt: now,
              updatedAt: now,
            });
          } else {
            const att = resolvedAttachments.find((a) => a.id === part.fileId);
            userParts.push({
              id: deps.idGen.uuidv7(),
              messageId: userMessage.id,
              position: position++,
              type: att?.kind === 'image' ? 'image' : 'document',
              status: 'complete',
              textContent: null,
              data: att ? { name: att.displayName, mimeType: att.detectedMime } : {},
              fileId: part.fileId,
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        await deps.conversations.insertMessage(userMessage, tx);
        await deps.conversations.insertParts(userParts, tx);
        if (fileIds.length > 0 && deps.attachmentRepo !== undefined) {
          await deps.attachmentRepo.attachToMessage(fileIds, userMessage.id, tx);
        }

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

        // The reservation references the generation row, so it must exist first.
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
              options: toStoredOptions(input.options),
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
            ...(built.request.responseModalities.includes('image')
              ? { imageGeneration: true }
              : {}),
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

        const containerConfig =
          model.capabilities.documentGeneration ||
          (model.config['container'] as boolean | undefined) === true
            ? {
                codeExecution: true,
                skills: (model.config['containerSkills'] as
                  ('pdf' | 'docx' | 'xlsx' | 'pptx')[] | undefined) ?? [
                  'pdf',
                  'docx',
                  'xlsx',
                  'pptx',
                ],
              }
            : undefined;

        const chatRequest: NormalizedChatRequest = {
          ...built.request,
          responseModalities: chatResponseModalities(
            containerConfig !== undefined,
            built.request.responseModalities.includes('image'),
          ),
          ...(effectiveMaxOutput !== maxOutputTokens
            ? { maxOutputTokens: effectiveMaxOutput }
            : {}),
          ...(containerConfig !== undefined ? { container: containerConfig } : {}),
        };
        if (effectiveMaxOutput !== maxOutputTokens) {
          await deps.generations.updateMaxOutputTokens(generation.id, effectiveMaxOutput, tx);
          generation = { ...generation, maxOutputTokens: effectiveMaxOutput };
        }

        const firstText = firstUserText(conversation, textParts);
        if (firstText !== null) {
          await deps.conversations.setTitleIfDefault(
            conversation.id,
            deriveTitleFromText(firstText),
            tx,
          );
        }

        const modelTimeoutMs =
          typeof model.config['timeoutMs'] === 'number' && model.config['timeoutMs'] > 0
            ? (model.config['timeoutMs'] as number)
            : undefined;

        enqueuePayload = {
          generation,
          userMessageId: userMessage.id,
          assistantMessageId: assistantMessage.id,
          chatRequest,
          contextInfo: {
            truncated: built.truncation.truncated,
            droppedMessageCount: built.truncation.droppedMessageCount,
          },
          ...(modelTimeoutMs !== undefined ? { timeoutMs: modelTimeoutMs } : {}),
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

      // After commit only. `enqueue` re-checks the in-memory capacity gate that the DB count
      // cannot see, so it may still refuse a committed generation: finalize that row here instead
      // of leaving the conversation blocked until the reaper sweeps it.
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
      if (
        resolved === null ||
        resolved.provider.status !== 'active' ||
        resolved.model.status !== 'active'
      ) {
        throw new AppError('model_unavailable', 'This model is not available.');
      }
      const { model, provider, runtime } = resolved;

      const wantsImageOutput = input.options?.tools?.imageGeneration === true;
      if (wantsImageOutput && !model.capabilities.imageGeneration) {
        throw new AppError('unsupported_for_model', 'The selected model cannot generate images.');
      }

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

      const fileIdsInRetry = userMsgWithParts.parts
        .map((p) => p.fileId)
        .filter((id): id is string => typeof id === 'string');
      let resolvedFileParts: NormalizedPart[] = [];
      if (fileIdsInRetry.length > 0 && deps.attachments !== undefined) {
        // Retry re-reads the files the original message already carries, so they stay bound;
        // only conversation scoping applies.
        const resolved = await deps.attachments.resolveParts(fileIdsInRetry, input.userId, {
          conversationId: conversation.id,
        });
        resolvedFileParts = toPalParts(resolved.parts);
      }

      const userParts: NormalizedPart[] = [
        ...userMsgWithParts.parts
          .filter((part) => part.type === 'text')
          .map((part) => ({
            type: 'text' as const,
            text: part.textContent ?? '',
          })),
        ...resolvedFileParts,
      ];

      const retryCapabilityCheck = validatePartsForModel(model.capabilities, userParts);
      if (!retryCapabilityCheck.ok) {
        throw new AppError(
          'unsupported_for_model',
          `Content not supported by model: ${retryCapabilityCheck.violation}`,
          { details: { violation: retryCapabilityCheck.violation } },
        );
      }

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
          {
            conversationId: conversation.id,
            limit: 200,
            before: { seq: userMsgWithParts.message.seq },
          },
          tx,
        );
        const platformSystemPrompt = await readPlatformSystemPrompt(deps.settings);
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
          ...(wantsImageOutput ? { imageGeneration: true } : {}),
        });

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
              options: toStoredOptions(input.options),
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

        // Same as above: the reservation references the new generation row.
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
            ...(built.request.responseModalities.includes('image')
              ? { imageGeneration: true }
              : {}),
            maxInputTokensForRequest: runtime.model.capabilities.contextWindow,
          },
          tx,
        );
        const effectiveMaxOutput =
          reservation.effectiveMaxOutputTokens !== null &&
          reservation.effectiveMaxOutputTokens < maxOutputTokens
            ? reservation.effectiveMaxOutputTokens
            : maxOutputTokens;

        const containerConfig =
          model.capabilities.documentGeneration ||
          (model.config['container'] as boolean | undefined) === true
            ? {
                codeExecution: true,
                skills: (model.config['containerSkills'] as
                  ('pdf' | 'docx' | 'xlsx' | 'pptx')[] | undefined) ?? [
                  'pdf',
                  'docx',
                  'xlsx',
                  'pptx',
                ],
              }
            : undefined;

        const chatRequest: NormalizedChatRequest = {
          ...built.request,
          responseModalities: chatResponseModalities(
            containerConfig !== undefined,
            built.request.responseModalities.includes('image'),
          ),
          ...(effectiveMaxOutput !== maxOutputTokens
            ? { maxOutputTokens: effectiveMaxOutput }
            : {}),
          ...(containerConfig !== undefined ? { container: containerConfig } : {}),
        };
        if (effectiveMaxOutput !== maxOutputTokens) {
          await deps.generations.updateMaxOutputTokens(generation.id, effectiveMaxOutput, tx);
          generation = { ...generation, maxOutputTokens: effectiveMaxOutput };
        }

        const modelTimeoutMs =
          typeof model.config['timeoutMs'] === 'number' && model.config['timeoutMs'] > 0
            ? (model.config['timeoutMs'] as number)
            : undefined;

        enqueuePayload = {
          generation,
          userMessageId: userMsgWithParts.message.id,
          assistantMessageId: newAssistantMessage.id,
          chatRequest,
          contextInfo: {
            truncated: built.truncation.truncated,
            droppedMessageCount: built.truncation.droppedMessageCount,
          },
          ...(modelTimeoutMs !== undefined ? { timeoutMs: modelTimeoutMs } : {}),
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
      ...(part.fileId !== null ? { fileId: part.fileId } : {}),
      ...(part.data && Object.keys(part.data).length > 0 ? { data: part.data } : {}),
    })),
  };
}

/** Canonical, order-sensitive hash of the fields that define "the same request". */
export function canonicalRequestHash(
  conversationId: string,
  parts: readonly SendPartInput[],
  options: GenerationOptions | undefined,
): string {
  const canonical = JSON.stringify({
    conversationId,
    parts: parts.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'file', fileId: part.fileId },
    ),
    maxOutputTokens: options?.maxOutputTokens ?? null,
    imageGeneration: options?.tools?.imageGeneration === true,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** Text plus any output modality the provider may also return. */
function chatResponseModalities(
  hasContainer: boolean,
  hasImageOutput: boolean,
): readonly ('text' | 'image' | 'file')[] {
  return [
    'text',
    ...(hasContainer ? (['file'] as const) : []),
    ...(hasImageOutput ? (['image'] as const) : []),
  ];
}

/** `generation_jobs.options` is an open jsonb blob; keep it to the fields we accept. */
function toStoredOptions(
  options: GenerationOptions | undefined,
): Readonly<Record<string, unknown>> {
  if (options === undefined) return {};
  return {
    ...(options.maxOutputTokens !== undefined ? { maxOutputTokens: options.maxOutputTokens } : {}),
    ...(options.tools !== undefined ? { tools: { ...options.tools } } : {}),
  };
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

async function readPlatformSystemPrompt(settings?: SettingsService): Promise<string | undefined> {
  if (!settings) return undefined;
  const setting = await settings.get<string>('system.prompt');
  return setting?.value && typeof setting.value === 'string' && setting.value.trim().length > 0
    ? setting.value.trim()
    : undefined;
}
