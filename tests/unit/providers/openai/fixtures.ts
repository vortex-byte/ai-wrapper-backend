import { makeChatRequest } from '@/providers/infrastructure/fake/fake-provider.ts';
import type {
  NormalizedChatRequest,
  ModelRuntimeConfig,
} from '@/providers/domain/capabilities.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import type { OpenAIClientLike } from '@/providers/infrastructure/adapters/openai/adapter.ts';

export const API_KEY = 'sk-test-key-01234567890123456789';

export function openAIModel(overrides: Partial<ModelRuntimeConfig> = {}): ModelRuntimeConfig {
  return {
    modelId: 'm-openai',
    providerId: 'p-openai',
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
      contextWindow: 128000,
      maxOutputTokens: 4096,
    },
    maxOutputTokens: 4096,
    defaultMaxOutputTokens: 2048,
    quotaWeight: 1,
    config: {},
    ...overrides,
  };
}

export function makeOpenAIRequest(
  overrides: Partial<NormalizedChatRequest> = {},
): NormalizedChatRequest {
  return makeChatRequest({
    model: openAIModel(),
    provider: {
      providerId: 'p-openai',
      key: 'openai',
      adapter: 'openai',
      config: {},
      secrets: { apiKey: API_KEY },
    },
    ...overrides,
  });
}

export function mockChatClient(chunks: unknown[]): OpenAIClientLike {
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

export interface CollectableAdapter {
  execute(
    req: NormalizedChatRequest,
    ctx: { signal: AbortSignal; deadline: number },
  ): AsyncIterable<GenerationEvent>;
}

export async function collect(
  adapter: CollectableAdapter,
  req: NormalizedChatRequest,
): Promise<GenerationEvent[]> {
  const events: GenerationEvent[] = [];
  for await (const event of adapter.execute(req, {
    signal: new AbortController().signal,
    deadline: Date.now() + 5000,
  })) {
    events.push(event);
  }
  return events;
}

export function resolvedFile(bytes: number[], mimeType: string, name: string) {
  return {
    fileId: `f-${name}`,
    mimeType,
    name,
    sizeBytes: bytes.length,
    read: async () => new Uint8Array(bytes),
    stream: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      }),
  };
}
