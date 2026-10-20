import { describe, expect, it } from 'vitest';
import { createConversationPurgeHandler } from '@/jobs/application/handlers/conversation-purge-handler.ts';

const NOW = new Date('2026-10-20T12:00:00.000Z');

interface StoredConversation {
  readonly id: string;
  readonly deletedAt: Date;
  readonly storageKeys: readonly string[];
}

class FakeRepo {
  readonly deleted: string[] = [];
  readonly queries: Date[] = [];

  constructor(private readonly rows: StoredConversation[]) {}

  async findPurgeableIds(cutoff: Date, limit: number): Promise<readonly string[]> {
    this.queries.push(cutoff);
    return this.rows
      .filter((row) => row.deletedAt < cutoff)
      .slice(0, limit)
      .map((row) => row.id);
  }

  async attachmentStorageKeysFor(
    ids: readonly string[],
  ): Promise<readonly { conversationId: string; storageKey: string }[]> {
    return this.rows
      .filter((row) => ids.includes(row.id))
      .flatMap((row) =>
        row.storageKeys.map((storageKey) => ({ conversationId: row.id, storageKey })),
      );
  }

  async hardDelete(ids: readonly string[]): Promise<number> {
    for (const id of ids) {
      this.deleted.push(id);
      const index = this.rows.findIndex((row) => row.id === id);
      if (index >= 0) this.rows.splice(index, 1);
    }
    return ids.length;
  }
}

describe('conversation purge job', () => {
  it('purges only conversations deleted before the retention cutoff', async () => {
    const repo = new FakeRepo([
      { id: 'old', deletedAt: new Date('2026-08-01T00:00:00Z'), storageKeys: [] },
      { id: 'recent', deletedAt: new Date('2026-10-19T00:00:00Z'), storageKeys: [] },
    ]);
    const deletedKeys: string[] = [];

    const handler = createConversationPurgeHandler({
      conversations: repo,
      storage: {
        delete: async (key) => {
          deletedKeys.push(key);
        },
      },
      clock: { now: () => NOW },
      retentionDays: 30,
      runInTransaction: (fn) => fn({} as never),
    });

    const result = await handler();

    expect(result.purgedCount).toBe(1);
    expect(repo.deleted).toEqual(['old']);
    expect(repo.queries[0]).toEqual(new Date('2026-09-20T12:00:00.000Z'));
    expect(deletedKeys).toEqual([]);
  });

  it('deletes every attachment blob after the row delete commits', async () => {
    const repo = new FakeRepo([
      {
        id: 'old',
        deletedAt: new Date('2026-08-01T00:00:00Z'),
        storageKeys: ['files/2026/08/a', 'files/2026/08/b'],
      },
    ]);
    let transactionCommitted = false;
    const deletedKeys: string[] = [];

    const handler = createConversationPurgeHandler({
      conversations: repo,
      storage: {
        delete: async (key) => {
          // Blob deletion must never run inside the transaction.
          expect(transactionCommitted).toBe(true);
          deletedKeys.push(key);
        },
      },
      clock: { now: () => NOW },
      retentionDays: 30,
      runInTransaction: async (fn) => {
        const result = await fn({} as never);
        transactionCommitted = true;
        return result;
      },
    });

    await handler();

    expect(deletedKeys).toEqual(['files/2026/08/a', 'files/2026/08/b']);
  });

  it('keeps purging batches until the final short batch', async () => {
    const rows: StoredConversation[] = Array.from({ length: 51 }, (_, index) => ({
      id: `c-${index}`,
      deletedAt: new Date('2026-08-01T00:00:00Z'),
      storageKeys: [],
    }));
    const repo = new FakeRepo(rows);

    const handler = createConversationPurgeHandler({
      conversations: repo,
      storage: { delete: async () => {} },
      clock: { now: () => NOW },
      retentionDays: 30,
      runInTransaction: (fn) => fn({} as never),
    });

    const result = await handler();

    expect(result.purgedCount).toBe(51);
    expect(repo.deleted).toHaveLength(51);
  });

  it('reports zero when nothing is due', async () => {
    const handler = createConversationPurgeHandler({
      conversations: new FakeRepo([]),
      storage: { delete: async () => {} },
      clock: { now: () => NOW },
      retentionDays: 30,
      runInTransaction: (fn) => fn({} as never),
    });

    await expect(handler()).resolves.toEqual({ purgedCount: 0 });
  });
});