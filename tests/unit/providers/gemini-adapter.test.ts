import { describe, expect, it } from 'vitest';
import {
  GeminiAdapter,
  type GeminiClientFactory,
  type GeminiHttpRequest,
  type GeminiResponseLike,
} from '@/providers/infrastructure/adapters/gemini/adapter.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import { gemini3OrLater } from '@/providers/infrastructure/adapters/gemini/config.ts';

function sseStream(chunks: readonly unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const payload = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
}

function mockResponse(options: {
  status?: number;
  ok?: boolean;
  body?: ReadableStream<Uint8Array> | null;
  json?: unknown;
  headers?: Record<string, string>;
}): GeminiResponseLike {
  return {
    status: options.status ?? 200,
    ok: options.ok ?? (options.status ?? 200) < 400,
    headers: {
      get: (name: string) => options.headers?.[name.toLowerCase()] ?? null,
    },
    text: async () => JSON.stringify(options.json ?? {}),
    json: async () => options.json ?? {},
    body: options.body !== undefined ? options.body : null,
  };
}

function request(overrides: Partial<NormalizedChatRequest> = {}): NormalizedChatRequest {
  return {
    requestId: 'req-gemini-1',
    generationId: 'gen-gemini-1',
    model: {
      modelId: 'm-gemini',
      providerId: 'p-gemini',
      apiModelId: 'gemini-1.5-pro',
      displayName: 'Gemini 1.5 Pro',
      capabilities: {
        streaming: true,
        vision: true,
        documents: { pdf: true },
        imageGeneration: null,
        documentGeneration: false,
        systemPrompt: true,
        tools: true,
        contextWindow: 1000000,
        maxOutputTokens: 8192,
      },
      maxOutputTokens: 8192,
      defaultMaxOutputTokens: 2048,
      quotaWeight: 1,
      config: {},
    },
    provider: {
      providerId: 'p-gemini',
      key: 'gemini',
      adapter: 'gemini',
      config: {},
      secrets: { apiKey: 'test-google-key' },
    },
    system: 'You are helpful.',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Hello Gemini' }] }],
    maxOutputTokens: 2048,
    responseModalities: ['text'],
    metadata: { userIdHash: 'hash-gemini' },
    ...overrides,
  };
}

async function collect(iterable: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe('GeminiAdapter', () => {
  it('shapes a valid provider request', () => {
    const adapter = new GeminiAdapter();
    const req = request();
    const payload = adapter.toProviderRequest(req) as Record<string, unknown>;

    expect(payload['systemInstruction']).toEqual({
      parts: [{ text: 'You are helpful.' }],
    });
    expect(payload['contents']).toBeDefined();
    expect(payload['generationConfig']).toMatchObject({
      maxOutputTokens: 2048,
    });
  });

  it('pins image modalities and caller geometry on an image turn', () => {
    const adapter = new GeminiAdapter();
    const payload = adapter.toProviderRequest(
      request({
        responseModalities: ['text', 'image'],
        imageOutput: { aspectRatio: '16:9', imageSize: '2K' },
        reasoningEffort: 'high',
      }),
    ) as { generationConfig: Record<string, unknown>; tools?: unknown };

    expect(payload.generationConfig['responseModalities']).toEqual(['TEXT', 'IMAGE']);
    expect(payload.generationConfig['imageConfig']).toEqual({
      aspectRatio: '16:9',
      imageSize: '2K',
    });
    expect(payload.generationConfig['thinkingConfig']).toBeUndefined();
  });

  it('lets the caller override the model-configured geometry', () => {
    const adapter = new GeminiAdapter();
    const base = request({
      responseModalities: ['text', 'image'],
      imageOutput: { aspectRatio: '9:16' },
    });
    const configured: NormalizedChatRequest = {
      ...base,
      model: { ...base.model, config: { imageConfig: { aspectRatio: '1:1', imageSize: '4K' } } },
    };

    const payload = adapter.toProviderRequest(configured) as {
      generationConfig: Record<string, unknown>;
    };
    expect(payload.generationConfig['imageConfig']).toEqual({ aspectRatio: '9:16', imageSize: '4K' });
  });

  it('omits imageConfig on a text turn', () => {
    const adapter = new GeminiAdapter();
    const payload = adapter.toProviderRequest(request()) as {
      generationConfig: Record<string, unknown>;
    };
    expect(payload.generationConfig['responseModalities']).toBeUndefined();
    expect(payload.generationConfig['imageConfig']).toBeUndefined();
  });

  it('classifies Gemini 3 and later model ids', () => {
    expect(gemini3OrLater('gemini-3.1-pro-preview')).toBe(true);
    expect(gemini3OrLater('gemini-4-argon')).toBe(true);
    expect(gemini3OrLater('gemini-2.5-flash')).toBe(false);
    expect(gemini3OrLater('models/gemini-3.6-flash')).toBe(true);
    expect(gemini3OrLater('gemini-3-flash')).toBe(true);
  });

  it('drops sampling parameters and keeps the thinking budget on Gemini 3 models', () => {
    const adapter = new GeminiAdapter();
    const base = request({
      temperature: 0.6,
      topP: 0.9,
      reasoningEffort: 'high',
      maxOutputTokens: 16384,
    });
    const payload = adapter.toProviderRequest({
      ...base,
      model: { ...base.model, apiModelId: 'gemini-3.1-pro-preview' },
    }) as { generationConfig: Record<string, unknown> };

    expect(payload.generationConfig['temperature']).toBeUndefined();
    expect(payload.generationConfig['topP']).toBeUndefined();
    expect(payload.generationConfig['thinkingConfig']).toEqual({ thinkingBudget: 8192 });
  });

  it('keeps sampling parameters on Gemini 2.x models', () => {
    const adapter = new GeminiAdapter();
    const base = request({ temperature: 0.6, topP: 0.9 });
    const payload = adapter.toProviderRequest({
      ...base,
      model: { ...base.model, apiModelId: 'gemini-2.5-flash' },
    }) as { generationConfig: Record<string, unknown> };

    expect(payload.generationConfig['temperature']).toBe(0.6);
    expect(payload.generationConfig['topP']).toBe(0.9);
  });

  it('estimates input tokens locally', async () => {
    const adapter = new GeminiAdapter();
    const result = await adapter.estimateInputTokens(request());
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.confidence).toBe('approx');
  });

  it('streams text chunks to part_started, text_delta, usage and finished', async () => {
    const chunks = [
      {
        candidates: [
          {
            content: { parts: [{ text: 'Hello ' }] },
          },
        ],
      },
      {
        candidates: [
          {
            content: { parts: [{ text: 'world!' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          totalTokenCount: 15,
        },
      },
    ];

    const factory: GeminiClientFactory = () => async () =>
      mockResponse({
        status: 200,
        ok: true,
        body: sseStream(chunks),
      });

    const adapter = new GeminiAdapter(factory);
    const events = await collect(
      adapter.execute(request(), { signal: new AbortController().signal, deadline: 0 }),
    );

    expect(events[0]?.type).toBe('started');
    const partStarted = events.find((e) => e.type === 'part_started');
    expect(partStarted).toMatchObject({ type: 'part_started', partType: 'text', index: 0 });

    const textDeltas = events.filter((e) => e.type === 'text_delta');
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]).toMatchObject({ text: 'Hello ' });
    expect(textDeltas[1]).toMatchObject({ text: 'world!' });

    const partDone = events.find((e) => e.type === 'part_done');
    expect(partDone).toMatchObject({ type: 'part_done', index: 0 });

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, source: 'provider' },
      final: true,
    });

    const finished = events.find((e) => e.type === 'finished');
    expect(finished).toMatchObject({ type: 'finished', reason: 'stop' });
  });

  it('translates function calls and executable code into tool events', async () => {
    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'calculator',
                    args: { expression: '2+2' },
                  },
                },
                {
                  executableCode: {
                    language: 'PYTHON',
                    code: 'print(4)',
                  },
                },
                {
                  codeExecutionResult: {
                    outcome: 'OUTCOME_OK',
                    output: '4\n',
                  },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ];

    const factory: GeminiClientFactory = () => async () =>
      mockResponse({ status: 200, ok: true, body: sseStream(chunks) });

    const adapter = new GeminiAdapter(factory);
    const events = await collect(
      adapter.execute(request(), { signal: new AbortController().signal, deadline: 0 }),
    );

    const toolStarts = events.filter((e) => e.type === 'tool_started');
    expect(toolStarts.length).toBeGreaterThanOrEqual(2);
    expect(toolStarts[0]).toMatchObject({ name: 'calculator', input: { expression: '2+2' } });
    expect(toolStarts[1]).toMatchObject({ name: 'code_execution', input: { language: 'PYTHON', code: 'print(4)' } });

    const toolDelta = events.find((e) => e.type === 'tool_delta');
    expect(toolDelta).toMatchObject({ delta: '4\n' });

    const toolCompletes = events.filter((e) => e.type === 'tool_completed');
    expect(toolCompletes.length).toBeGreaterThanOrEqual(2);
  });

  it('surfaces inlineData parts as artifact_emitted', async () => {
    const base64Data = Buffer.from('fake-png-bytes').toString('base64');
    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'image/png',
                    data: base64Data,
                  },
                },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ];

    const factory: GeminiClientFactory = () => async () =>
      mockResponse({ status: 200, ok: true, body: sseStream(chunks) });

    const adapter = new GeminiAdapter(factory);
    const events = await collect(
      adapter.execute(request(), { signal: new AbortController().signal, deadline: 0 }),
    );

    const artifact = events.find((e) => e.type === 'artifact_emitted');
    expect(artifact).toBeDefined();
    expect(artifact).toMatchObject({
      type: 'artifact_emitted',
      mimeType: 'image/png',
    });
    if (artifact && artifact.type === 'artifact_emitted') {
      // The bytes ride on the event; the handle stays a small label so the payload is never persisted into `attachments.metadata.providerFileId`.
      expect(artifact.providerFileId).toBe('gemini-inline:0');
      expect(artifact.providerFileId).not.toContain(base64Data);
      expect(artifact.sizeBytes).toBe(Buffer.from(base64Data, 'base64').byteLength);
      expect(Buffer.from(artifact.bytes ?? new Uint8Array()).toString('base64')).toBe(base64Data);
    }
  });

  it('translates HTTP 429 to provider_rate_limited and HTTP 500 to provider_unavailable', async () => {
    const adapter = new GeminiAdapter();
    const rateLimitError = adapter.translateError({
      status: 429,
      statusText: 'Too Many Requests',
      message: 'Rate limit exceeded',
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' },
    });
    expect(rateLimitError.category).toBe('provider_rate_limited');
    expect(rateLimitError.retryable).toBe(true);

    const serverError = adapter.translateError({
      status: 503,
      statusText: 'Service Unavailable',
      message: 'Service is down',
    });
    expect(serverError.category).toBe('provider_unavailable');
    expect(serverError.retryable).toBe(true);

    const authError = adapter.translateError({
      status: 403,
      statusText: 'Forbidden',
      message: 'Invalid API key',
    });
    expect(authError.category).toBe('provider_unavailable');
    expect(authError.retryable).toBe(false);
  });

  it('performs health check reporting latency and ok', async () => {
    const factory: GeminiClientFactory = () => async (req: GeminiHttpRequest) => {
      expect(req.url).toContain('/v1beta/models');
      return mockResponse({ status: 200, ok: true });
    };

    const adapter = new GeminiAdapter(factory);
    const result = await adapter.healthCheck({
      provider: request().provider,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports health check failure when apiKey is missing', async () => {
    const adapter = new GeminiAdapter();
    const result = await adapter.healthCheck({
      provider: { ...request().provider, secrets: {} },
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe('secret_not_configured');
  });

  it('fetches artifact stream from inline data URL without network', async () => {
    const rawBytes = new Uint8Array([10, 20, 30, 40]);
    const b64 = Buffer.from(rawBytes).toString('base64');
    const dataUrl = `data:image/png;base64,${b64}`;

    const adapter = new GeminiAdapter();
    const artifact = await adapter.fetchArtifactStream(dataUrl, {
      provider: request().provider,
      signal: new AbortController().signal,
    });

    expect(artifact.mimeType).toBe('image/png');
    expect(artifact.sizeBytes).toBe(4);

    const reader = artifact.stream.getReader();
    const readResult = await reader.read();
    expect(new Uint8Array(readResult.value!)).toEqual(rawBytes);
  });
});
