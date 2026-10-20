import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { conversations, generationJobs, messageParts, messages } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import type {
  Conversation,
  FinishReason,
  Message,
  MessagePart,
  MessageRole,
  MessageStatus,
  MessageWithParts,
  PartStatus,
  PartType,
} from '../domain/conversation.ts';
import type {
  ConversationRepository,
  CreateConversationInput,
  ListConversationsQuery,
  ListMessagesQuery,
} from '../ports/conversation-repository.ts';

const conversationColumns = {
  id: conversations.id,
  userId: conversations.userId,
  modelId: conversations.modelId,
  title: conversations.title,
  messageCount: conversations.messageCount,
  lastMessageAt: conversations.lastMessageAt,
  createdAt: conversations.createdAt,
  updatedAt: conversations.updatedAt,
  deletedAt: conversations.deletedAt,
} as const;

const messageColumns = {
  id: messages.id,
  conversationId: messages.conversationId,
  seq: messages.seq,
  role: messages.role,
  status: messages.status,
  finishReason: messages.finishReason,
  supersededBy: messages.supersededBy,
  metadata: messages.metadata,
  createdAt: messages.createdAt,
  completedAt: messages.completedAt,
} as const;

const partColumns = {
  id: messageParts.id,
  messageId: messageParts.messageId,
  position: messageParts.position,
  type: messageParts.type,
  status: messageParts.status,
  textContent: messageParts.textContent,
  data: messageParts.data,
  fileId: messageParts.fileId,
  createdAt: messageParts.createdAt,
  updatedAt: messageParts.updatedAt,
} as const;

interface ConversationRow {
  id: string;
  userId: string;
  modelId: string;
  title: string;
  messageCount: number;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

interface MessageRow {
  id: string;
  conversationId: string;
  seq: number;
  role: string;
  status: string;
  finishReason: string | null;
  supersededBy: string | null;
  metadata: unknown;
  createdAt: Date;
  completedAt: Date | null;
  generationId?: string | null | undefined;
}

interface PartRow {
  id: string;
  messageId: string;
  position: number;
  type: string;
  status: string;
  textContent: string | null;
  data: unknown;
  fileId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    userId: row.userId,
    modelId: row.modelId,
    title: row.title,
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: Number(row.seq),
    role: row.role as MessageRole,
    status: row.status as MessageStatus,
    finishReason: row.finishReason as FinishReason | null,
    supersededBy: row.supersededBy,
    metadata: {
      ...((row.metadata ?? {}) as Record<string, unknown>),
      ...(row.generationId ? { generationId: row.generationId } : {}),
    },
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

function toPart(row: PartRow): MessagePart {
  return {
    id: row.id,
    messageId: row.messageId,
    position: row.position,
    type: row.type as PartType,
    status: row.status as PartStatus,
    textContent: row.textContent,
    data: (row.data ?? {}) as Record<string, unknown>,
    fileId: row.fileId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The effective sort key: last activity, falling back to creation time. */
const sortKey = sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})`;

export class DrizzleConversationRepository implements ConversationRepository {
  async listByUser(
    query: ListConversationsQuery,
    tx?: TransactionContext,
  ): Promise<{ items: Conversation[]; hasMore: boolean }> {
    const conditions = [eq(conversations.userId, query.userId), isNull(conversations.deletedAt)];

    if (query.cursor !== null) {
      const keyset = or(
        lt(sortKey, query.cursor.date),
        and(eq(sortKey, query.cursor.date), lt(conversations.id, query.cursor.id)),
      );
      if (keyset) conditions.push(keyset);
    }

    const rows = await runDb(tx)
      .select(conversationColumns)
      .from(conversations)
      .where(and(...conditions))
      .orderBy(desc(sortKey), desc(conversations.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const itemRows = hasMore ? rows.slice(0, query.limit) : rows;
    return { items: itemRows.map(toConversation), hasMore };
  }

  async findByIdForUser(
    id: string,
    userId: string,
    tx?: TransactionContext,
  ): Promise<Conversation | null> {
    const rows = await runDb(tx)
      .select(conversationColumns)
      .from(conversations)
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.userId, userId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async findById(id: string, tx?: TransactionContext): Promise<Conversation | null> {
    const rows = await runDb(tx)
      .select(conversationColumns)
      .from(conversations)
      .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
      .limit(1);
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async create(input: CreateConversationInput, tx?: TransactionContext): Promise<Conversation> {
    const rows = await runDb(tx)
      .insert(conversations)
      .values({
        id: input.id,
        userId: input.userId,
        modelId: input.modelId,
        title: input.title,
      })
      .returning(conversationColumns);
    const row = rows[0];
    if (!row) throw new Error('insert into conversations returned no row');
    return toConversation(row);
  }

  async rename(
    id: string,
    userId: string,
    title: string,
    tx?: TransactionContext,
  ): Promise<Conversation | null> {
    const rows = await runDb(tx)
      .update(conversations)
      .set({ title, updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.userId, userId),
          isNull(conversations.deletedAt),
        ),
      )
      .returning(conversationColumns);
    return rows[0] ? toConversation(rows[0]) : null;
  }

  async softDelete(id: string, userId: string, tx?: TransactionContext): Promise<boolean> {
    const rows = await runDb(tx)
      .update(conversations)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(conversations.id, id),
          eq(conversations.userId, userId),
          isNull(conversations.deletedAt),
        ),
      )
      .returning({ id: conversations.id });
    return rows.length > 0;
  }

  async allocateSeqPair(
    conversationId: string,
    tx?: TransactionContext,
  ): Promise<{ userSeq: number; assistantSeq: number } | null> {
    const rows = await runDb(tx)
      .update(conversations)
      .set({
        messageCount: sql`${conversations.messageCount} + 2`,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt)))
      .returning({ messageCount: conversations.messageCount });
    const row = rows[0];
    if (!row) return null;
    const assistantSeq = row.messageCount;
    return { userSeq: assistantSeq - 1, assistantSeq };
  }

  async allocateSeq(
    conversationId: string,
    increment = 1,
    tx?: TransactionContext,
  ): Promise<number | null> {
    const rows = await runDb(tx)
      .update(conversations)
      .set({
        messageCount: sql`${conversations.messageCount} + ${increment}`,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(conversations.id, conversationId), isNull(conversations.deletedAt)))
      .returning({ messageCount: conversations.messageCount });
    const row = rows[0];
    return row ? row.messageCount : null;
  }

  async setTitleIfDefault(
    id: string,
    title: string,
    tx?: TransactionContext,
  ): Promise<void> {
    await runDb(tx)
      .update(conversations)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(conversations.id, id), eq(conversations.title, 'New conversation')));
  }

  async insertMessage(message: Message, tx?: TransactionContext): Promise<Message> {
    const rows = await runDb(tx)
      .insert(messages)
      .values({
        id: message.id,
        conversationId: message.conversationId,
        seq: message.seq,
        role: message.role,
        status: message.status,
        finishReason: message.finishReason,
        supersededBy: message.supersededBy,
        metadata: message.metadata as Record<string, unknown>,
        createdAt: message.createdAt,
        completedAt: message.completedAt,
      })
      .returning(messageColumns);
    const row = rows[0];
    if (!row) throw new Error('insert into messages returned no row');
    return toMessage(row);
  }

  async updateMessage(
    id: string,
    updates: {
      readonly status?: MessageStatus | undefined;
      readonly finishReason?: FinishReason | null | undefined;
      readonly supersededBy?: string | null | undefined;
      readonly completedAt?: Date | null | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    },
    tx?: TransactionContext,
  ): Promise<void> {
    const values: Record<string, unknown> = {};
    if (updates.status !== undefined) values['status'] = updates.status;
    if (updates.finishReason !== undefined) values['finishReason'] = updates.finishReason;
    if (updates.supersededBy !== undefined) values['supersededBy'] = updates.supersededBy;
    if (updates.completedAt !== undefined) values['completedAt'] = updates.completedAt;
    if (updates.metadata !== undefined) values['metadata'] = updates.metadata;

    if (Object.keys(values).length === 0) return;

    await runDb(tx)
      .update(messages)
      .set(values)
      .where(eq(messages.id, id));
  }

  async insertParts(parts: readonly MessagePart[], tx?: TransactionContext): Promise<void> {
    if (parts.length === 0) return;
    await runDb(tx)
      .insert(messageParts)
      .values(
        parts.map((part) => ({
          id: part.id,
          messageId: part.messageId,
          position: part.position,
          type: part.type,
          status: part.status,
          textContent: part.textContent,
          data: part.data as Record<string, unknown>,
          fileId: part.fileId,
          createdAt: part.createdAt,
          updatedAt: part.updatedAt,
        })),
      );
  }

  async updatePart(
    id: string,
    updates: {
      readonly status?: PartStatus | undefined;
      readonly textContent?: string | undefined;
    },
    tx?: TransactionContext,
  ): Promise<void> {
    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (updates.status !== undefined) values['status'] = updates.status;
    if (updates.textContent !== undefined) values['textContent'] = updates.textContent;

    await runDb(tx)
      .update(messageParts)
      .set(values)
      .where(eq(messageParts.id, id));
  }

  async attachPartFile(
    partId: string,
    fileId: string,
    tx?: TransactionContext,
  ): Promise<void> {
    await runDb(tx)
      .update(messageParts)
      .set({ fileId, status: 'complete', updatedAt: new Date() })
      .where(eq(messageParts.id, partId));
  }

  async appendPartText(
    partId: string,
    chunk: string,
    tx?: TransactionContext,
  ): Promise<void> {
    if (chunk.length === 0) return;
    await runDb(tx)
      .update(messageParts)
      .set({
        textContent: sql`COALESCE(${messageParts.textContent}, '') || ${chunk}`,
        updatedAt: new Date(),
      })
      .where(eq(messageParts.id, partId));
  }

  async listMessagesWithParts(
    query: ListMessagesQuery,
    tx?: TransactionContext,
  ): Promise<{ items: MessageWithParts[]; hasMore: boolean }> {
    const conditions = [
      eq(messages.conversationId, query.conversationId),
      isNull(messages.supersededBy),
    ];
    if (query.before !== null) {
      conditions.push(lt(messages.seq, query.before.seq));
    }

    const messageRows = await runDb(tx)
      .select({
        ...messageColumns,
        generationId: generationJobs.id,
      })
      .from(messages)
      .leftJoin(generationJobs, eq(generationJobs.assistantMessageId, messages.id))
      .where(and(...conditions))
      .orderBy(desc(messages.seq))
      .limit(query.limit + 1);

    const hasMore = messageRows.length > query.limit;
    const pageRows = hasMore ? messageRows.slice(0, query.limit) : messageRows;
    if (pageRows.length === 0) return { items: [], hasMore: false };

    const ids = pageRows.map((row) => row.id);
    const partRows = await runDb(tx)
      .select(partColumns)
      .from(messageParts)
      .where(inArray(messageParts.messageId, ids))
      .orderBy(messageParts.messageId, messageParts.position);

    const partsByMessage = new Map<string, MessagePart[]>();
    for (const row of partRows) {
      const list = partsByMessage.get(row.messageId) ?? [];
      list.push(toPart(row));
      partsByMessage.set(row.messageId, list);
    }

    const items = pageRows
      .slice()
      .reverse()
      .map((row) => ({
        message: toMessage(row),
        parts: partsByMessage.get(row.id) ?? [],
      }));

    return { items, hasMore };
  }

  async findMessageForUser(
    messageId: string,
    userId: string,
    tx?: TransactionContext,
  ): Promise<MessageWithParts | null> {
    const rows = await runDb(tx)
      .select({
        ...messageColumns,
        generationId: generationJobs.id,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .leftJoin(generationJobs, eq(generationJobs.assistantMessageId, messages.id))
      .where(
        and(
          eq(messages.id, messageId),
          eq(conversations.userId, userId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1);
    const messageRow = rows[0];
    if (!messageRow) return null;

    const partRows = await runDb(tx)
      .select(partColumns)
      .from(messageParts)
      .where(eq(messageParts.messageId, messageId))
      .orderBy(messageParts.position);

    return { message: toMessage(messageRow), parts: partRows.map(toPart) };
  }

  async findPairedAssistantMessage(
    userMessageSeq: number,
    conversationId: string,
    tx?: TransactionContext,
  ): Promise<MessageWithParts | null> {
    const rows = await runDb(tx)
      .select({
        ...messageColumns,
        supersededBy: messages.supersededBy,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.role, 'assistant'),
          eq(messages.seq, userMessageSeq + 1),
        ),
      );

    let current: (typeof rows)[number] | undefined = rows[0];
    if (current === undefined) return null;

    const byId = new Map<string, (typeof rows)[number]>();
    const chainRows = await runDb(tx)
      .select({
        ...messageColumns,
        supersededBy: messages.supersededBy,
      })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.role, 'assistant')))
      .orderBy(messages.seq);

    for (const row of chainRows) {
      byId.set(row.id, row);
    }

    const guard = new Set<string>();
    while (current.supersededBy !== null && !guard.has(current.supersededBy)) {
      guard.add(current.supersededBy);
      const next = byId.get(current.supersededBy);
      if (next === undefined) break;
      current = next;
    }

    const messageRow = current;

    const detailRows = await runDb(tx)
      .select({
        ...messageColumns,
        generationId: generationJobs.id,
      })
      .from(messages)
      .leftJoin(generationJobs, eq(generationJobs.assistantMessageId, messages.id))
      .where(eq(messages.id, messageRow.id))
      .limit(1);

    const resolved = detailRows[0] ?? messageRow;

    const partRows = await runDb(tx)
      .select(partColumns)
      .from(messageParts)
      .where(eq(messageParts.messageId, resolved.id))
      .orderBy(messageParts.position);

    return { message: toMessage(resolved), parts: partRows.map(toPart) };
  }

  async countMessages(conversationId: string, tx?: TransactionContext): Promise<number> {
    const rows = await runDb(tx)
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    return rows[0]?.count ?? 0;
  }
}
