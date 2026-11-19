import { createHash } from 'node:crypto';
import type { Clock, IdGenerator } from '@/clock/index.ts';
import { withTransaction } from '@/db/tx.ts';
import { AppError } from '@/errors.ts';
import type { ConversationRepository } from '@/conversations/ports/conversation-repository.ts';
import type { Message, MessagePart } from '@/conversations/domain/conversation.ts';
import { deriveTitleFromText } from '@/conversations/domain/conversation.ts';
import type { ModelRegistry } from '@/providers/ports/model-registry.ts';
import { isLocalAdapter } from '@/providers/domain/local-model.ts';
import type { GenerationRepository } from '../ports/generation-repository.ts';
import { toWireMessage, type WireMessage } from './wire-message.ts';

/**
 * Persistence for browser-executed ("local") turns. The SPA runs the model with WebLLM and
 * posts the finished turn back; the server stores it without a generation, a quota
 * reservation, a usage event, or a ledger entry.
 */

export interface LocalTextPartInput {
  readonly type: 'text';
  readonly text: string;
}

export interface LocalClientUsage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
}

export interface LocalUserTurnInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly idempotencyKey: string;
  readonly parts: readonly LocalTextPartInput[];
}

export interface LocalReplyInput {
  readonly userId: string;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly idempotencyKey: string;
  readonly parts: readonly LocalTextPartInput[];
  readonly finishReason: 'stop' | 'length';
  readonly clientUsage?: LocalClientUsage | undefined;
}

export interface LocalUserTurnPayload {
  readonly userMessage: WireMessage;
}

export interface LocalReplyPayload {
  readonly assistantMessage: WireMessage;
}

export interface LocalOutcome<TPayload> {
  readonly replayed: boolean;
  readonly payload: TPayload;
}

export interface ClientMessageService {
  saveUserTurn(input: LocalUserTurnInput): Promise<LocalOutcome<LocalUserTurnPayload>>;
  saveReply(input: LocalReplyInput): Promise<LocalOutcome<LocalReplyPayload>>;
}

export interface ClientMessageDeps {
  readonly conversations: ConversationRepository;
  readonly generations: GenerationRepository;
  readonly registry: ModelRegistry;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
}

const USER_TURN_ENDPOINT = 'POST /api/conversations/:id/messages/local';
const LOCAL_REPLY_ENDPOINT = 'POST /api/conversations/:id/messages/:mid/local-reply';

export function createClientMessageService(deps: ClientMessageDeps): ClientMessageService {
  /** The conversation must exist, be owned by the caller, and run a browser-executed model. */
  async function requireLocalConversation(userId: string, conversationId: string) {
    const conversation = await deps.conversations.findByIdForUser(conversationId, userId);
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
    if (!isLocalAdapter(resolved.provider.adapter)) {
      throw new AppError(
        'unsupported_for_model',
        'This model does not run in the browser.',
      );
    }
    return conversation;
  }

  function assertTextOnly(parts: readonly LocalTextPartInput[]): string {
    if (parts.length === 0) {
      throw new AppError('invalid_request', 'A message needs at least one text part.');
    }
    const texts: string[] = [];
    for (const part of parts) {
      if (part.type !== 'text') {
        throw new AppError('invalid_request', 'Local messages carry text only.', {
          details: { fields: [{ field: 'parts', message: 'Text parts only.' }] },
        });
      }
      if (part.text.trim().length === 0) {
        throw new AppError('invalid_request', 'A message needs at least one non-empty text part.');
      }
      texts.push(part.text);
    }
    const contentChars = texts.reduce((total, text) => total + text.length, 0);
    if (contentChars > MAX_LOCAL_CONTENT_CHARS) {
      throw new AppError('invalid_request', 'The message is too long.');
    }
    return texts.join('\n');
  }

  function textParts(
    message: Message,
    texts: readonly string[],
    now: Date,
  ): MessagePart[] {
    return texts.map((text, index) => ({
      id: deps.idGen.uuidv7(),
      messageId: message.id,
      position: index,
      type: 'text',
      status: 'complete',
      textContent: text,
      data: {},
      fileId: null,
      createdAt: now,
      updatedAt: now,
    }));
  }

  function requestHash(fields: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  }

  return {
    async saveUserTurn(input) {
      const conversation = await requireLocalConversation(input.userId, input.conversationId);
      const text = assertTextOnly(input.parts);
      const hash = requestHash({
        conversationId: input.conversationId,
        parts: input.parts.map((part) => ({ type: part.type, text: part.text })),
      });

      return withTransaction(async (tx) => {
        const claim = await deps.generations.claimIdempotencyKey(
          {
            userId: input.userId,
            key: input.idempotencyKey,
            endpoint: USER_TURN_ENDPOINT,
            requestHash: hash,
            expiresAt: new Date(deps.clock.now().getTime() + 24 * 60 * 60 * 1000),
          },
          tx,
        );
        if (!claim.claimed) {
          if (claim.stored.requestHash !== hash) {
            throw new AppError(
              'idempotency_key_reuse',
              'This idempotency key was used with a different request.',
            );
          }
          if (claim.stored.responseStatus === 0 || !claim.stored.responseBody) {
            throw new AppError(
              'conflict',
              'This turn is currently being saved. Try again shortly.',
            );
          }
          return {
            replayed: true,
            payload: claim.stored.responseBody as LocalUserTurnPayload,
          };
        }

        const seq = await deps.conversations.allocateSeq(conversation.id, 1, tx);
        if (seq === null) {
          throw new AppError('not_found', 'Conversation not found.');
        }

        const now = deps.clock.now();
        const message: Message = {
          id: deps.idGen.uuidv7(),
          conversationId: conversation.id,
          seq,
          role: 'user',
          status: 'complete',
          finishReason: null,
          supersededBy: null,
          metadata: { execution: 'client' },
          createdAt: now,
          completedAt: now,
        };
        const parts = textParts(message, input.parts.map((part) => part.text), now);

        await deps.conversations.insertMessage(message, tx);
        await deps.conversations.insertParts(parts, tx);

        if (conversation.messageCount === 0) {
          await deps.conversations.setTitleIfDefault(
            conversation.id,
            deriveTitleFromText(text),
            tx,
          );
        }

        const payload: LocalUserTurnPayload = {
          userMessage: toWireMessage(message, parts, null),
        };
        await deps.generations.storeIdempotentResponse(
          {
            userId: input.userId,
            key: input.idempotencyKey,
            responseStatus: 201,
            responseBody: payload,
          },
          tx,
        );
        return { replayed: false, payload };
      });
    },

    async saveReply(input) {
      const conversation = await requireLocalConversation(input.userId, input.conversationId);
      assertTextOnly(input.parts);
      const hash = requestHash({
        conversationId: input.conversationId,
        userMessageId: input.userMessageId,
        parts: input.parts.map((part) => ({ type: part.type, text: part.text })),
        finishReason: input.finishReason,
      });

      return withTransaction(async (tx) => {
        const claim = await deps.generations.claimIdempotencyKey(
          {
            userId: input.userId,
            key: input.idempotencyKey,
            endpoint: LOCAL_REPLY_ENDPOINT,
            requestHash: hash,
            expiresAt: new Date(deps.clock.now().getTime() + 24 * 60 * 60 * 1000),
          },
          tx,
        );
        if (!claim.claimed) {
          if (claim.stored.requestHash !== hash) {
            throw new AppError(
              'idempotency_key_reuse',
              'This idempotency key was used with a different request.',
            );
          }
          if (claim.stored.responseStatus === 0 || !claim.stored.responseBody) {
            throw new AppError(
              'conflict',
              'This reply is currently being saved. Try again shortly.',
            );
          }
          return {
            replayed: true,
            payload: claim.stored.responseBody as LocalReplyPayload,
          };
        }

        // The reply must answer the newest turn: a delayed reply would otherwise reorder history.
        const latest = await deps.conversations.listMessagesWithParts(
          { conversationId: conversation.id, limit: 1, before: null },
          tx,
        );
        const latestMessage = latest.items[0]?.message;
        if (
          latestMessage === undefined ||
          latestMessage.id !== input.userMessageId ||
          latestMessage.role !== 'user'
        ) {
          throw new AppError(
            'conflict',
            'The user turn is no longer the latest message in this conversation.',
          );
        }

        const seq = await deps.conversations.allocateSeq(conversation.id, 1, tx);
        if (seq === null) {
          throw new AppError('not_found', 'Conversation not found.');
        }

        const now = deps.clock.now();
        const message: Message = {
          id: deps.idGen.uuidv7(),
          conversationId: conversation.id,
          seq,
          role: 'assistant',
          status: 'complete',
          finishReason: input.finishReason,
          supersededBy: null,
          metadata: {
            execution: 'client',
            ...(input.clientUsage !== undefined ? { local: { clientUsage: input.clientUsage } } : {}),
          },
          createdAt: now,
          completedAt: now,
        };
        const parts = textParts(message, input.parts.map((part) => part.text), now);

        await deps.conversations.insertMessage(message, tx);
        await deps.conversations.insertParts(parts, tx);

        const payload: LocalReplyPayload = {
          assistantMessage: toWireMessage(message, parts, null),
        };
        await deps.generations.storeIdempotentResponse(
          {
            userId: input.userId,
            key: input.idempotencyKey,
            responseStatus: 201,
            responseBody: payload,
          },
          tx,
        );
        return { replayed: false, payload };
      });
    },
  };
}

/** Mirrors the server send path's content cap so both paths reject the same oversized turn. */
const MAX_LOCAL_CONTENT_CHARS = 200_000;
