import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicAdapter,
  type AnthropicClientLike,
} from '@/providers/infrastructure/adapters/anthropic/adapter.ts';
import { makeChatRequest } from '@/providers/infrastructure/fake/fake-provider.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';

function createMockAnthropicClient(events: unknown[]): AnthropicClientLike {
  return {
    models: {
      async list() {
        return { data: [{ id: 'claude-3-5-sonnet-20241022' }] };
      },
    },
    messages: {
      async create() {
        return (async function* () {
          for (const ev of events) {
            yield ev;
          }
        })();
      },
    },
  };
}

describe('AnthropicAdapter (Unit)', () => {
  it('translates Anthropic streaming messages and tracks usage', async () => {
    const mockEvents = [
      {
        type: 'message_start',
        message: {
          id: 'msg-claude-1',
          usage: { input_tokens: 25 },
        },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Bonjour' },
      },
      {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: ' le monde' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 12 },
      },
    ];

    const adapter = new AnthropicAdapter(() => createMockAnthropicClient(mockEvents));

    const req = makeChatRequest({
      model: {
        modelId: 'm-anthropic',
        providerId: 'p-anthropic',
        apiModelId: 'claude-3-5-sonnet-20241022',
        displayName: 'Claude 3.5 Sonnet',
        capabilities: {
          streaming: true,
          vision: true,
          documents: { pdf: true },
          imageGeneration: false,
          documentGeneration: false,
          systemPrompt: true,
          tools: false,
          contextWindow: 200000,
          maxOutputTokens: 8192,
        },
        maxOutputTokens: 8192,
        defaultMaxOutputTokens: 4096,
        quotaWeight: 1,
        config: {},
      },
      provider: {
        providerId: 'p-anthropic',
        key: 'anthropic',
        adapter: 'anthropic',
        config: {},
        secrets: { apiKey: 'sk-ant-test-key-01234567890123456789' },
      },
    });

    const events: GenerationEvent[] = [];
    for await (const event of adapter.execute(req, {
      signal: new AbortController().signal,
      deadline: Date.now() + 5000,
    })) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: 'started', providerRequestId: 'msg-claude-1' });
    expect(events[1]).toEqual({ type: 'part_started', index: 0, partType: 'text' });
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual([
      'Bonjour',
      ' le monde',
    ]);
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 25,
        outputTokens: 12,
        source: 'provider',
      },
      final: true,
    });
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'stop' });
  });

  it('captures prompt caching tokens from message_start usage', async () => {
    const mockEvents = [
      {
        type: 'message_start',
        message: {
          id: 'msg-claude-cache',
          usage: { input_tokens: 100, cache_read_input_tokens: 80 },
        },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Cached answer' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 5 },
      },
    ];

    const adapter = new AnthropicAdapter(() => createMockAnthropicClient(mockEvents));
    const req = makeChatRequest({
      model: {
        modelId: 'm-anthropic',
        providerId: 'p-anthropic',
        apiModelId: 'claude-3-5-sonnet-20241022',
        displayName: 'Claude 3.5 Sonnet',
        capabilities: {
          streaming: true,
          vision: true,
          documents: { pdf: true },
          imageGeneration: false,
          documentGeneration: false,
          systemPrompt: true,
          tools: false,
          contextWindow: 200000,
          maxOutputTokens: 8192,
        },
        maxOutputTokens: 8192,
        defaultMaxOutputTokens: 4096,
        quotaWeight: 1,
        config: {},
      },
      provider: {
        providerId: 'p-anthropic',
        key: 'anthropic',
        adapter: 'anthropic',
        config: {},
        secrets: { apiKey: 'sk-ant-test-key-01234567890123456789' },
      },
    });
    const events: GenerationEvent[] = [];

    for await (const event of adapter.execute(req, {
      signal: new AbortController().signal,
      deadline: Date.now() + 5000,
    })) {
      events.push(event);
    }

    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 100,
        outputTokens: 5,
        cachedInputTokens: 80,
        source: 'provider',
      },
      final: true,
    });
  });

  it('translates Anthropic 429 rate limit errors with retry-after header', () => {
    const adapter = new AnthropicAdapter();
    const error = new Anthropic.RateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limit hit' } },
      'Rate limit hit',
      new Headers({ 'retry-after': '5' }),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('provider_rate_limited');
    expect(translated.retryable).toBe(true);
    expect(translated.retryAfterMs).toBe(5000);
  });

  it('translates prompt too long error to context_too_large', () => {
    const adapter = new AnthropicAdapter();
    const error = new Anthropic.BadRequestError(
      400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } },
      'prompt is too long',
      new Headers(),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('context_too_large');
    expect(translated.retryable).toBe(false);
  });
});
