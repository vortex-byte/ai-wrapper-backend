import { describe, expect, it } from 'vitest';
import {
  OpenAIAdapter,
  type OpenAIClientLike,
} from '@/providers/infrastructure/adapters/openai/adapter.ts';
import { makeChatRequest } from '@/providers/infrastructure/fake/fake-provider.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';

const API_KEY = 'sk-test-key-01234567890123456789';

/** `hello` — arbitrary payload; the adapter only cares that it round-trips base64. */
const IMAGE_BASE64 = 'aGVsbG8=';

function makeRequest(overrides: Partial<NormalizedChatRequest> = {}): NormalizedChatRequest {
  const base = makeChatRequest({
    provider: {
      providerId: 'p-openai',
      key: 'openai',
      adapter: 'openai',
      config: {},
      secrets: { apiKey: API_KEY },
    },
    model: {
      modelId: 'm-openai',
      providerId: 'p-openai',
      apiModelId: 'gpt-5.1',
      displayName: 'GPT-5.1',
      capabilities: {
        streaming: true,
        vision: true,
        documents: { pdf: true },
        imageGeneration: true,
        documentGeneration: false,
        systemPrompt: true,
        tools: true,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      },
      maxOutputTokens: 8_192,
      defaultMaxOutputTokens: 4_096,
      quotaWeight: 1,
      config: {},
    },
  });
  return { ...base, ...overrides, responseModalities: ['text', 'image'] };
}

function withModelConfig(
  req: NormalizedChatRequest,
  config: Readonly<Record<string, unknown>>,
): NormalizedChatRequest {
  return { ...req, model: { ...req.model, config } };
}

function withProviderConfig(
  req: NormalizedChatRequest,
  config: Readonly<Record<string, unknown>>,
): NormalizedChatRequest {
  return { ...req, provider: { ...req.provider, config } };
}

interface FakeClient {
  readonly client: OpenAIClientLike;
  readonly responsesCalls: Array<Record<string, unknown>>;
  readonly chatCalls: Array<Record<string, unknown>>;
}

function fakeClient(events: unknown[]): FakeClient {
  const responsesCalls: Array<Record<string, unknown>> = [];
  const chatCalls: Array<Record<string, unknown>> = [];
  return {
    responsesCalls,
    chatCalls,
    client: {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: async (params: unknown) => {
            chatCalls.push(params as Record<string, unknown>);
            return (async function* () {
              yield { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'ok' } }] };
            })();
          },
        },
      },
      responses: {
        create: async (params: unknown) => {
          responsesCalls.push(params as Record<string, unknown>);
          return (async function* () {
            for (const event of events) yield event;
          })();
        },
      },
    },
  };
}

async function collect(
  adapter: OpenAIAdapter,
  req: NormalizedChatRequest,
): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const event of adapter.execute(req, {
    signal: new AbortController().signal,
    deadline: Date.now() + 5_000,
  })) {
    out.push(event);
  }
  return out;
}

/** A Responses turn in which the hosted image tool produced one image. */
function imageTurn(result: string | null = IMAGE_BASE64): unknown[] {
  return [
    { type: 'response.created', response: { id: 'resp_img' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { id: 'ig_1', type: 'image_generation_call', status: 'in_progress' },
    },
    { type: 'response.image_generation_call.completed', item_id: 'ig_1' },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { id: 'ig_1', type: 'image_generation_call', status: 'completed', result },
    },
    {
      type: 'response.completed',
      response: {
        id: 'resp_img',
        status: 'completed',
        output: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
}

function artifacts(
  events: readonly GenerationEvent[],
): Array<Extract<GenerationEvent, { type: 'artifact_emitted' }>> {
  return events.filter(
    (event): event is Extract<GenerationEvent, { type: 'artifact_emitted' }> =>
      event.type === 'artifact_emitted',
  );
}

describe('OpenAIAdapter — hosted image generation', () => {
  it('routes a registry-marked model through the Responses API with the image tool', async () => {
    const fake = fakeClient(imageTurn());
    const adapter = new OpenAIAdapter(() => fake.client);

    const events = await collect(adapter, makeRequest());

    expect(fake.chatCalls).toHaveLength(0);
    expect(fake.responsesCalls).toHaveLength(1);
    const params = fake.responsesCalls[0]!;
    expect(params['tools']).toEqual([{ type: 'image_generation' }]);
    // The sandbox instruction must not leak into a container-less turn.
    expect(String(params['instructions'])).not.toContain('/mnt/data');
    expect(events[0]).toEqual({ type: 'started', providerRequestId: 'resp_img' });
  });

  it('stays on Chat Completions when the model does not declare image generation', async () => {
    const fake = fakeClient(imageTurn());
    const adapter = new OpenAIAdapter(() => fake.client);
    const req = makeRequest();
    const withoutCapability: NormalizedChatRequest = {
      ...req,
      model: { ...req.model, capabilities: { ...req.model.capabilities, imageGeneration: false } },
    };

    const events = await collect(adapter, withoutCapability);

    expect(fake.responsesCalls).toHaveLength(0);
    expect(fake.chatCalls).toHaveLength(1);
    expect(artifacts(events)).toHaveLength(0);
  });

  it('stays on Chat Completions when the client did not opt in for this turn', async () => {
    const fake = fakeClient(imageTurn());
    const adapter = new OpenAIAdapter(() => fake.client);

    await collect(adapter, { ...makeRequest(), responseModalities: ['text'] });

    expect(fake.responsesCalls).toHaveLength(0);
    expect(fake.chatCalls).toHaveLength(1);
  });

  it('honours `model.config.imageGeneration: false` and provider-level opt-out', async () => {
    const disabled = fakeClient(imageTurn());
    await collect(
      new OpenAIAdapter(() => disabled.client),
      withModelConfig(makeRequest(), { imageGeneration: false }),
    );
    expect(disabled.responsesCalls).toHaveLength(0);
    expect(disabled.chatCalls).toHaveLength(1);

    const optedOut = fakeClient(imageTurn());
    await collect(
      new OpenAIAdapter(() => optedOut.client),
      withProviderConfig(makeRequest(), { useChatCompletions: true }),
    );
    expect(optedOut.responsesCalls).toHaveLength(0);
    expect(optedOut.chatCalls).toHaveLength(1);
  });

  it('emits the generated image with its bytes, tool lifecycle, and a stable handle', async () => {
    const fake = fakeClient(imageTurn());
    const adapter = new OpenAIAdapter(() => fake.client);

    const events = await collect(adapter, makeRequest());

    const [artifact] = artifacts(events);
    expect(artifact).toBeDefined();
    expect(artifact!.providerFileId).toBe('image:ig_1');
    expect(artifact!.filename).toBe('image-1.png');
    expect(artifact!.mimeType).toBe('image/png');
    expect(artifact!.sizeBytes).toBe(5);
    expect(Buffer.from(artifact!.bytes!).toString('utf8')).toBe('hello');
    // The payload is never used as an identifier.
    expect(artifact!.providerFileId).not.toContain(IMAGE_BASE64);

    const toolEvents = events.filter(
      (event) => event.type === 'tool_started' || event.type === 'tool_completed',
    );
    expect(toolEvents).toEqual([
      { type: 'tool_started', toolCallId: 'ig_1', name: 'image_generation' },
      { type: 'tool_completed', toolCallId: 'ig_1', status: 'success' },
    ]);
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'stop' });
  });

  it('names the file after the configured output format', async () => {
    const fake = fakeClient(imageTurn());
    const adapter = new OpenAIAdapter(() => fake.client);
    const req = withModelConfig(makeRequest(), {
      imageGenerationOptions: { output_format: 'jpeg', size: '1024x1024' },
    });

    const [artifact] = artifacts(await collect(adapter, req));

    expect(artifact!.filename).toBe('image-1.jpg');
    expect(artifact!.mimeType).toBe('image/jpeg');
  });

  it('trusts magic bytes over the configured output format', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fake = fakeClient(imageTurn(Buffer.from(png).toString('base64')));
    const adapter = new OpenAIAdapter(() => fake.client);
    const req = withModelConfig(makeRequest(), {
      imageGenerationOptions: { output_format: 'jpeg' },
    });

    const [artifact] = artifacts(await collect(adapter, req));

    expect(artifact!.mimeType).toBe('image/png');
    expect(artifact!.filename).toBe('image-1.png');
  });

  it('recovers the image from response.completed when output_item.done carries none', async () => {
    const fake = fakeClient([
      { type: 'response.created', response: { id: 'resp_img' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'ig_1', type: 'image_generation_call', status: 'in_progress' },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_img',
          status: 'completed',
          output: [
            {
              id: 'ig_1',
              type: 'image_generation_call',
              status: 'completed',
              result: IMAGE_BASE64,
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    ]);

    const events = await collect(new OpenAIAdapter(() => fake.client), makeRequest());
    const [artifact] = artifacts(events);

    expect(artifact).toBeDefined();
    expect(artifact!.providerFileId).toBe('image:ig_1');
    // The sweep must not double-emit an image already delivered by output_item.done.
    const doneAlso = fakeClient(imageTurn(IMAGE_BASE64));
    const both = await collect(new OpenAIAdapter(() => doneAlso.client), makeRequest());
    expect(artifacts(both)).toHaveLength(1);
  });

  it('does not emit artifacts for failed or incomplete image calls', async () => {
    for (const status of ['failed', 'incomplete']) {
      const fake = fakeClient([
        { type: 'response.created', response: { id: 'resp_img' } },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { id: 'ig_1', type: 'image_generation_call', status, result: IMAGE_BASE64 },
        },
        {
          type: 'response.completed',
          response: {
            id: 'resp_img',
            status: status === 'failed' ? 'completed' : 'incomplete',
            output: [{ id: 'ig_1', type: 'image_generation_call', status, result: IMAGE_BASE64 }],
          },
        },
      ]);

      const events = await collect(new OpenAIAdapter(() => fake.client), makeRequest());
      expect(artifacts(events), status).toHaveLength(0);
      expect(events).toContainEqual({
        type: 'tool_completed',
        toolCallId: 'ig_1',
        status: 'error',
      });
    }
  });

  it('skips images above the artifact size cap', async () => {
    const oversized = Buffer.alloc(60 * 1024 * 1024).toString('base64');
    const fake = fakeClient(imageTurn(oversized));

    const events = await collect(new OpenAIAdapter(() => fake.client), makeRequest());

    expect(artifacts(events)).toHaveLength(0);
    // The tool still completes; only the oversized payload is dropped.
    expect(events).toContainEqual({
      type: 'tool_completed',
      toolCallId: 'ig_1',
      status: 'success',
    });
  });

  it('forwards only the allow-listed image options', async () => {
    const fake = fakeClient(imageTurn());
    const adapter = new OpenAIAdapter(() => fake.client);
    const req = withModelConfig(makeRequest(), {
      imageGenerationOptions: {
        size: '1024x1024',
        quality: 'high',
        background: 'opaque',
        notAnOption: 'ignored',
      },
    });

    await collect(adapter, req);

    expect(fake.responsesCalls[0]!['tools']).toEqual([
      {
        type: 'image_generation',
        size: '1024x1024',
        quality: 'high',
        background: 'opaque',
      },
    ]);
  });

  it('declares both the image tool and the sandbox when a container turn also allows images', async () => {
    const fake = fakeClient(imageTurn());
    const adapter = new OpenAIAdapter(() => fake.client);
    const req: NormalizedChatRequest = {
      ...makeRequest(),
      container: { codeExecution: true, skills: ['pdf'] },
    };

    await collect(adapter, req);

    const tools = fake.responsesCalls[0]!['tools'] as Array<{ type: string }>;
    expect(tools.map((tool) => tool.type)).toEqual(['image_generation', 'shell']);
  });

  it('skips the artifact when the image call failed or returned no payload', async () => {
    const failed = fakeClient([
      { type: 'response.created', response: { id: 'resp_img' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'ig_1', type: 'image_generation_call', status: 'failed', result: IMAGE_BASE64 },
      },
      { type: 'response.completed', response: { id: 'resp_img', status: 'completed', output: [] } },
    ]);

    const failedEvents = await collect(new OpenAIAdapter(() => failed.client), makeRequest());
    expect(artifacts(failedEvents)).toHaveLength(0);
    expect(failedEvents).toContainEqual({
      type: 'tool_completed',
      toolCallId: 'ig_1',
      status: 'error',
    });

    const empty = fakeClient(imageTurn(null));
    const emptyEvents = await collect(new OpenAIAdapter(() => empty.client), makeRequest());
    expect(artifacts(emptyEvents)).toHaveLength(0);
  });
});
