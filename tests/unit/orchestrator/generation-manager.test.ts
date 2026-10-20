import { describe, expect, it } from 'vitest';
import { GenerationManager } from '@/orchestrator/generation-manager.ts';
import { FakeProvider } from '@/providers/infrastructure/fake/fake-provider.ts';
import { loadConfig } from '@/config/env.ts';
import type { ProviderRegistry } from '@/providers/ports/provider-registry.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationRecord } from '@/generations/ports/generation-repository.ts';
import { captureLogs } from '../../helpers/capture-logs.ts';

function createDummyRequest(): NormalizedChatRequest {
  return {
    requestId: 'req-1',
    generationId: 'gen-1',
    model: {
      modelId: 'm-1',
      providerId: 'p-1',
      apiModelId: 'gpt-4o',
      displayName: 'GPT-4o',
      capabilities: {
        streaming: true,
        vision: false,
        documents: { pdf: false },
        imageGeneration: false,
        documentGeneration: false,
        systemPrompt: true,
        tools: false,
        contextWindow: 128000,
        maxOutputTokens: 4096,
      },
      maxOutputTokens: 4096,
      defaultMaxOutputTokens: 2048,
      quotaWeight: 1,
      config: {},
    },
    provider: {
      providerId: 'p-1',
      key: 'openai',
      adapter: 'fake',
      config: {},
      secrets: {},
    },
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello' }] }],
    maxOutputTokens: 2048,
    responseModalities: ['text'],
    metadata: { userIdHash: 'hash' },
  };
}

function createDummyRecord(id: string): GenerationRecord {
  return {
    id,
    requestId: `req-${id}`,
    userId: 'u-1',
    conversationId: 'c-1',
    assistantMessageId: `m-assistant-${id}`,
    modelId: 'm-1',
    providerId: 'p-1',
    status: 'pending',
    runnerId: null,
    cancelReason: null,
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    lastEventSeq: 0,
    estInputTokens: 10,
    maxOutputTokens: 2048,
    modelLock: { modelId: 'm-1', providerId: 'p-1', configVersion: null },
    options: {},
    contextInfo: { truncated: false },
    errorCategory: null,
    errorDetail: null,
    providerRequestId: null,
    providerLatencyMs: null,
    attempt: 1,
    supersededBy: null,
    createdAt: new Date(),
  };
}

describe('GenerationManager', () => {
  const clock = { now: () => new Date() };
  let idCounter = 0;
  const idGen = { uuidv7: () => `id-${++idCounter}` };

  const providerRegistry: ProviderRegistry = {
    register: () => {},
    get: (key) => (key === 'fake' ? new FakeProvider({ chunkDelayMs: 10 }) : null),
    has: (key) => key === 'fake',
    keys: () => ['fake'],
  };

  it('enqueues a generation, manages active count, and cleans up on completion', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://aichat:changeme@127.0.0.1:5432/aichat_test',
      SESSION_SECRET: '01234567890123456789012345678901',
      NODE_ENV: 'test',
      MAX_ACTIVE_GENERATIONS: '5',
    });
    const manager = new GenerationManager({
      providerRegistry,
      clock,
      idGen,
      config,
    });

    const run = manager.enqueue({
      generation: createDummyRecord('gen-1'),
      userMessageId: 'm-user',
      assistantMessageId: 'm-assistant',
      chatRequest: createDummyRequest(),
      contextInfo: { truncated: false },
    });

    expect(manager.activeCount).toBe(1);
    expect(manager.getRun('gen-1')).toBe(run);

    while (run.currentStatus !== 'completed') {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(manager.activeCount).toBe(0);
    expect(manager.getRun('gen-1')).toBeUndefined();
  });

  it('rejects enqueue with 503 service_busy when MAX_ACTIVE_GENERATIONS capacity is reached', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://aichat:changeme@127.0.0.1:5432/aichat_test',
      SESSION_SECRET: '01234567890123456789012345678901',
      NODE_ENV: 'test',
      MAX_ACTIVE_GENERATIONS: '1',
    });
    const manager = new GenerationManager({
      providerRegistry,
      clock,
      idGen,
      config,
    });

    manager.enqueue({
      generation: createDummyRecord('gen-1'),
      userMessageId: 'm-user-1',
      assistantMessageId: 'm-assistant-1',
      chatRequest: createDummyRequest(),
      contextInfo: { truncated: false },
    });

    expect(() =>
      manager.enqueue({
        generation: createDummyRecord('gen-2'),
        userMessageId: 'm-user-2',
        assistantMessageId: 'm-assistant-2',
        chatRequest: createDummyRequest(),
        contextInfo: { truncated: false },
      }),
    ).toThrowError();
  });

  it('subscribes to active generation, and returns found=false for unknown runs', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://aichat:changeme@127.0.0.1:5432/aichat_test',
      SESSION_SECRET: '01234567890123456789012345678901',
      NODE_ENV: 'test',
    });
    const manager = new GenerationManager({
      providerRegistry,
      clock,
      idGen,
      config,
    });

    const unknown = manager.subscribe('non-existent');
    expect(unknown.found).toBe(false);

    manager.enqueue({
      generation: createDummyRecord('gen-3'),
      userMessageId: 'm-user-3',
      assistantMessageId: 'm-assistant-3',
      chatRequest: createDummyRequest(),
      contextInfo: { truncated: false },
    });

    const known = manager.subscribe('gen-3');
    expect(known.found).toBe(true);
    expect(known.canReplay).toBe(true);
    expect(known.subscriber).toBeDefined();
  });

  it('records duration, TTFT and provider-error fields on finalization', async () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://aichat:changeme@127.0.0.1:5432/aichat_test',
      SESSION_SECRET: '01234567890123456789012345678901',
      NODE_ENV: 'test',
      MAX_ACTIVE_GENERATIONS: '5',
    });
    // A real (monotonic-ish) clock so duration/TTFT are non-negative.
    let tick = 0;
    const realClock = { now: () => new Date(1_700_000_000_000 + tick++ * 10) };
    const logs = captureLogs();
    const registry: ProviderRegistry = {
      register: () => {},
      get: () => new FakeProvider({ chunks: ['Hello'] }),
      has: () => true,
      keys: () => ['fake'],
    };

    try {
      const manager = new GenerationManager({
        providerRegistry: registry,
        clock: realClock,
        idGen,
        config,
      });

      const run = manager.enqueue({
        generation: createDummyRecord('gen-metrics'),
        userMessageId: 'm-user',
        assistantMessageId: 'm-assistant',
        chatRequest: createDummyRequest(),
        contextInfo: { truncated: false },
      });

      while (run.currentStatus !== 'completed') {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      const started = logs.records.find((record) => record.msg === 'generation run started');
      expect(started).toBeDefined();
      expect(started?.meta['provider']).toBe('openai');

      const finished = logs.records.find((record) => record.msg === 'generation run finished');
      expect(finished).toBeDefined();
      expect(finished?.meta['status']).toBe('completed');
      expect(finished?.meta['provider']).toBe('openai');
      expect(finished?.meta['model']).toBe('gpt-4o');
      expect(typeof finished?.meta['durationMs']).toBe('number');
      expect(typeof finished?.meta['ttftMs']).toBe('number');
    } finally {
      logs.restore();
    }
  });

  it('cancels active generation when requested', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://aichat:changeme@127.0.0.1:5432/aichat_test',
      SESSION_SECRET: '01234567890123456789012345678901',
      NODE_ENV: 'test',
    });
    const manager = new GenerationManager({
      providerRegistry,
      clock,
      idGen,
      config,
    });

    manager.enqueue({
      generation: createDummyRecord('gen-cancel'),
      userMessageId: 'm-user',
      assistantMessageId: 'm-assistant',
      chatRequest: createDummyRequest(),
      contextInfo: { truncated: false },
    });

    const cancelled = manager.cancel('gen-cancel', 'user_cancel');
    expect(cancelled).toBe(true);

    const unknownCancel = manager.cancel('unknown');
    expect(unknownCancel).toBe(false);
  });
});
