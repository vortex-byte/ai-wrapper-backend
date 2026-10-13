import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { OpenAIAdapter, type OpenAIClientLike } from '@/providers/infrastructure/adapters/openai/adapter.ts';
import { makeChatRequest } from '@/providers/infrastructure/fake/fake-provider.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';

function createMockOpenAIClient(chunks: unknown[]): OpenAIClientLike {
  return {
    models: {
      async list() {
        return { data: [{ id: 'gpt-4o' }] };
      },
    },
    chat: {
      completions: {
        async create() {
          return (async function* () {
            for (const chunk of chunks) {
              yield chunk;
            }
          })();
        },
      },
    },
  };
}

describe('OpenAIAdapter (Unit)', () => {
  it('converts normalized request and streams chunks with usage', async () => {
    const mockChunks = [
      {
        id: 'chatcmpl-123',
        choices: [{ index: 0, delta: { content: 'Hello' } }],
      },
      {
        id: 'chatcmpl-123',
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      },
    ];

    const adapter = new OpenAIAdapter(() => createMockOpenAIClient(mockChunks));

    const req = makeChatRequest({
      model: {
        modelId: 'm-openai',
        providerId: 'p-openai',
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
          contextWindow: 128000,
          maxOutputTokens: 4096,
        },
        maxOutputTokens: 4096,
        defaultMaxOutputTokens: 2048,
        quotaWeight: 1,
        config: {},
      },
      provider: {
        providerId: 'p-openai',
        key: 'openai',
        adapter: 'openai',
        config: {},
        secrets: { apiKey: 'sk-test-key-01234567890123456789' },
      },
    });

    const events: GenerationEvent[] = [];
    for await (const event of adapter.execute(req, {
      signal: new AbortController().signal,
      deadline: Date.now() + 5000,
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: 'started', providerRequestId: 'chatcmpl-123' });
    expect(events[1]).toEqual({ type: 'part_started', index: 0, partType: 'text' });
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual([
      'Hello',
      ' world',
    ]);
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 2,
        reasoningTokens: 0,
        source: 'provider',
      },
      final: true,
    });
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'stop' });
  });

  it('translates OpenAI 429 rate limit errors with retry-after', () => {
    const adapter = new OpenAIAdapter();
    const error = new OpenAI.RateLimitError(
      429,
      { error: { message: 'Rate limit exceeded' } },
      'Rate limit exceeded',
      new Headers({ 'retry-after': '3' }),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('provider_rate_limited');
    expect(translated.retryable).toBe(true);
    expect(translated.retryAfterMs).toBe(3000);
  });

  it('translates context_length_exceeded error to context_too_large', () => {
    const adapter = new OpenAIAdapter();
    const error = new OpenAI.BadRequestError(
      400,
      { error: { message: 'context_length_exceeded' } },
      'maximum context length exceeded',
      new Headers(),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('context_too_large');
    expect(translated.retryable).toBe(false);
  });

  it('estimates tokens with js-tiktoken exact confidence', async () => {
    const adapter = new OpenAIAdapter();
    const req = makeChatRequest({
      model: {
        modelId: 'm-1',
        providerId: 'p-1',
        apiModelId: 'gpt-4o',
        displayName: 'GPT-4o',
        capabilities: {
          streaming: true,
          vision: true,
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
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello world' }] }],
    });

    const est = await adapter.estimateInputTokens(req);
    expect(est.confidence).toBe('exact');
    expect(est.tokens).toBeGreaterThan(0);
  });
});
