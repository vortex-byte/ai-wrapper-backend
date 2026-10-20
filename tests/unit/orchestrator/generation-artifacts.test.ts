import { describe, expect, it } from 'vitest';
import { GenerationRun } from '@/orchestrator/generation-run.ts';
import type { GenerationRunHooks } from '@/orchestrator/generation-run.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import { providerError } from '@/providers/domain/errors.ts';
import type { ProviderAdapter } from '@/providers/ports/provider-adapter.ts';
import type { GenerationRecord } from '@/generations/ports/generation-repository.ts';

/** Minimal scripted adapter: yields exactly the PAL events it was handed, in order. */
class ScriptedAdapter implements ProviderAdapter {
  readonly adapterKey = 'scripted';
  constructor(private readonly events: readonly GenerationEvent[]) {}

  toProviderRequest(): unknown {
    return {};
  }

  async estimateInputTokens(): Promise<{ tokens: number; confidence: 'approx' }> {
    return { tokens: 1, confidence: 'approx' };
  }

  async *execute(): AsyncIterable<GenerationEvent> {
    for (const event of this.events) {
      yield event;
    }
  }

  translateError(): ReturnType<ProviderAdapter['translateError']> {
    return providerError('provider_unavailable', 'scripted failure');
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    return { ok: true, latencyMs: 0 };
  }
}

function request(): NormalizedChatRequest {
  return {
    requestId: 'req-1',
    generationId: 'gen-1',
    model: {
      modelId: 'm-1',
      providerId: 'p-1',
      apiModelId: 'claude-sonnet-4-6',
      displayName: 'Claude',
      capabilities: {
        streaming: true,
        vision: true,
        documents: { pdf: true },
        imageGeneration: true,
        documentGeneration: true,
        systemPrompt: true,
        tools: true,
        contextWindow: 200000,
        maxOutputTokens: 4096,
      },
      maxOutputTokens: 4096,
      defaultMaxOutputTokens: 2048,
      quotaWeight: 1,
      config: {},
    },
    provider: { providerId: 'p-1', key: 'anthropic', adapter: 'scripted', config: {}, secrets: {} },
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Make a spreadsheet' }] }],
    maxOutputTokens: 2048,
    responseModalities: ['text', 'file'],
    metadata: { userIdHash: 'hash' },
  };
}

function record(): GenerationRecord {
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

function makeRun(
  events: readonly GenerationEvent[],
  overrides: Partial<GenerationRunHooks> = {},
): { run: GenerationRun } {
  const clock = { now: () => new Date('2026-01-01T00:00:00Z') };
  let counter = 0;
  const idGen = { uuidv7: () => `part-${++counter}` };
  const run = new GenerationRun({
    generation: record(),
    userMessageId: 'm-user',
    assistantMessageId: 'm-assistant',
    chatRequest: request(),
    adapter: new ScriptedAdapter(events),
    contextInfo: { truncated: false },
    clock,
    idGen,
    config: { detachTimeoutSeconds: 60 },
    hooks: {
      onArtifact: async () => ({ attachmentId: 'att-1' }),
      ...overrides,
    },
  });
  return { run };
}

function frames(run: GenerationRun): Array<{ event: string; data: Record<string, unknown> }> {
  return run.ringBuffer.getAll().map((frame) => ({
    event: frame.event,
    data: JSON.parse(frame.data) as Record<string, unknown>,
  }));
}

describe('GenerationRun cloud-container tool events', () => {
  it('maps tool_started/delta/completed to tool.* SSE frames', async () => {
    const { run } = makeRun([
      {
        type: 'tool_started',
        toolCallId: 't1',
        name: 'code_execution',
        input: { command: 'python x.py' },
      },
      { type: 'tool_delta', toolCallId: 't1', delta: 'working...\n' },
      { type: 'tool_completed', toolCallId: 't1', status: 'success' },
      { type: 'finished', reason: 'stop' },
    ]);

    run.subscribe('s-1');
    await run.start();

    const all = frames(run);
    expect(all.find((f) => f.event === 'tool.started')?.data).toMatchObject({
      toolCallId: 't1',
      tool: 'code_execution',
      command: 'python x.py',
    });
    expect(all.find((f) => f.event === 'tool.delta')?.data).toMatchObject({
      toolCallId: 't1',
      delta: 'working...\n',
    });
    expect(all.find((f) => f.event === 'tool.completed')?.data).toMatchObject({
      toolCallId: 't1',
      status: 'success',
    });
  });

  it('hydrates an artifact and only then emits part.completed with a downloadUrl', async () => {
    const { run } = makeRun([
      {
        type: 'part_started',
        index: 0,
        partType: 'file',
        name: 'report.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      { type: 'artifact_emitted', providerFileId: 'file_abc', filename: 'report.xlsx', index: 0 },
      { type: 'finished', reason: 'stop' },
    ]);

    run.subscribe('s-1');
    await run.start();

    const all = frames(run);
    const started = all.find((f) => f.event === 'part.started');
    expect(started?.data).toMatchObject({ type: 'file', name: 'report.xlsx' });

    const completed = all.find((f) => f.event === 'part.completed');
    expect(completed?.data).toMatchObject({
      status: 'complete',
      fileId: 'att-1',
      downloadUrl: '/api/files/att-1/content',
    });
  });

  it('opens a file part implicitly when the artifact arrives without part_started', async () => {
    const { run } = makeRun([
      { type: 'artifact_emitted', providerFileId: 'file_xyz', filename: 'chart.png' },
      { type: 'finished', reason: 'stop' },
    ]);

    run.subscribe('s-1');
    await run.start();

    const all = frames(run);
    expect(all.find((f) => f.event === 'part.started')?.data).toMatchObject({
      type: 'image',
      name: 'chart.png',
    });
    expect(all.find((f) => f.event === 'part.completed')?.data).toMatchObject({
      status: 'complete',
    });
  });

  it('allocates distinct positions when a turn has text and an artifact (UNIQUE message_id+position)', async () => {
    const startedParts: Array<{ partId: string; position: number; type: string }> = [];
    const { run } = makeRun(
      [
        { type: 'part_started', index: 0, partType: 'text' },
        { type: 'text_delta', index: 0, text: 'Here is your image.' },
        {
          type: 'artifact_emitted',
          providerFileId: 'image:ig_1',
          filename: 'image-1.png',
          mimeType: 'image/png',
        },
        { type: 'part_done', index: 0 },
        { type: 'finished', reason: 'stop' },
      ],
      {
        onPartStarted: async (part) => {
          startedParts.push({ partId: part.partId, position: part.position, type: part.type });
        },
      },
    );

    run.subscribe('s-1');
    await run.start();

    expect(startedParts).toHaveLength(2);
    const positions = startedParts.map((part) => part.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(startedParts[0]).toMatchObject({ type: 'text', position: 0 });
    expect(startedParts[1]).toMatchObject({ type: 'image', position: 1 });
  });

  it('ignores a duplicate part_done for an already-hydrated part', async () => {
    const { run } = makeRun([
      { type: 'artifact_emitted', providerFileId: 'file_dup', filename: 'chart.png' },
      { type: 'part_done', index: 0, fileId: 'att-1' },
      { type: 'finished', reason: 'stop' },
    ]);

    run.subscribe('s-1');
    await run.start();

    const completed = frames(run).filter((f) => f.event === 'part.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.data).toMatchObject({ status: 'complete', fileId: 'att-1' });
  });

  it('marks the part failed (never the generation) when hydration returns null', async () => {
    const { run } = makeRun(
      [
        { type: 'artifact_emitted', providerFileId: 'file_zzz', filename: 'broken.pdf' },
        { type: 'finished', reason: 'stop' },
      ],
      { onArtifact: async () => null },
    );

    run.subscribe('s-1');
    await run.start();

    const all = frames(run);
    expect(all.find((f) => f.event === 'part.completed')?.data).toMatchObject({ status: 'failed' });
    expect(all.find((f) => f.event === 'generation.completed')).toBeDefined();
  });

  it('tolerates a throwing artifact hook without failing the generation', async () => {
    const { run } = makeRun(
      [
        { type: 'artifact_emitted', providerFileId: 'file_boom', filename: 'x.docx' },
        { type: 'finished', reason: 'stop' },
      ],
      {
        onArtifact: async () => {
          throw new Error('download exploded');
        },
      },
    );

    run.subscribe('s-1');
    await run.start();

    const all = frames(run);
    expect(all.find((f) => f.event === 'part.completed')?.data).toMatchObject({ status: 'failed' });
    expect(all.find((f) => f.event === 'generation.completed')).toBeDefined();
  });
});
