import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleConversationRepository } from '@/conversations/infrastructure/drizzle-conversation-repository.ts';
import { closePool, getPool } from '@/db/index.ts';
import { createConversationPurgeHandler } from '@/jobs/application/handlers/conversation-purge-handler.ts';
import { resetDatabase } from './helpers/reset.ts';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const conversations = new DrizzleConversationRepository();

interface SeededConversation {
  readonly conversationId: string;
  readonly messageId: string;
  readonly storageKey: string;
}

async function seedConversation(deletedDaysAgo: number | null): Promise<SeededConversation> {
  const pool = getPool();
  const userId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO users (id, email, display_name, password_hash)
     VALUES ($1, $2, 'Purge User', 'not-used')`,
    [userId, `purge-${userId}@corp.example`],
  );

  const providerId = Bun.randomUUIDv7();
  const modelId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref)
     VALUES ($1, $2, 'Purge Provider', 'openai', 'TEST_API_KEY')`,
    [providerId, `purge-${providerId}`],
  );
  await pool.query(
    `INSERT INTO ai_models
       (id, provider_id, key, api_model_id, display_name, status, capabilities,
        context_window, max_output_tokens, default_max_output_tokens)
     VALUES ($1, $2, $3, 'purge-model-1', 'Purge Model', 'active', '{"schemaVersion":1}',
             128000, 4096, 1024)`,
    [modelId, providerId, `purge-model-${modelId}`],
  );

  const conversationId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO conversations
       (id, user_id, model_id, title, message_count, last_message_at, deleted_at)
     VALUES ($1, $2, $3, 'Old chat', 1, '2026-08-01T00:00:00Z', $4)`,
    [
      conversationId,
      userId,
      modelId,
      deletedDaysAgo === null ? null : new Date(NOW.getTime() - deletedDaysAgo * 86_400_000),
    ],
  );

  const messageId = Bun.randomUUIDv7();
  await pool.query(
    `INSERT INTO messages (id, conversation_id, seq, role, status)
     VALUES ($1, $2, 1, 'user', 'complete')`,
    [messageId, conversationId],
  );
  await pool.query(
    `INSERT INTO message_parts (id, message_id, position, type, status, text_content)
     VALUES ($1, $2, 0, 'text', 'complete', 'sensitive prompt text')`,
    [Bun.randomUUIDv7(), messageId],
  );

  const storageKey = `files/2026/08/${Bun.randomUUIDv7()}`;
  await pool.query(
    `INSERT INTO attachments
       (id, owner_user_id, conversation_id, message_id, origin, kind, display_name,
        detected_mime, size_bytes, sha256, storage_provider, storage_key, status, expires_at)
     VALUES ($1, $2, $3, $4, 'input', 'document', 'notes.txt',
             'text/plain', 12, $5, 'local', $6, 'ready', '2026-09-01T00:00:00Z')`,
    [Bun.randomUUIDv7(), userId, conversationId, messageId, 'a'.repeat(64), storageKey],
  );

  return { conversationId, messageId, storageKey };
}

async function countRows(table: string, column: string, id: string): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE ${column} = $1`,
    [id],
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe('conversation purge job (real PostgreSQL)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closePool();
  });

  it('hard-deletes rows and blobs only past the retention window', async () => {
    const old = await seedConversation(45);
    const recent = await seedConversation(5);
    const live = await seedConversation(null);

    const deletedBlobs: string[] = [];
    const handler = createConversationPurgeHandler({
      conversations,
      storage: {
        delete: async (key) => {
          deletedBlobs.push(key);
        },
      },
      clock: { now: () => NOW },
      retentionDays: 30,
    });

    await expect(handler()).resolves.toEqual({ purgedCount: 1 });

    expect(await countRows('conversations', 'id', old.conversationId)).toBe(0);
    expect(await countRows('conversations', 'id', recent.conversationId)).toBe(1);
    expect(await countRows('conversations', 'id', live.conversationId)).toBe(1);

    expect(await countRows('messages', 'conversation_id', old.conversationId)).toBe(0);
    expect(await countRows('message_parts', 'message_id', old.messageId)).toBe(0);
    expect(await countRows('attachments', 'conversation_id', old.conversationId)).toBe(0);

    expect(await countRows('messages', 'conversation_id', recent.conversationId)).toBe(1);

    expect(deletedBlobs).toEqual([old.storageKey]);
  });

  it('is idempotent: a second run finds nothing left to purge', async () => {
    await seedConversation(45);

    const handler = createConversationPurgeHandler({
      conversations,
      storage: { delete: async () => {} },
      clock: { now: () => NOW },
      retentionDays: 30,
    });

    await expect(handler()).resolves.toEqual({ purgedCount: 1 });
    await expect(handler()).resolves.toEqual({ purgedCount: 0 });
  });
});
