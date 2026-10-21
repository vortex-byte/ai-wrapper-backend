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
    imageGeneration: false,
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
      model: { ...mockModel, capabilities: { ...mockModel.capabilities, imageGeneration: true } },
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
});
