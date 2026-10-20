import { describe, expect, it } from 'vitest';
import { Finalizer } from '@/generations/application/finalizer.ts';
import type { GenerationRecord, GenerationRepository } from '@/generations/ports/generation-repository.ts';
import type { ConversationRepository } from '@/conversations/ports/conversation-repository.ts';
import type { QuotaPort, Settlement } from '@/generations/ports/quota-port.ts';
import type { ErrorEventEntry, ErrorEventWriter } from '@/generations/ports/error-event-writer.ts';
import type { MessagePart, MessageWithParts } from '@/conversations/domain/conversation.ts';

function createDummyRecord(id: string): GenerationRecord {
  return {
    id,
    requestId: 'req-1',
    userId: 'u-1',
    conversationId: 'c-1',
    assistantMessageId: 'm-assistant',
    modelId: 'm-1',
    providerId: 'p-1',
    status: 'generating',
    runnerId: null,
    cancelReason: null,
    startedAt: new Date(),
    heartbeatAt: new Date(),
    finishedAt: null,
    lastEventSeq: 10,
    estInputTokens: 50,
    maxOutputTokens: 2048,
    modelLock: {},
    options: {},
    contextInfo: {},
    errorCategory: null,
    errorDetail: null,
    providerRequestId: null,
    providerLatencyMs: null,
    attempt: 1,
    supersededBy: null,
    createdAt: new Date(),
  };
}

describe('Finalizer', () => {
  const clock = { now: () => new Date('2026-10-12T12:00:00Z') };

  it('finalizes completed generation and updates message and part statuses', async () => {
    let transitionCalls = 0;
    const settlements: Settlement[] = [];
    const messageUpdates: Record<string, unknown>[] = [];
    const partUpdates: Record<string, unknown>[] = [];

    const mockGenerations: Partial<GenerationRepository> = {
      transitionToTerminal: async () => {
        transitionCalls++;
        return true;
      },
      findById: async (id: string) => createDummyRecord(id),
    };

    const dummyMessageWithParts: MessageWithParts = {
      message: {
        id: 'm-assistant',
        conversationId: 'c-1',
        seq: 2,
        role: 'assistant',
        status: 'streaming',
        finishReason: null,
        supersededBy: null,
        metadata: {},
        createdAt: new Date(),
        completedAt: null,
      },
      parts: [
        {
          id: 'part-1',
          messageId: 'm-assistant',
          position: 0,
          type: 'text',
          status: 'streaming',
          textContent: 'Incomplete',
          data: {},
          fileId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };

    const mockConversations: Partial<ConversationRepository> = {
      updateMessage: async (_id, updates) => {
        messageUpdates.push(updates);
      },
      findMessageForUser: async () => dummyMessageWithParts,
      updatePart: async (_id, updates) => {
        partUpdates.push(updates);
      },
    };

    const mockQuota: Partial<QuotaPort> = {
      settleOrRelease: async (settlement) => {
        settlements.push(settlement);
      },
    };

    const mockErrorEvents: Partial<ErrorEventWriter> = {
      record: async () => {},
    };

    const finalizer = new Finalizer({
      generations: mockGenerations as GenerationRepository,
      conversations: mockConversations as ConversationRepository,
      quota: mockQuota as QuotaPort,
      errorEvents: mockErrorEvents as ErrorEventWriter,
      clock,
    });

    const result = await finalizer.finalize({
      generationId: 'gen-1',
      status: 'completed',
      finishReason: 'stop',
      accumulatedText: 'Complete text output',
    });

    expect(result).toBe(true);
    expect(transitionCalls).toBe(1);
    expect(messageUpdates[0]?.status).toBe('complete');
    expect(messageUpdates[0]?.finishReason).toBe('stop');
    expect(partUpdates[0]?.status).toBe('complete');
    expect(partUpdates[0]?.textContent).toBe('Complete text output');
    expect(settlements[0]?.outcome).toBe('settled');
  });

  it('preserves existing checkpointed part text when finalized with empty text', async () => {
    const messageUpdates: Record<string, unknown>[] = [];
    const partUpdates: Record<string, unknown>[] = [];

    const mockGenerations: Partial<GenerationRepository> = {
      transitionToTerminal: async () => true,
      findById: async (id: string) => createDummyRecord(id),
    };

    const dummyMessageWithParts: MessageWithParts = {
      message: {
        id: 'm-assistant',
        conversationId: 'c-1',
        seq: 2,
        role: 'assistant',
        status: 'streaming',
        finishReason: null,
        supersededBy: null,
        metadata: {},
        createdAt: new Date(),
        completedAt: null,
      },
      parts: [
        {
          id: 'part-1',
          messageId: 'm-assistant',
          position: 0,
          type: 'text',
          status: 'streaming',
          textContent: 'Partial checkpointed text that must not be wiped',
          data: {},
          fileId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    };

    const mockConversations: Partial<ConversationRepository> = {
      updateMessage: async (_id, updates) => {
        messageUpdates.push(updates);
      },
      findMessageForUser: async () => dummyMessageWithParts,
      updatePart: async (_id, updates) => {
        partUpdates.push(updates);
      },
    };

    const mockQuota: Partial<QuotaPort> = {
      settleOrRelease: async () => {},
    };

    const mockErrorEvents: Partial<ErrorEventWriter> = {
      record: async () => {},
    };

    const finalizer = new Finalizer({
      generations: mockGenerations as GenerationRepository,
      conversations: mockConversations as ConversationRepository,
      quota: mockQuota as QuotaPort,
      errorEvents: mockErrorEvents as ErrorEventWriter,
      clock,
    });

    const result = await finalizer.finalize({
      generationId: 'gen-1',
      status: 'cancelled',
      finishReason: 'user_cancel',
      accumulatedText: '', // e.g. from an external cancel call with no in-memory buffer
    });

    expect(result).toBe(true);
    expect(messageUpdates[0]?.status).toBe('incomplete');
    expect(messageUpdates[0]?.finishReason).toBe('cancelled');
    expect(partUpdates[0]?.textContent).toBe('Partial checkpointed text that must not be wiped');
  });

  it('is idempotent: second finalize returns false when already terminalized', async () => {
    const mockGenerations: Partial<GenerationRepository> = {
      transitionToTerminal: async () => false, // 0 rows updated -> already terminal
    };

    const finalizer = new Finalizer({
      generations: mockGenerations as GenerationRepository,
      conversations: {} as ConversationRepository,
      quota: {} as QuotaPort,
      errorEvents: {} as ErrorEventWriter,
      clock,
    });

    const result = await finalizer.finalize({
      generationId: 'gen-already-finished',
      status: 'completed',
      finishReason: 'stop',
      accumulatedText: 'ignored',
    });

    expect(result).toBe(false);
  });

  it('records error event and settles quota for a failed generation that had started', async () => {
    const errorRecords: ErrorEventEntry[] = [];
    const settlements: Settlement[] = [];

    const mockGenerations: Partial<GenerationRepository> = {
      transitionToTerminal: async () => true,
      // startedAt !== null indicates tokens were consumed and must be settled.
      findById: async (id: string) => createDummyRecord(id),
    };

    const mockConversations: Partial<ConversationRepository> = {
      updateMessage: async () => {},
      findMessageForUser: async () => null,
    };

    const mockQuota: Partial<QuotaPort> = {
      settleOrRelease: async (settlement) => {
        settlements.push(settlement);
      },
    };

    const mockErrorEvents: Partial<ErrorEventWriter> = {
      record: async (entry) => {
        errorRecords.push(entry);
      },
    };

    const finalizer = new Finalizer({
      generations: mockGenerations as GenerationRepository,
      conversations: mockConversations as ConversationRepository,
      quota: mockQuota as QuotaPort,
      errorEvents: mockErrorEvents as ErrorEventWriter,
      clock,
    });

    const result = await finalizer.finalize({
      generationId: 'gen-fail',
      status: 'failed',
      finishReason: 'error',
      error: { code: 'provider_unavailable', message: 'Provider down', retryable: true },
      accumulatedText: 'Partial output',
    });

    expect(result).toBe(true);
    expect(settlements[0]?.outcome).toBe('settled');
    expect(errorRecords.length).toBe(1);
    expect(errorRecords[0]?.category).toBe('provider_unavailable');
    expect(errorRecords[0]?.generationId).toBe('gen-fail');
  });

  it('releases quota when a failed generation never reached the provider', async () => {
    const settlements: Settlement[] = [];

    const neverStarted: GenerationRecord = { ...createDummyRecord('gen-never'), startedAt: null };

    const mockGenerations: Partial<GenerationRepository> = {
      transitionToTerminal: async () => true,
      findById: async () => neverStarted,
    };

    const mockConversations: Partial<ConversationRepository> = {
      updateMessage: async () => {},
      findMessageForUser: async () => null,
    };

    const mockQuota: Partial<QuotaPort> = {
      settleOrRelease: async (settlement) => {
        settlements.push(settlement);
      },
    };

    const finalizer = new Finalizer({
      generations: mockGenerations as GenerationRepository,
      conversations: mockConversations as ConversationRepository,
      quota: mockQuota as QuotaPort,
      errorEvents: { record: async () => {} } as ErrorEventWriter,
      clock,
    });

    const result = await finalizer.finalize({
      generationId: 'gen-never',
      status: 'failed',
      finishReason: 'error',
      error: { code: 'provider_unavailable', message: 'Provider down', retryable: true },
      accumulatedText: '',
    });

    expect(result).toBe(true);
    expect(settlements[0]?.outcome).toBe('released');
    expect(settlements[0]?.actualTokens).toBe(0);
  });

  it('marks a failure with partial content as `incomplete` and keeps the finish_reason `error` (mapOutcome)', async () => {
    const messageUpdates: Array<Record<string, unknown>> = [];

    const mockGenerations: Partial<GenerationRepository> = {
      transitionToTerminal: async () => true,
      findById: async (id: string) => createDummyRecord(id),
    };

    const mockConversations: Partial<ConversationRepository> = {
      updateMessage: async (_id, updates) => {
        messageUpdates.push(updates as Record<string, unknown>);
      },
      findMessageForUser: async () => null,
    };

    const finalizer = new Finalizer({
      generations: mockGenerations as GenerationRepository,
      conversations: mockConversations as ConversationRepository,
      quota: { settleOrRelease: async () => {} } as unknown as QuotaPort,
      errorEvents: { record: async () => {} } as ErrorEventWriter,
      clock,
    });

    const result = await finalizer.finalize({
      generationId: 'gen-partial',
      status: 'failed',
      finishReason: 'error',
      error: { code: 'provider_unavailable', message: 'Upstream died mid-stream', retryable: true },
      accumulatedText: 'Half an answer',
    });

    expect(result).toBe(true);
    // Partial content is preserved as `incomplete` rather than hard `failed`.
    expect(messageUpdates[0]?.['status']).toBe('incomplete');
    expect(messageUpdates[0]?.['finishReason']).toBe('error');
  });

  it('persists accumulated text by inserting a part when the message has none', async () => {
    const inserted: Array<readonly MessagePart[]> = [];

    const messageWithoutParts: MessageWithParts = {
      message: {
        id: 'm-assistant',
        conversationId: 'c-1',
        seq: 2,
        role: 'assistant',
        status: 'streaming',
        finishReason: null,
        supersededBy: null,
        metadata: {},
        createdAt: new Date(),
        completedAt: null,
      },
      parts: [],
    };

    const mockGenerations: Partial<GenerationRepository> = {
      transitionToTerminal: async () => true,
      findById: async (id: string) => createDummyRecord(id),
    };

    const mockConversations: Partial<ConversationRepository> = {
      updateMessage: async () => {},
      findMessageForUser: async () => messageWithoutParts,
      insertParts: async (parts) => {
        inserted.push(parts);
      },
    };

    const finalizer = new Finalizer({
      generations: mockGenerations as GenerationRepository,
      conversations: mockConversations as ConversationRepository,
      quota: { settleOrRelease: async () => {} } as unknown as QuotaPort,
      errorEvents: { record: async () => {} } as ErrorEventWriter,
      clock,
    });

    const result = await finalizer.finalize({
      generationId: 'gen-recover',
      status: 'completed',
      finishReason: 'stop',
      accumulatedText: 'Recovered text',
      fallbackPartId: 'fallback-part-1',
    });

    expect(result).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.[0]?.id).toBe('fallback-part-1');
    expect(inserted[0]?.[0]?.textContent).toBe('Recovered text');
    expect(inserted[0]?.[0]?.status).toBe('complete');
  });
});

describe('Finalizer — non-text part reconciliation', () => {
  function part(overrides: Partial<MessagePart>): MessagePart {
    return {
      id: 'part',
      messageId: 'm-assistant',
      position: 0,
      type: 'text',
      status: 'streaming',
      textContent: null,
      data: {},
      fileId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  async function run(
    status: 'completed' | 'cancelled' | 'failed',
    parts: MessagePart[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const updates = new Map<string, Record<string, unknown>>();
    const finalizer = new Finalizer({
      generations: {
        transitionToTerminal: async () => true,
        findById: async (id: string) => createDummyRecord(id),
      } as unknown as GenerationRepository,
      conversations: {
        updateMessage: async () => {},
        findMessageForUser: async () => ({
          message: {
            id: 'm-assistant',
            conversationId: 'c-1',
            seq: 2,
            role: 'assistant',
            status: 'streaming',
            finishReason: null,
            supersededBy: null,
            metadata: {},
            createdAt: new Date(),
            completedAt: null,
          },
          parts,
        }),
        updatePart: async (id: string, update: Record<string, unknown>) => {
          updates.set(id, update as Record<string, unknown>);
        },
      } as unknown as ConversationRepository,
      quota: { settleOrRelease: async () => {} } as unknown as QuotaPort,
      errorEvents: { record: async () => {} } as unknown as ErrorEventWriter,
      clock: { now: () => new Date('2026-10-12T12:00:00Z') },
    });

    await finalizer.finalize({
      generationId: 'gen-1',
      status,
      finishReason: status === 'completed' ? 'stop' : 'error',
      accumulatedText: 'text',
    });
    return updates;
  }

  it('completes a file part that got its bytes and fails one that never did', async () => {
    const updates = await run('completed', [
      part({ id: 'text-1' }),
      part({ id: 'image-1', type: 'image', position: 1, fileId: 'att-1' }),
      part({ id: 'file-1', type: 'generated_file', position: 2, fileId: null }),
    ]);

    expect(updates.get('text-1')?.['status']).toBe('complete');
    expect(updates.get('image-1')?.['status']).toBe('complete');
    expect(updates.get('file-1')?.['status']).toBe('failed');
  });

  it('reconciles streaming non-text parts on cancel as well', async () => {
    const updates = await run('cancelled', [
      part({ id: 'text-1' }),
      part({ id: 'file-1', type: 'generated_file', position: 1, fileId: null }),
    ]);

    expect(updates.get('file-1')?.['status']).toBe('failed');
  });
});
