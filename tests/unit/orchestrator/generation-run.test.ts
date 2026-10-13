import { describe, expect, it, vi } from 'vitest';
import { GenerationRun } from '@/orchestrator/generation-run.ts';
import { FakeProvider } from '@/providers/infrastructure/fake/fake-provider.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationRecord } from '@/generations/ports/generation-repository.ts';

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

function createDummyRecord(): GenerationRecord {
  return {
    id: 'gen-1',
    requestId: 'req-1',
    userId: 'u-1',
    conversationId: 'c-1',
    assistantMessageId: 'm-assistant',
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

describe('GenerationRun', () => {
  it('pre-buffers frame #1 message.created and frame #2 generation.state before execution', () => {
    const clock = { now: () => new Date() };
    const idGen = { uuidv7: () => 'uuid-1' };
    const adapter = new FakeProvider();
    const run = new GenerationRun({
      generation: createDummyRecord(),
      userMessageId: 'm-user',
      assistantMessageId: 'm-assistant',
      chatRequest: createDummyRequest(),
      adapter,
      contextInfo: { truncated: false },
      clock,
      idGen,
      config: { detachTimeoutSeconds: 60 },
    });

    const frames = run.ringBuffer.getAll();
    expect(frames.length).toBe(2);
    expect(frames[0]?.event).toBe('message.created');
    expect(frames[1]?.event).toBe('generation.state');
  });

  it('runs to completion and fans out coalesced frames and terminal frame', async () => {
    const clock = { now: () => new Date() };
    let uuidCount = 0;
    const idGen = { uuidv7: () => `part-${++uuidCount}` };
    const adapter = new FakeProvider({ chunks: ['Hello', ' world!'] });

    const run = new GenerationRun({
      generation: createDummyRecord(),
      userMessageId: 'm-user',
      assistantMessageId: 'm-assistant',
      chatRequest: createDummyRequest(),
      adapter,
      contextInfo: { truncated: false },
      clock,
      idGen,
      config: { detachTimeoutSeconds: 60 },
    });

    const { subscriber } = run.subscribe('sub-1');
    const receivedEvents: string[] = [];

    const readPromise = (async () => {
      for await (const frame of subscriber) {
        receivedEvents.push(frame.event);
      }
    })();

    await run.start();
    await readPromise;

    expect(run.currentStatus).toBe('completed');
    expect(run.totalAccumulatedText).toBe('Hello world!');
    expect(receivedEvents).toContain('message.created');
    expect(receivedEvents).toContain('generation.state');
    expect(receivedEvents).toContain('part.started');
    expect(receivedEvents).toContain('text.delta');
    expect(receivedEvents).toContain('part.completed');
    expect(receivedEvents).toContain('generation.completed');
  });

  it('handles user cancellation cleanly with generation.cancelled', async () => {
    const clock = { now: () => new Date() };
    const idGen = { uuidv7: () => 'part-1' };
    const adapter = new FakeProvider({ chunkDelayMs: 25, chunks: ['A', 'B', 'C', 'D'] });

    const run = new GenerationRun({
      generation: createDummyRecord(),
      userMessageId: 'm-user',
      assistantMessageId: 'm-assistant',
      chatRequest: createDummyRequest(),
      adapter,
      contextInfo: { truncated: false },
      clock,
      idGen,
      config: { detachTimeoutSeconds: 60 },
    });

    const startPromise = run.start();
    setTimeout(() => {
      run.abort('user_cancel');
    }, 10);

    await startPromise;

    expect(run.currentStatus).toBe('cancelled');
    const terminalFrame = run.ringBuffer.getAll().find((f) => f.event === 'generation.cancelled');
    expect(terminalFrame).toBeDefined();
    expect(JSON.parse(terminalFrame!.data)).toEqual({ reason: 'user_cancel' });
  });

  it('races signal against iterator.next() so an adapter that ignores abort cannot hang the runner', async () => {
    const clock = { now: () => new Date() };
    const idGen = { uuidv7: () => 'part-1' };
    const adapter = new FakeProvider({
      ignoreAbort: true,
      chunkDelayMs: 60_000,
      chunks: ['Slow chunk'],
    });

    const run = new GenerationRun({
      generation: createDummyRecord(),
      userMessageId: 'm-user',
      assistantMessageId: 'm-assistant',
      chatRequest: createDummyRequest(),
      adapter,
      contextInfo: { truncated: false },
      clock,
      idGen,
      config: { detachTimeoutSeconds: 60 },
    });

    const start = Date.now();
    const startPromise = run.start();

    setTimeout(() => {
      run.abort('user_cancel');
    }, 20);

    await startPromise;
    const elapsed = Date.now() - start;

    expect(run.currentStatus).toBe('cancelled');
    expect(elapsed).toBeLessThan(1000);
  });

  it('persists a text part via onPartStarted when the adapter skips part_started', async () => {
    const clock = { now: () => new Date() };
    const idGen = { uuidv7: () => 'part-raw' };
    // malformed_event still emits text deltas but we want a raw-delta adapter: use success with
    // the part_started suppressed by wrapping the adapter.
    const base = new FakeProvider({ chunks: ['raw', 'text'] });
    const adapter = {
      ...base,
      execute: async function* (req: never, ctx: never) {
        for await (const ev of base.execute(req as never, ctx as never)) {
          if (ev.type === 'part_started') continue;
          yield ev;
        }
      },
    } as unknown as FakeProvider;

    const partStarts: string[] = [];
    const run = new GenerationRun({
      generation: createDummyRecord(),
      userMessageId: 'm-user',
      assistantMessageId: 'm-assistant',
      chatRequest: createDummyRequest(),
      adapter,
      contextInfo: { truncated: false },
      clock,
      idGen,
      config: { detachTimeoutSeconds: 60 },
      hooks: {
        onPartStarted: async (part) => {
          partStarts.push(part.partId);
        },
      },
    });

    await run.start();

    expect(run.currentStatus).toBe('completed');
    expect(run.totalAccumulatedText).toBe('rawtext');
    expect(partStarts).toEqual(['part-raw']);
  });

  it('emits a comment heartbeat frame (not a named generation.state event)', async () => {
    vi.useFakeTimers();
    try {
      const clock = { now: () => new Date() };
      const idGen = { uuidv7: () => 'part-1' };
      const adapter = new FakeProvider({ chunkDelayMs: 100_000, chunks: ['slow'] });

      const run = new GenerationRun({
        generation: createDummyRecord(),
        userMessageId: 'm-user',
        assistantMessageId: 'm-assistant',
        chatRequest: createDummyRequest(),
        adapter,
        contextInfo: { truncated: false },
        clock,
        idGen,
        config: { detachTimeoutSeconds: 600, heartbeatIntervalMs: 1000 },
      });

      const { subscriber } = run.subscribe('sub-hb');
      const frames: Array<{ event: string; comment?: boolean | undefined; data: string }> = [];
      const readPromise = (async () => {
        for await (const frame of subscriber) {
          frames.push({ event: frame.event, comment: frame.comment, data: frame.data });
        }
      })();

      const startPromise = run.start();
      // Advance past the heartbeat interval; the run is parked in a 100 s chunk delay.
      await vi.advanceTimersByTimeAsync(1500);

      const heartbeat = frames.find((f) => f.comment === true);
      expect(heartbeat).toBeDefined();
      // A comment heartbeat must never masquerade as a semantic event with empty data.
      expect(frames.filter((f) => f.comment !== true && f.event === 'generation.state' && f.data === '')).toHaveLength(0);

      run.abort('user_cancel');
      await vi.advanceTimersByTimeAsync(2000);
      await startPromise;
      subscriber.close();
      await readPromise;
    } finally {
      vi.useRealTimers();
    }
  });
});
