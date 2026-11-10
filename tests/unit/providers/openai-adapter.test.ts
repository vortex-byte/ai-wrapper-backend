import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { OpenAIAdapter } from '@/providers/infrastructure/adapters/openai/adapter.ts';
import type { OpenAIClientLike } from '@/providers/infrastructure/adapters/openai/adapter.ts';
import { buildMessages, buildRequest } from '@/providers/infrastructure/adapters/openai/chat/request.ts';
import { getTiktoken } from '@/providers/infrastructure/adapters/openai/estimate.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import {
  collect,
  makeOpenAIRequest,
  mockChatClient as createMockOpenAIClient,
  resolvedFile,
} from './openai/fixtures.ts';

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

    const req = makeOpenAIRequest();

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
    const req = makeOpenAIRequest({
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello world' }] }],
    });

    const est = await adapter.estimateInputTokens(req);
    expect(est.confidence).toBe('exact');
    expect(est.tokens).toBeGreaterThan(0);
  });

  it('emits usage after part_done (cross-adapter event order)', async () => {
    const mockChunks = [
      { id: 'chatcmpl-order', choices: [{ index: 0, delta: { content: 'Hi' } }] },
      {
        id: 'chatcmpl-order',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 2 },
      },
    ];
    const adapter = new OpenAIAdapter(() => createMockOpenAIClient(mockChunks));
    const events = await collect(adapter, makeOpenAIRequest());

    const partDoneIdx = events.findIndex((e) => e.type === 'part_done');
    const usageIdx = events.findIndex((e) => e.type === 'usage');
    expect(partDoneIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeGreaterThan(partDoneIdx);
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'stop' });
  });

  it('streams delta.refusal as text and finishes with content_filter', async () => {
    const mockChunks = [
      { id: 'chatcmpl-refuse', choices: [{ index: 0, delta: { refusal: 'I cannot help with that.' } }] },
      {
        id: 'chatcmpl-refuse',
        choices: [{ index: 0, delta: {}, finish_reason: 'content_filter' }],
        usage: { prompt_tokens: 9, completion_tokens: 6 },
      },
    ];
    const adapter = new OpenAIAdapter(() => createMockOpenAIClient(mockChunks));
    const events = await collect(adapter, makeOpenAIRequest());

    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text)).toEqual([
      'I cannot help with that.',
    ]);
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'content_filter' });
  });

  it("maps finish_reason tool_calls to tool_use", async () => {
    const mockChunks = [
      {
        id: 'chatcmpl-tools',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 9, completion_tokens: 3 },
      },
    ];
    const adapter = new OpenAIAdapter(() => createMockOpenAIClient(mockChunks));
    const events = await collect(adapter, makeOpenAIRequest());
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'tool_use' });
  });

  it('treats billing 429 codes as non-retryable provider errors', () => {
    const adapter = new OpenAIAdapter();
    const error = new OpenAI.RateLimitError(
      429,
      {
        message: 'You exceeded your current quota.',
        type: 'insufficient_quota',
        code: 'credit_balance_exhausted',
      },
      'You exceeded your current quota.',
      new Headers(),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('provider_unavailable');
    expect(translated.retryable).toBe(false);
    expect(translated.providerCode).toBe('credit_balance_exhausted');
  });

  it('keeps slow_down 429 retryable with retry-after', () => {
    const adapter = new OpenAIAdapter();
    const error = new OpenAI.RateLimitError(
      429,
      { message: 'Slow down.', type: 'rate_limit_error', code: 'slow_down' },
      'Slow down.',
      new Headers({ 'retry-after': '2' }),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('provider_rate_limited');
    expect(translated.retryable).toBe(true);
    expect(translated.retryAfterMs).toBe(2000);
    expect(translated.providerCode).toBe('slow_down');
  });

  it('maps 503 server_is_overloaded to service_busy with retry-after', () => {
    const adapter = new OpenAIAdapter();
    const error = new OpenAI.InternalServerError(
      503,
      { message: 'Overloaded.', type: 'service_unavailable_error', code: 'server_is_overloaded' },
      'Overloaded.',
      new Headers({ 'retry-after': '7' }),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('service_busy');
    expect(translated.retryable).toBe(true);
    expect(translated.retryAfterMs).toBe(7000);
  });

  it('preserves retry-after, status, code and request id on 5xx', () => {
    const adapter = new OpenAIAdapter();
    const error = new OpenAI.InternalServerError(
      500,
      { message: 'Boom.', type: 'server_error', code: 'server_error' },
      'Boom.',
      new Headers({ 'retry-after': '5', 'x-request-id': 'req-abc-123' }),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('provider_unavailable');
    expect(translated.retryable).toBe(true);
    expect(translated.retryAfterMs).toBe(5000);
    expect(translated.providerStatus).toBe(500);
    expect(translated.providerCode).toBe('server_error');
    expect(translated.providerRequestId).toBe('req-abc-123');
  });

  it.each([
    [408, 'generation_timeout', true],
    [504, 'generation_timeout', true],
    [410, 'model_unavailable', false],
    [413, 'context_too_large', false],
    [422, 'content_filtered', false],
    [451, 'content_filtered', false],
  ])('maps HTTP %i to %s (retryable=%s)', (status, category, retryable) => {
    const adapter = new OpenAIAdapter();
    const error = new OpenAI.APIError(
      status,
      { message: `HTTP ${status}`, type: 'api_error' },
      `HTTP ${status}`,
      new Headers(),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe(category);
    expect(translated.retryable).toBe(retryable);
    expect(translated.providerStatus).toBe(status);
  });

  it('maps SDK timeout and abort errors to timeout/cancelled', () => {
    const adapter = new OpenAIAdapter();

    const timedOut = adapter.translateError(new OpenAI.APIConnectionTimeoutError());
    expect(timedOut.category).toBe('generation_timeout');
    expect(timedOut.retryable).toBe(true);

    const aborted = adapter.translateError(new OpenAI.APIUserAbortError());
    expect(aborted.category).toBe('generation_cancelled');
    expect(aborted.retryable).toBe(false);
  });

  it('maps 400 with structured context_length_exceeded code', () => {
    const adapter = new OpenAIAdapter();
    const error = new OpenAI.BadRequestError(
      400,
      { message: 'Too many tokens.', type: 'invalid_request_error', code: 'context_length_exceeded' },
      'Too many tokens.',
      new Headers(),
    );

    const translated = adapter.translateError(error);
    expect(translated.category).toBe('context_too_large');
    expect(translated.retryable).toBe(false);
    expect(translated.providerCode).toBe('context_length_exceeded');
  });

  it('maps mid-stream APIError without status by structured type', () => {
    const adapter = new OpenAIAdapter();
    const midStreamRateLimit = new OpenAI.APIError(
      undefined,
      { message: 'Too many requests.', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
      undefined,
      new Headers({ 'retry-after': '4' }),
    );

    const translated = adapter.translateError(midStreamRateLimit);
    expect(translated.category).toBe('provider_rate_limited');
    expect(translated.retryable).toBe(true);
    expect(translated.retryAfterMs).toBe(4000);
  });

  it('guards empty messages and empty content in toProviderRequest', () => {
    const adapter = new OpenAIAdapter();

    const empty = adapter.toProviderRequest(makeOpenAIRequest({ messages: [] })) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(empty.messages).toEqual([{ role: 'user', content: ' ' }]);

    const blankAssistant = adapter.toProviderRequest(
      makeOpenAIRequest({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
          { role: 'assistant', parts: [] },
        ],
      }),
    ) as { messages: Array<{ role: string; content: string }> };
    expect(blankAssistant.messages).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: ' ' },
    ]);

    const merged = adapter.toProviderRequest(
      makeOpenAIRequest({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'A' }] },
          { role: 'user', parts: [{ type: 'text', text: 'B' }] },
        ],
      }),
    ) as { messages: Array<{ role: string; content: string }> };
    expect(merged.messages).toEqual([{ role: 'user', content: 'A\n\nB' }]);
  });

  it('omits temperature/top_p for reasoning models but keeps them for classic models', () => {
    const adapter = new OpenAIAdapter();

    const reasoning = adapter.toProviderRequest(
      makeOpenAIRequest({
        temperature: 0.7,
        topP: 0.9,
        model: { ...makeOpenAIRequest().model, apiModelId: 'o3-mini' },
      }),
    ) as { temperature?: number; top_p?: number };
    expect(reasoning.temperature).toBeUndefined();
    expect(reasoning.top_p).toBeUndefined();

    const classic = adapter.toProviderRequest(
      makeOpenAIRequest({ temperature: 0.7, topP: 0.9 }),
    ) as { temperature?: number; top_p?: number };
    expect(classic.temperature).toBe(0.7);
    expect(classic.top_p).toBe(0.9);

    const forcedOff = adapter.toProviderRequest(
      makeOpenAIRequest({
        temperature: 0.7,
        model: { ...makeOpenAIRequest().model, config: { reasoningEffort: 'medium' } },
      }),
    ) as { temperature?: number };
    expect(forcedOff.temperature).toBeUndefined();

    const forcedOn = adapter.toProviderRequest(
      makeOpenAIRequest({
        temperature: 0.7,
        model: {
          ...makeOpenAIRequest().model,
          apiModelId: 'o3-mini',
          config: { supportsSamplingParams: true },
        },
      }),
    ) as { temperature?: number };
    expect(forcedOn.temperature).toBe(0.7);
  });

  it('uses o200k encodings for current model families', () => {
    expect(getTiktoken('gpt-5-mini')).not.toBeNull();
  });
});

describe('OpenAIAdapter — multimodal input and reasoning config', () => {
  it('streams with inline media resolved from the attachment bytes', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: OpenAIClientLike = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: async (params: unknown) => {
            calls.push(params as Record<string, unknown>);
            return (async function* () {
              yield { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'ok' } }] };
              yield { id: 'chatcmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
            })();
          },
        },
      },
    };

    const adapter = new OpenAIAdapter(() => client);
    await collect(
      adapter,
      makeOpenAIRequest({
        messages: [
          {
            role: 'user',
            parts: [
              { type: 'image', file: resolvedFile([1, 2, 3, 4], 'image/jpeg', 'shot.jpg') },
              {
                type: 'document',
                file: resolvedFile([9, 9], 'application/pdf', 'spec.pdf'),
                preferNative: true,
              },
              {
                type: 'document',
                file: resolvedFile(
                  [7],
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                  'sheet.xlsx',
                ),
                extractedText: 'a,b\n1,2',
                preferNative: true,
              },
              { type: 'text', text: 'summarise' },
            ],
          },
        ],
      }),
    );

    const messages = calls[0]?.['messages'] as Array<{ role: string; content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQIDBA==' } },
      {
        type: 'file',
        file: { file_data: 'data:application/pdf;base64,CQk=', filename: 'spec.pdf' },
      },
      {
        type: 'text',
        text: '<attached_document name="sheet.xlsx" untrusted="true">\na,b\n1,2\n</attached_document>',
      },
      { type: 'text', text: 'summarise' },
    ]);
  });

  it('forwards the hashed user id as safety_identifier', () => {
    const req = makeOpenAIRequest();
    const params = buildRequest(req, buildMessages(req)) as Record<string, unknown>;

    expect(params['safety_identifier']).toBe('hash-1');
  });

  it('forwards reasoning_effort from the registry config', () => {
    const req = makeOpenAIRequest();
    const params = buildRequest(
      { ...req, model: { ...req.model, apiModelId: 'o4-mini', config: { reasoningEffort: 'high' } } },
      buildMessages(req),
    ) as Record<string, unknown>;

    expect(params['reasoning_effort']).toBe('high');
  });

  it('lets the per-request reasoning effort override the registry config', () => {
    const req = makeOpenAIRequest({ temperature: 0.4 });
    const params = buildRequest(
      { ...req, reasoningEffort: 'low', model: { ...req.model, config: { reasoningEffort: 'high' } } },
      buildMessages(req),
    ) as Record<string, unknown>;

    expect(params['reasoning_effort']).toBe('low');
  });

  it('lists only chat-capable models sorted by id', async () => {
    const adapter = new OpenAIAdapter(() => ({
      models: {
        async list() {
          return {
            data: [
              { id: 'text-embedding-3-small' },
              { id: 'whisper-1' },
              { id: 'o4-mini' },
              { id: 'dall-e-3' },
              { id: 'gpt-4o' },
            ],
          };
        },
      },
      chat: { completions: { create: async () => (async function* () {})() } },
    }));

    const models = await adapter.listModels({
      provider: makeOpenAIRequest().provider,
      signal: new AbortController().signal,
    });
    expect(models.map((model) => model.id)).toEqual(['gpt-4o', 'o4-mini']);
  });

  it('filters out models with an announced shutdown date', async () => {
    const adapter = new OpenAIAdapter(() => ({
      models: {
        async list() {
          return {
            data: [
              { id: 'gpt-4o' },
              { id: 'gpt-4o-mini', shutdown_date: null },
              { id: 'o3-mini', shutdown_date: '2026-12-01' },
              { id: 'gpt-4-turbo', shutdown_date: undefined },
            ],
          };
        },
      },
      chat: { completions: { create: async () => (async function* () {})() } },
    }));

    const models = await adapter.listModels({
      provider: makeOpenAIRequest().provider,
      signal: new AbortController().signal,
    });
    expect(models.map((model) => model.id)).toEqual(['gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini']);
  });

  it('lists nothing as a key when the provider secret is missing', async () => {
    const adapter = new OpenAIAdapter(() => createMockOpenAIClient([]));
    await expect(
      adapter.listModels({
        provider: { ...makeOpenAIRequest().provider, secrets: {} },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('secret_not_configured');
  });
});

describe('OpenAIAdapter — provider-native compaction', () => {
  const compactingRequest = (overrides: Partial<NormalizedChatRequest> = {}) => {
    const base = makeOpenAIRequest();
    return makeOpenAIRequest({
      model: {
        ...base.model,
        capabilities: { ...base.model.capabilities, compaction: {} },
      },
      ...overrides,
    });
  };

  const capturingClient = (calls: Array<Record<string, unknown>>): OpenAIClientLike => ({
    models: { list: async () => ({ data: [] }) },
    chat: {
      completions: {
        create: async () => {
          throw new Error('the Chat Completions path must not be used for compaction');
        },
      },
    },
    responses: {
      create: async (params: unknown) => {
        calls.push(params as Record<string, unknown>);
        return (async function* () {
          yield { type: 'response.created', response: { id: 'resp-1' } };
          yield {
            type: 'response.output_item.done',
            item: { type: 'compaction', id: 'cmp-1', encrypted_content: 'opaque' },
          };
          yield { type: 'response.output_text.delta', delta: 'Hello' };
          yield {
            type: 'response.completed',
            response: {
              id: 'resp-1',
              usage: { input_tokens: 10, output_tokens: 2 },
            },
          };
        })();
      },
    },
  });

  it('requests compaction through the Responses API and emits the block', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIAdapter(() => capturingClient(calls));

    const events = await collect(adapter, compactingRequest());

    expect(calls[0]?.['context_management']).toEqual([
      { type: 'compaction', compact_threshold: 102_400 },
    ]);
    expect(calls[0]?.['truncation']).toBe('auto');
    expect(calls[0]?.['safety_identifier']).toBe('hash-1');
    expect(events.find((e) => e.type === 'compaction')).toEqual({
      type: 'compaction',
      provider: 'openai',
      payload: { type: 'compaction', id: 'cmp-1', encrypted_content: 'opaque' },
    });
  });

  it('replays a stored compaction item and keeps requesting compaction', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIAdapter(() => capturingClient(calls));

    await collect(
      adapter,
      compactingRequest({
        messages: [
          {
            role: 'assistant',
            parts: [
              {
                type: 'compaction',
                provider: 'openai',
                payload: { type: 'compaction', id: 'cmp-1', encrypted_content: 'opaque' },
              },
              { type: 'text', text: 'previous answer' },
            ],
          },
          { role: 'user', parts: [{ type: 'text', text: 'next question' }] },
        ],
      }),
    );

    // A new compaction item may stack on the replayed one as the context grows again.
    expect(calls[0]?.['context_management']).toEqual([
      { type: 'compaction', compact_threshold: 102_400 },
    ]);
    expect(calls[0]?.['input']).toEqual([
      { type: 'compaction', id: 'cmp-1', encrypted_content: 'opaque' },
      { role: 'assistant', content: 'previous answer' },
      { role: 'user', content: [{ type: 'input_text', text: 'next question' }] },
    ]);
  });

  it('routes to the Responses API when replaying a historical compaction item even without model compaction capability', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const adapter = new OpenAIAdapter(() => capturingClient(calls));

    await collect(
      adapter,
      makeOpenAIRequest({
        messages: [
          {
            role: 'assistant',
            parts: [
              {
                type: 'compaction',
                provider: 'openai',
                payload: { type: 'compaction', id: 'cmp-2', encrypted_content: 'opaque-2' },
              },
            ],
          },
          { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
        ],
      }),
    );

    expect(calls[0]?.['input']).toEqual([
      { type: 'compaction', id: 'cmp-2', encrypted_content: 'opaque-2' },
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ]);
  });
});
