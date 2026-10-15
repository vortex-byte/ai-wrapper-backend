import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  AnthropicAdapter,
  type AnthropicClientLike,
} from '@/providers/infrastructure/adapters/anthropic/adapter.ts';
import { makeChatRequest } from '@/providers/infrastructure/fake/fake-provider.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
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

function makeAnthropicRequest(
  overrides: Partial<NormalizedChatRequest> = {},
): NormalizedChatRequest {
  return makeChatRequest({
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
    ...overrides,
  });
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
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 20,
          },
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
        inputTokens: 200,
        outputTokens: 5,
        cachedInputTokens: 80,
        source: 'provider',
      },
      final: true,
    });
  });

  it('handles content_block_start, multiple blocks, and content_block_stop', async () => {
    const mockEvents = [
      {
        type: 'message_start',
        message: { id: 'msg-multi-block', usage: { input_tokens: 10 } },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'First block' },
      },
      {
        type: 'content_block_stop',
        index: 0,
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Second block' },
      },
      {
        type: 'content_block_stop',
        index: 1,
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 6 },
      },
    ];

    const adapter = new AnthropicAdapter(() => createMockAnthropicClient(mockEvents));
    const req = makeAnthropicRequest();
    const events: GenerationEvent[] = [];
    for await (const event of adapter.execute(req, {
      signal: new AbortController().signal,
      deadline: Date.now() + 5000,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: 'started', providerRequestId: 'msg-multi-block' },
      { type: 'part_started', index: 0, partType: 'text' },
      { type: 'text_delta', index: 0, text: 'First block' },
      { type: 'part_done', index: 0 },
      { type: 'part_started', index: 1, partType: 'text' },
      { type: 'text_delta', index: 1, text: 'Second block' },
      { type: 'part_done', index: 1 },
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 6, source: 'provider' },
        final: true,
      },
      { type: 'finished', reason: 'stop' },
    ]);
  });

  it('handles mid-stream error events and aborts without emitting finished', async () => {
    const mockEvents = [
      {
        type: 'message_start',
        message: { id: 'msg-err', usage: { input_tokens: 15 } },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Partial text' },
      },
      {
        type: 'error',
        error: { type: 'overloaded_error', message: 'Anthropic is overloaded' },
      },
    ];

    const adapter = new AnthropicAdapter(() => createMockAnthropicClient(mockEvents));
    const req = makeAnthropicRequest();
    const events: GenerationEvent[] = [];
    for await (const event of adapter.execute(req, {
      signal: new AbortController().signal,
      deadline: Date.now() + 5000,
    })) {
      events.push(event);
    }

    const lastEvent = events.at(-1);
    expect(lastEvent?.type).toBe('error');
    if (lastEvent?.type === 'error') {
      expect(lastEvent.error.category).toBe('service_busy');
      expect(lastEvent.error.retryable).toBe(true);
    }
    expect(events.some((e) => e.type === 'finished')).toBe(false);
  });

  it('maps stop reasons refusal to content_filter and model_context_window_exceeded to length', async () => {
    const testReason = async (stopReason: string) => {
      const mockEvents = [
        {
          type: 'message_start',
          message: { id: 'msg-stop-test', usage: { input_tokens: 5 } },
        },
        {
          type: 'message_delta',
          delta: { stop_reason: stopReason },
          usage: { output_tokens: 2 },
        },
      ];
      const adapter = new AnthropicAdapter(() => createMockAnthropicClient(mockEvents));
      const req = makeAnthropicRequest();
      const events: GenerationEvent[] = [];
      for await (const event of adapter.execute(req, {
        signal: new AbortController().signal,
        deadline: Date.now() + 5000,
      })) {
        events.push(event);
      }
      return (events.find((e) => e.type === 'finished') as { reason: string } | undefined)?.reason;
    };

    expect(await testReason('refusal')).toBe('content_filter');
    expect(await testReason('model_context_window_exceeded')).toBe('length');
  });

  it('translates Anthropic 413 request_too_large to context_too_large', () => {
    const adapter = new AnthropicAdapter();
    const error = new Anthropic.APIError(
      413,
      { type: 'error', error: { type: 'request_too_large', message: 'Request exceeds max tokens' } },
      'Request exceeds max tokens',
      new Headers(),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('context_too_large');
    expect(translated.retryable).toBe(false);
  });

  it('translates 529 overloaded_error with retry-after header', () => {
    const adapter = new AnthropicAdapter();
    const error = new Anthropic.APIError(
      529,
      { type: 'error', error: { type: 'overloaded_error', message: 'Service overloaded' } },
      'Service overloaded',
      new Headers({ 'retry-after': '12' }),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('service_busy');
    expect(translated.retryable).toBe(true);
    expect(translated.retryAfterMs).toBe(12000);
  });

  it('formats requests with non-empty content and ensures first message is user', () => {
    const adapter = new AnthropicAdapter();

    // Leading assistant message with empty parts
    const req = makeChatRequest({
      messages: [
        {
          role: 'assistant',
          parts: [],
        },
        {
          role: 'user',
          parts: [{ type: 'text', text: 'Hello' }],
        },
      ],
    });

    const providerReq = adapter.toProviderRequest(req) as {
      messages: Array<{ role: string; content: string }>;
    };

    expect(providerReq.messages.length).toBeGreaterThanOrEqual(2);
    expect(providerReq.messages[0]?.role).toBe('user');
    for (const msg of providerReq.messages) {
      expect(msg.content.length).toBeGreaterThanOrEqual(1);
    }
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

  it('translates 500 internal error with retry-after header', () => {
    const adapter = new AnthropicAdapter();
    const error = new Anthropic.InternalServerError(
      500,
      { type: 'error', error: { type: 'api_error', message: 'Internal error' } },
      'Internal error',
      new Headers({ 'retry-after': '3' }),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('provider_unavailable');
    expect(translated.retryable).toBe(true);
    expect(translated.retryAfterMs).toBe(3000);
  });

  it('translates plain object mid-stream error events', () => {
    const adapter = new AnthropicAdapter();

    const overloaded = adapter.translateError({
      type: 'overloaded_error',
      message: 'Capacity full',
    });
    expect(overloaded.category).toBe('service_busy');
    expect(overloaded.retryable).toBe(true);

    const rateLimit = adapter.translateError({
      type: 'rate_limit_error',
      message: 'Rate limit',
    });
    expect(rateLimit.category).toBe('provider_rate_limited');
    expect(rateLimit.retryable).toBe(true);
  });

  it('maps SDK timeout and abort errors to timeout/cancelled', () => {
    const adapter = new AnthropicAdapter();

    const timedOut = adapter.translateError(new Anthropic.APIConnectionTimeoutError());
    expect(timedOut.category).toBe('generation_timeout');
    expect(timedOut.retryable).toBe(true);

    const aborted = adapter.translateError(new Anthropic.APIUserAbortError());
    expect(aborted.category).toBe('generation_cancelled');
    expect(aborted.retryable).toBe(false);
  });

  it('maps HTTP 408 to generation_timeout', () => {
    const adapter = new AnthropicAdapter();
    const error = new Anthropic.APIError(
      408,
      { type: 'error', error: { type: 'timeout_error', message: 'Request timed out' } },
      'Request timed out',
      new Headers(),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('generation_timeout');
    expect(translated.retryable).toBe(true);
  });

  it('handles empty messages array and combines adjacent turns of same role', () => {
    const adapter = new AnthropicAdapter();

    const emptyReq = makeChatRequest({ messages: [] });
    const emptyProviderReq = adapter.toProviderRequest(emptyReq) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(emptyProviderReq.messages).toEqual([{ role: 'user', content: ' ' }]);

    const adjacentReq = makeChatRequest({
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'Part 1' }] },
        { role: 'user', parts: [{ type: 'text', text: 'Part 2' }] },
      ],
    });
    const adjacentProviderReq = adapter.toProviderRequest(adjacentReq) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(adjacentProviderReq.messages).toEqual([
      { role: 'user', content: 'Part 1\n\nPart 2' },
    ]);
  });
});
