import type { TransactionContext } from '@/db/tx.ts';
import type {
  Conversation,
  FinishReason,
  Message,
  MessagePart,
  MessageStatus,
  MessageWithParts,
  PartStatus,
} from '../domain/conversation.ts';

/**
 * Persistence port for conversations, messages and parts. Writes take the transaction handle
 * so create operations and read paths share one connection. Every read is scoped to `user_id`
 * in the caller or the repository — cross-user access surfaces as "not found".
 */

export interface ListConversationsQuery {
  readonly userId: string;
  readonly limit: number;
  readonly cursor: { readonly date: Date; readonly id: string } | null;
}

export interface CreateConversationInput {
  readonly id: string;
  readonly userId: string;
  readonly modelId: string;
  readonly title: string;
}

export interface ListMessagesQuery {
  readonly conversationId: string;
  readonly limit: number;
  /** Exclusive upper bound (`seq < before`); `null` means the newest page. */
  readonly before: { readonly seq: number } | null;
}

export interface ConversationRepository {
  listByUser(
    query: ListConversationsQuery,
    tx?: TransactionContext,
  ): Promise<{ items: Conversation[]; hasMore: boolean }>;

  /** Scoped to the owner; another user's id returns `null` (mapped to 404). */
  findByIdForUser(
    id: string,
    userId: string,
    tx?: TransactionContext,
  ): Promise<Conversation | null>;

  /** Unscoped lookup for the orchestrator (it has already authorized the caller). */
  findById(id: string, tx?: TransactionContext): Promise<Conversation | null>;

  create(input: CreateConversationInput, tx?: TransactionContext): Promise<Conversation>;

  rename(
    id: string,
    userId: string,
    title: string,
    tx?: TransactionContext,
  ): Promise<Conversation | null>;

  softDelete(id: string, userId: string, tx?: TransactionContext): Promise<boolean>;

  /**
   * Allocates `message_count + 2` and returns both sequence numbers (user then assistant).
   * The `UPDATE ... RETURNING` row lock serializes concurrent sends per conversation.
   */
  allocateSeqPair(
    conversationId: string,
    tx?: TransactionContext,
  ): Promise<{ userSeq: number; assistantSeq: number } | null>;

  /** Bump the title only when it is still the default (first-message auto-title). */
  setTitleIfDefault(
    id: string,
    title: string,
    tx?: TransactionContext,
  ): Promise<void>;

  /** Single-turn sequence allocator (e.g. for retrying an assistant message). */
  allocateSeq(
    conversationId: string,
    increment?: number,
    tx?: TransactionContext,
  ): Promise<number | null>;

  insertMessage(message: Message, tx?: TransactionContext): Promise<Message>;

  updateMessage(
    id: string,
    updates: {
      readonly status?: MessageStatus | undefined;
      readonly finishReason?: FinishReason | null | undefined;
      readonly supersededBy?: string | null | undefined;
      readonly completedAt?: Date | null | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    },
    tx?: TransactionContext,
  ): Promise<void>;

  insertParts(parts: readonly MessagePart[], tx?: TransactionContext): Promise<void>;

  updatePart(
    id: string,
    updates: {
      readonly status?: PartStatus | undefined;
      readonly textContent?: string | undefined;
    },
    tx?: TransactionContext,
  ): Promise<void>;

  /**
   * Attaches a stored binary to a part and marks it complete — the ArtifactSink's final step
   * (persist-before-expose: the `file_id` only exists once the bytes are safely in storage).
   */
  attachPartFile(
    partId: string,
    fileId: string,
    tx?: TransactionContext,
  ): Promise<void>;

  appendPartText(
    partId: string,
    chunk: string,
    tx?: TransactionContext,
  ): Promise<void>;

  listMessagesWithParts(
    query: ListMessagesQuery,
    tx?: TransactionContext,
  ): Promise<{ items: MessageWithParts[]; hasMore: boolean }>;

  findMessageForUser(
    messageId: string,
    userId: string,
    tx?: TransactionContext,
  ): Promise<MessageWithParts | null>;

  findPairedAssistantMessage(
    userMessageSeq: number,
    conversationId: string,
    tx?: TransactionContext,
  ): Promise<MessageWithParts | null>;

  countMessages(conversationId: string, tx?: TransactionContext): Promise<number>;

  findPurgeableIds(
    cutoff: Date,
    limit: number,
    tx?: TransactionContext,
  ): Promise<readonly string[]>;

  attachmentStorageKeysFor(
    conversationIds: readonly string[],
    tx?: TransactionContext,
  ): Promise<readonly { readonly conversationId: string; readonly storageKey: string }[]>;

  hardDelete(ids: readonly string[], tx?: TransactionContext): Promise<number>;
}
