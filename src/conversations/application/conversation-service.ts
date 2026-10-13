import type { Clock, IdGenerator } from '@/clock/index.ts';
import { AppError } from '@/errors.ts';
import { encodeSeqCursor, encodeTimestampCursor } from '@/cursor.ts';
import {
  DEFAULT_CONVERSATION_TITLE,
  deriveTitleFromText,
  MAX_TITLE_LENGTH,
  type Conversation,
  type MessageWithParts,
} from '../domain/conversation.ts';
import type {
  ConversationRepository,
  ListConversationsQuery,
  ListMessagesQuery,
} from '../ports/conversation-repository.ts';
import type { ModelRecord } from '@/providers/domain/registry.ts';
import type { ModelRegistry } from '@/providers/ports/model-registry.ts';

export interface ConversationDeps {
  readonly repository: ConversationRepository;
  readonly registry: ModelRegistry;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
}

export interface CreateConversationInput {
  readonly userId: string;
  readonly modelId: string;
  readonly title?: string | null;
}

export interface ListConversationsInput {
  readonly userId: string;
  readonly limit: number;
  readonly cursor: { readonly date: Date; readonly id: string } | null;
}

export interface ConversationPage {
  readonly items: readonly Conversation[];
  readonly nextCursor: string | null;
}

export interface MessagePage {
  readonly items: readonly MessageWithParts[];
  readonly nextCursor: string | null;
}

export interface ConversationService {
  create(input: CreateConversationInput): Promise<Conversation>;
  list(input: ListConversationsInput): Promise<ConversationPage>;
  get(id: string, userId: string): Promise<Conversation>;
  rename(id: string, userId: string, title: string): Promise<Conversation>;
  remove(id: string, userId: string): Promise<void>;
  listMessages(input: {
    conversationId: string;
    userId: string;
    limit: number;
    before: { readonly seq: number } | null;
  }): Promise<MessagePage>;
}

export function createConversationService(deps: ConversationDeps): ConversationService {
  /** Resolve a model the caller may start a conversation on, or `null`. */
  async function resolveNewConversationModel(modelId: string): Promise<ModelRecord | null> {
    const model = await deps.registry.getModel(modelId);
    if (model === null) return null;
    const provider = await deps.registry.getProvider(model.providerId);
    if (provider === null || provider.status !== 'active') return null;
    if (model.status !== 'active') return null;
    return model;
  }

  async function requireConversation(id: string, userId: string): Promise<Conversation> {
    const conversation = await deps.repository.findByIdForUser(id, userId);
    if (conversation === null) {
      throw new AppError('not_found', 'Conversation not found.');
    }
    return conversation;
  }

  return {
    async create(input) {
      const model = await resolveNewConversationModel(input.modelId);
      if (model === null) {
        throw new AppError('model_unavailable', 'This model is not available.');
      }
      const rawTitle = input.title?.trim();
      const title = rawTitle && rawTitle.length > 0 ? rawTitle : DEFAULT_CONVERSATION_TITLE;
      if (title.length > MAX_TITLE_LENGTH) {
        throw new AppError('invalid_request', 'The title is too long.', {
          details: { fields: [{ field: 'title', message: `At most ${MAX_TITLE_LENGTH} characters.` }] },
        });
      }
      return deps.repository.create({
        id: deps.idGen.uuidv7(),
        userId: input.userId,
        modelId: model.id,
        title,
      });
    },

    async list(input) {
      const query: ListConversationsQuery = {
        userId: input.userId,
        limit: input.limit,
        cursor: input.cursor,
      };
      const { items, hasMore } = await deps.repository.listByUser(query);
      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last !== undefined
          ? encodeConversationCursor(last)
          : null;
      return { items, nextCursor };
    },

    async get(id, userId) {
      return requireConversation(id, userId);
    },

    async rename(id, userId, title) {
      const trimmed = title.trim();
      if (trimmed.length === 0 || trimmed.length > MAX_TITLE_LENGTH) {
        throw new AppError('invalid_request', 'The title is invalid.', {
          details: {
            fields: [{ field: 'title', message: `Provide 1–${MAX_TITLE_LENGTH} characters.` }],
          },
        });
      }
      await requireConversation(id, userId);
      const updated = await deps.repository.rename(id, userId, trimmed);
      if (updated === null) throw new AppError('not_found', 'Conversation not found.');
      return updated;
    },

    async remove(id, userId) {
      await requireConversation(id, userId);
      const deleted = await deps.repository.softDelete(id, userId);
      if (!deleted) throw new AppError('not_found', 'Conversation not found.');
    },

    async listMessages(input) {
      await requireConversation(input.conversationId, input.userId);
      const query: ListMessagesQuery = {
        conversationId: input.conversationId,
        limit: input.limit,
        before: input.before,
      };
      const { items, hasMore } = await deps.repository.listMessagesWithParts(query);
      const oldest = items[0];
      const nextCursor = hasMore && oldest !== undefined ? encodeMessageCursor(oldest) : null;
      return { items, nextCursor };
    },
  };
}

function encodeConversationCursor(conversation: Conversation): string {
  const sortDate = conversation.lastMessageAt ?? conversation.createdAt;
  return encodeTimestampCursor(sortDate, conversation.id);
}

function encodeMessageCursor(item: MessageWithParts): string {
  return encodeSeqCursor(item.message.seq, item.message.id);
}

export { deriveTitleFromText };
