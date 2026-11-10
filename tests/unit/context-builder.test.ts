import { describe, expect, it } from 'vitest';
import { buildContext } from '@/context-builder/context-builder.ts';
import { AppError } from '@/errors.ts';
import type { ModelRuntimeConfig, ProviderRuntimeConfig } from '@/providers/index.ts';

const mockModel: ModelRuntimeConfig = {
  modelId: 'm-1',
  providerId: 'p-1',
  apiModelId: 'gpt-4o',
  displayName: 'GPT-4o',
  capabilities: {
    streaming: true,
    vision: true,
    documents: { pdf: true },
    imageGeneration: null,
    documentGeneration: false,
    systemPrompt: true,
    tools: false,
    contextWindow: 10_000,
    maxOutputTokens: 200,
  },
  maxOutputTokens: 200,
  defaultMaxOutputTokens: 100,
  quotaWeight: 1,
  config: { systemAddendum: 'Model addendum.' },
};

const mockProvider: ProviderRuntimeConfig = {
  providerId: 'p-1',
  key: 'openai',
  adapter: 'openai',
  config: {},
  secrets: { apiKey: 'sk-test' },
};

describe('Context Builder', () => {
  it('requests the image output modality only when the client opts in', () => {
    const base = {
      requestId: 'req-img',
      generationId: 'gen-img',
      model: {
        ...mockModel,
        capabilities: {
          ...mockModel.capabilities,
          imageGeneration: { mode: 'tool' as const },
        },
      },
      provider: mockProvider,
      newParts: [{ type: 'text' as const, text: 'draw a cat' }],
      history: [],
      userIdHash: 'hash-1',
    };

    expect(buildContext(base).request.responseModalities).toEqual(['text']);
    expect(buildContext({ ...base, imageGeneration: true }).request.responseModalities).toEqual([
      'text',
      'image',
    ]);
  });

  it('ignores the opt-in when the model cannot generate images', () => {
    const result = buildContext({
      requestId: 'req-img',
      generationId: 'gen-img',
      model: mockModel,
      provider: mockProvider,
      newParts: [{ type: 'text', text: 'draw a cat' }],
      history: [],
      userIdHash: 'hash-1',
      imageGeneration: true,
    });

    expect(result.request.responseModalities).toEqual(['text']);
  });

  it('carries the resolved reasoning effort into the request', () => {
    const base = {
      requestId: 'req-reasoning',
      generationId: 'gen-reasoning',
      model: mockModel,
      provider: mockProvider,
      newParts: [{ type: 'text' as const, text: 'Think it through' }],
      history: [],
      userIdHash: 'hash-1',
    };

    expect(buildContext(base).request.reasoningEffort).toBeUndefined();
    expect(buildContext({ ...base, reasoningEffort: 'xhigh' }).request.reasoningEffort).toBe(
      'xhigh',
    );
  });

  it('concatenates system prompts and calculates remaining budget', () => {
    const result = buildContext({
      requestId: 'req-1',
      generationId: 'gen-1',
      model: mockModel,
      provider: mockProvider,
      platformSystemPrompt: 'Platform prompt.',
      newParts: [{ type: 'text', text: 'Hello AI' }],
      history: [],
      userIdHash: 'hash-1',
    });

    expect(result.request.system).toBe('Platform prompt.\n\nModel addendum.');
    expect(result.request.messages).toHaveLength(1);
    expect(result.request.messages[0]?.role).toBe('user');
    expect(result.truncation.truncated).toBe(false);
  });

  it('truncates history when budget is exceeded', () => {
    const historyItem = (seq: number, text: string) => ({
      message: {
        id: `msg-${seq}`,
        conversationId: 'c-1',
        seq,
        role: 'user' as const,
        status: 'complete' as const,
        finishReason: 'stop' as const,
        supersededBy: null,
        metadata: {},
        createdAt: new Date(),
        completedAt: new Date(),
      },
      parts: [
        {
          id: `p-${seq}`,
          messageId: `msg-${seq}`,
          position: 0,
          type: 'text' as const,
          status: 'complete' as const,
          textContent: text,
          data: {},
          fileId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });

    const longText = 'x'.repeat(25_000);
    const history = [historyItem(1, longText), historyItem(2, longText)];

    const result = buildContext({
      requestId: 'req-1',
      generationId: 'gen-1',
      model: mockModel,
      provider: mockProvider,
      newParts: [{ type: 'text', text: 'New prompt' }],
      history,
      userIdHash: 'hash-1',
    });

    expect(result.truncation.truncated).toBe(true);
    expect(result.truncation.droppedMessageCount).toBeGreaterThan(0);
    expect(result.request.messages.length).toBeLessThan(3);
  });

  it('replays resolvable history images and skips the rest', () => {
    const roomyModel: ModelRuntimeConfig = {
      ...mockModel,
      capabilities: { ...mockModel.capabilities, contextWindow: 200_000 },
    };
    const imagePart = (id: string, fileId: string) => ({
      id,
      messageId: 'msg-1',
      position: 0,
      type: 'image' as const,
      status: 'complete' as const,
      textContent: null,
      data: {},
      fileId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const history = [
      {
        message: {
          id: 'msg-1',
          conversationId: 'c-1',
          seq: 1,
          role: 'user' as const,
          status: 'complete' as const,
          finishReason: 'stop' as const,
          supersededBy: null,
          metadata: {},
          createdAt: new Date(),
          completedAt: new Date(),
        },
        parts: [imagePart('p-1', 'file-1'), imagePart('p-2', 'file-missing')],
      },
      {
        message: {
          id: 'msg-2',
          conversationId: 'c-1',
          seq: 2,
          role: 'assistant' as const,
          status: 'complete' as const,
          finishReason: 'stop' as const,
          supersededBy: null,
          metadata: {},
          createdAt: new Date(),
          completedAt: new Date(),
        },
        parts: [
          {
            id: 'p-3',
            messageId: 'msg-2',
            position: 0,
            type: 'text' as const,
            status: 'complete' as const,
            textContent: 'Nice cat.',
            data: {},
            fileId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
    ];

    const result = buildContext({
      requestId: 'req-img-history',
      generationId: 'gen-img-history',
      model: roomyModel,
      provider: mockProvider,
      newParts: [{ type: 'text', text: 'make it blue' }],
      history,
      userIdHash: 'hash-1',
      images: [
        {
          fileId: 'file-1',
          mimeType: 'image/png',
          name: 'cat.png',
          sizeBytes: 1024,
          width: 1024,
          height: 1024,
          read: () => Promise.resolve(new Uint8Array([1, 2, 3])),
          stream: () => Promise.resolve(new ReadableStream<Uint8Array>()),
        },
      ],
    });

    const replayedParts = result.request.messages[0]?.parts ?? [];
    expect(replayedParts).toHaveLength(1);
    expect(replayedParts[0]).toMatchObject({ type: 'image', file: { fileId: 'file-1' } });
  });

  it('ignores history images when none are resolved', () => {
    const result = buildContext({
      requestId: 'req-img-none',
      generationId: 'gen-img-none',
      model: {
        ...mockModel,
        capabilities: { ...mockModel.capabilities, contextWindow: 200_000 },
      },
      provider: mockProvider,
      newParts: [{ type: 'text', text: 'hello' }],
      history: [
        {
          message: {
            id: 'msg-1',
            conversationId: 'c-1',
            seq: 1,
            role: 'user' as const,
            status: 'complete' as const,
            finishReason: 'stop' as const,
            supersededBy: null,
            metadata: {},
            createdAt: new Date(),
            completedAt: new Date(),
          },
          parts: [
            {
              id: 'p-1',
              messageId: 'msg-1',
              position: 0,
              type: 'image' as const,
              status: 'complete' as const,
              textContent: null,
              data: {},
              fileId: 'file-1',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        },
        {
          message: {
            id: 'msg-2',
            conversationId: 'c-1',
            seq: 2,
            role: 'assistant' as const,
            status: 'complete' as const,
            finishReason: 'stop' as const,
            supersededBy: null,
            metadata: {},
            createdAt: new Date(),
            completedAt: new Date(),
          },
          parts: [
            {
              id: 'p-2',
              messageId: 'msg-2',
              position: 0,
              type: 'text' as const,
              status: 'complete' as const,
              textContent: 'Nice image.',
              data: {},
              fileId: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        },
      ],
      userIdHash: 'hash-1',
    });

    expect(result.request.messages).toHaveLength(3);
    expect(result.request.messages[0]?.parts).toEqual([{ type: 'text', text: ' ' }]);
  });

  it('throws context_too_large if new prompt alone exceeds context window', () => {
    const hugeText = 'x'.repeat(40_000);
    try {
      buildContext({
        requestId: 'req-1',
        generationId: 'gen-1',
        model: mockModel,
        provider: mockProvider,
        newParts: [{ type: 'text', text: hugeText }],
        history: [],
        userIdHash: 'hash-1',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('context_too_large');
    }
  });

  it('retains prior user message when preceding assistant message in history failed', () => {
    const history = [
      {
        message: {
          id: 'msg-1',
          conversationId: 'c-1',
          seq: 1,
          role: 'user' as const,
          status: 'complete' as const,
          finishReason: null,
          supersededBy: null,
          metadata: {},
          createdAt: new Date(),
          completedAt: new Date(),
        },
        parts: [
          {
            id: 'p-1',
            messageId: 'msg-1',
            position: 0,
            type: 'text' as const,
            status: 'complete' as const,
            textContent: 'Initial user query',
            data: {},
            fileId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
      {
        message: {
          id: 'msg-2',
          conversationId: 'c-1',
          seq: 2,
          role: 'assistant' as const,
          status: 'failed' as const,
          finishReason: 'error' as const,
          supersededBy: null,
          metadata: {},
          createdAt: new Date(),
          completedAt: new Date(),
        },
        parts: [
          {
            id: 'p-2',
            messageId: 'msg-2',
            position: 0,
            type: 'text' as const,
            status: 'failed' as const,
            textContent: 'Partial failed answer',
            data: {},
            fileId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
    ];

    const result = buildContext({
      requestId: 'req-1',
      generationId: 'gen-1',
      model: mockModel,
      provider: mockProvider,
      newParts: [{ type: 'text', text: 'Follow-up after failure' }],
      history,
      userIdHash: 'hash-1',
    });

    expect(result.request.messages).toHaveLength(2);
    expect(result.request.messages[0]?.role).toBe('user');
    expect(result.request.messages[0]?.parts[0]).toEqual({
      type: 'text',
      text: 'Initial user query',
    });
    expect(result.request.messages[1]?.role).toBe('user');
    expect(result.request.messages[1]?.parts[0]).toEqual({
      type: 'text',
      text: 'Follow-up after failure',
    });
    expect(result.truncation.droppedMessageCount).toBe(1);
  });

  it('incorporates historical document extracted text into context message text', () => {
    const history = [
      {
        message: {
          id: 'msg-doc',
          conversationId: 'c-1',
          seq: 1,
          role: 'user' as const,
          status: 'complete' as const,
          finishReason: null,
          supersededBy: null,
          metadata: {},
          createdAt: new Date(),
          completedAt: new Date(),
        },
        parts: [
          {
            id: 'p-doc',
            messageId: 'msg-doc',
            position: 0,
            type: 'document' as const,
            status: 'complete' as const,
            textContent: null,
            data: { filename: 'report.pdf', extractedText: 'Annual revenue was 5M.' },
            fileId: 'file-123',
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
      {
        message: {
          id: 'msg-ans',
          conversationId: 'c-1',
          seq: 2,
          role: 'assistant' as const,
          status: 'complete' as const,
          finishReason: 'stop' as const,
          supersededBy: null,
          metadata: {},
          createdAt: new Date(),
          completedAt: new Date(),
        },
        parts: [
          {
            id: 'p-ans',
            messageId: 'msg-ans',
            position: 0,
            type: 'text' as const,
            status: 'complete' as const,
            textContent: 'Understood.',
            data: {},
            fileId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
    ];

    const result = buildContext({
      requestId: 'req-hist-doc',
      generationId: 'gen-hist-doc',
      model: mockModel,
      provider: mockProvider,
      newParts: [{ type: 'text', text: 'What was the revenue?' }],
      history,
      userIdHash: 'hash-1',
    });

    expect(result.request.messages).toHaveLength(3);
    const firstMsgText = (result.request.messages[0]?.parts[0] as { text: string }).text;
    expect(firstMsgText).toContain('Annual revenue was 5M.');
  });

  it('anchors history at a stored compaction block and drops everything older', () => {
    const compactingModel: ModelRuntimeConfig = {
      ...mockModel,
      capabilities: { ...mockModel.capabilities, compaction: {} },
    };

    const history = [
      userItem(1, 'ancient question'),
      assistantTextItem(2, 'ancient answer'),
      {
        message: {
          id: 'msg-c-3',
          conversationId: 'c-1',
          seq: 3,
          role: 'assistant' as const,
          status: 'complete' as const,
          finishReason: 'stop' as const,
          supersededBy: null,
          metadata: {},
          createdAt: new Date(),
          completedAt: new Date(),
        },
        parts: [
          {
            id: 'p-c-3',
            messageId: 'msg-c-3',
            position: 0,
            type: 'compaction' as const,
            status: 'complete' as const,
            textContent: null,
            data: {
              provider: 'anthropic',
              payload: { type: 'compaction', content: 'summary of turns' },
            },
            fileId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          {
            id: 'p-c-3b',
            messageId: 'msg-c-3',
            position: 1,
            type: 'text' as const,
            status: 'complete' as const,
            textContent: 'answer after compaction',
            data: {},
            fileId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
    ];

    const result = buildContext({
      requestId: 'req-compact',
      generationId: 'gen-compact',
      model: compactingModel,
      provider: { ...mockProvider, key: 'anthropic', adapter: 'anthropic' },
      newParts: [{ type: 'text', text: 'next question' }],
      history,
      userIdHash: 'hash-1',
    });

    expect(result.request.messages).toHaveLength(2);
    expect(result.request.messages[0]?.role).toBe('assistant');
    expect(result.request.messages[0]?.parts[0]).toEqual({
      type: 'compaction',
      provider: 'anthropic',
      payload: { type: 'compaction', content: 'summary of turns' },
    });
    expect(result.request.messages[1]?.role).toBe('user');
    expect(result.truncation.reason).toBe('none');
    expect(result.truncation.truncated).toBe(false);
    expect(result.truncation.droppedMessageCount).toBe(0);
    expect(result.truncation.compactedMessageCount).toBe(2);
  });

  it('throws context_too_large when the compaction anchor cannot fit in model context window', () => {
    const compactingModel: ModelRuntimeConfig = {
      ...mockModel,
      capabilities: { ...mockModel.capabilities, compaction: {}, contextWindow: 2000, maxOutputTokens: 200 },
      defaultMaxOutputTokens: 200,
    };

    const history = [
      {
        message: {
          id: 'msg-huge-c',
          conversationId: 'c-1',
          seq: 1,
          role: 'assistant' as const,
          status: 'complete' as const,
          finishReason: 'stop' as const,
          supersededBy: null,
          metadata: {},
          createdAt: new Date(),
          completedAt: new Date(),
        },
        parts: [
          {
            id: 'p-huge',
            messageId: 'msg-huge-c',
            position: 0,
            type: 'compaction' as const,
            status: 'complete' as const,
            textContent: null,
            data: {
              provider: 'anthropic',
              payload: { type: 'compaction', content: 'w'.repeat(10_000) },
            },
            fileId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
    ];

    expect(() =>
      buildContext({
        requestId: 'req-huge-compact',
        generationId: 'gen-huge-compact',
        model: compactingModel,
        provider: mockProvider,
        newParts: [{ type: 'text', text: 'new prompt' }],
        history,
        userIdHash: 'hash-1',
      }),
    ).toThrowError(/exceed model context window/);
  });

  it('converts readable Anthropic compaction summary to text on cross-provider replay', () => {
    const openaiProvider: ProviderRuntimeConfig = {
      providerId: 'p-openai',
      key: 'openai',
      adapter: 'openai',
      config: {},
      secrets: {},
    };

    const history = [
      {
        message: {
          id: 'msg-anthro-c',
          conversationId: 'c-1',
          seq: 1,
          role: 'assistant' as const,
          status: 'complete' as const,
          finishReason: 'stop' as const,
          supersededBy: null,
          metadata: {},
          createdAt: new Date(),
          completedAt: new Date(),
        },
        parts: [
          {
            id: 'p-anthro',
            messageId: 'msg-anthro-c',
            position: 0,
            type: 'compaction' as const,
            status: 'complete' as const,
            textContent: null,
            data: {
              provider: 'anthropic',
              payload: { type: 'compaction', content: 'summary of old conversation' },
            },
            fileId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
    ];

    const result = buildContext({
      requestId: 'req-cross',
      generationId: 'gen-cross',
      model: { ...mockModel, capabilities: { ...mockModel.capabilities, compaction: {} } },
      provider: openaiProvider,
      newParts: [{ type: 'text', text: 'new turn' }],
      history,
      userIdHash: 'hash-1',
    });

    expect(result.request.messages[0]?.parts[0]?.type).toBe('text');
    expect((result.request.messages[0]?.parts[0] as { text: string }).text).toContain(
      'summary of old conversation',
    );
  });

  it('drops the compaction anchor when quota is too small to afford it', () => {
    const compactingModel: ModelRuntimeConfig = {
      ...mockModel,
      capabilities: { ...mockModel.capabilities, compaction: {} },
    };

    const history = [
      userItem(1, 'ancient question'),
      {
        message: {
          id: 'msg-c-3',
          conversationId: 'c-1',
          seq: 3,
          role: 'assistant' as const,
          status: 'complete' as const,
          finishReason: 'stop' as const,
          supersededBy: null,
          metadata: {},
          createdAt: new Date(),
          completedAt: new Date(),
        },
        parts: [
          {
            id: 'p-c-3',
            messageId: 'msg-c-3',
            position: 0,
            type: 'compaction' as const,
            status: 'complete' as const,
            textContent: null,
            data: {
              provider: 'anthropic',
              payload: { type: 'compaction', content: 's'.repeat(40_000) },
            },
            fileId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      },
      userItem(4, 'recent question'),
      assistantTextItem(5, 'recent answer'),
    ];

    const result = buildContext({
      requestId: 'req-compact-quota',
      generationId: 'gen-compact-quota',
      model: compactingModel,
      provider: mockProvider,
      newParts: [{ type: 'text', text: 'next question' }],
      history,
      userIdHash: 'hash-1',
      userRemainingQuota: 5_000,
    });

    // The summary no longer fits, so only the turns after it are sent.
    expect(result.request.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(result.request.messages[0]?.parts[0]?.type).toBe('text');
    expect(result.truncation.reason).toBe('quota');
  });

  it('trims history to the remaining quota instead of failing', () => {
    const history = [
      userItem(1, 'x'.repeat(10_000)),
      assistantTextItem(2, 'y'.repeat(10_000)),
      userItem(3, 'z'.repeat(10_000)),
      assistantTextItem(4, 'w'.repeat(10_000)),
    ];

    const result = buildContext({
      requestId: 'req-quota',
      generationId: 'gen-quota',
      model: mockModel,
      provider: mockProvider,
      newParts: [{ type: 'text', text: 'still answer me' }],
      history,
      userIdHash: 'hash-1',
      userRemainingQuota: 1_500,
    });

    expect(result.request.messages).toHaveLength(1);
    expect(result.truncation.truncated).toBe(true);
    expect(result.truncation.reason).toBe('quota');
  });

  it('reports context_window when the model window is the binding constraint', () => {
    const history = [
      userItem(1, 'x'.repeat(25_000)),
      assistantTextItem(2, 'y'.repeat(25_000)),
    ];

    const result = buildContext({
      requestId: 'req-window',
      generationId: 'gen-window',
      model: mockModel,
      provider: mockProvider,
      newParts: [{ type: 'text', text: 'New prompt' }],
      history,
      userIdHash: 'hash-1',
    });

    expect(result.truncation.truncated).toBe(true);
    expect(result.truncation.reason).toBe('context_window');
  });
});

function historyMessage(seq: number, role: 'user' | 'assistant') {
  return {
    id: `msg-${seq}`,
    conversationId: 'c-1',
    seq,
    role,
    status: 'complete' as const,
    finishReason: role === 'assistant' ? ('stop' as const) : null,
    supersededBy: null,
    metadata: {},
    createdAt: new Date(),
    completedAt: new Date(),
  };
}

function userItem(seq: number, text: string) {
  return {
    message: historyMessage(seq, 'user'),
    parts: [
      {
        id: `p-${seq}`,
        messageId: `msg-${seq}`,
        position: 0,
        type: 'text' as const,
        status: 'complete' as const,
        textContent: text,
        data: {},
        fileId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
}

function assistantTextItem(seq: number, text: string) {
  return {
    message: historyMessage(seq, 'assistant'),
    parts: [
      {
        id: `p-${seq}`,
        messageId: `msg-${seq}`,
        position: 0,
        type: 'text' as const,
        status: 'complete' as const,
        textContent: text,
        data: {},
        fileId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
  };
}
