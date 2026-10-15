import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import {
  OpenAIAdapter,
  type OpenAIClientLike,
} from '@/providers/infrastructure/adapters/openai/adapter.ts';
import {
  AnthropicAdapter,
  type AnthropicClientLike,
} from '@/providers/infrastructure/adapters/anthropic/adapter.ts';
import { makeChatRequest } from '@/providers/infrastructure/fake/fake-provider.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';

async function collect(
  adapter: {
    execute: (
      req: ReturnType<typeof makeChatRequest>,
      ctx: { signal: AbortSignal; deadline: number },
    ) => AsyncIterable<GenerationEvent>;
  },
  request: ReturnType<typeof makeChatRequest>,
): Promise<GenerationEvent[]> {
  const events: GenerationEvent[] = [];
  for await (const event of adapter.execute(request, {
    signal: new AbortController().signal,
    deadline: Date.now() + 5_000,
  }))
    events.push(event);
  return events;
}

function decodeOpenAI(fixture: string): unknown[] {
  return fixture
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((line) => line !== '[DONE]')
    .map((line) => JSON.parse(line) as unknown);
}

function decodeAnthropic(fixture: string): unknown[] {
  return fixture
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)) as unknown);
}

function isErrorFrame(chunk: unknown): chunk is { error: Record<string, unknown> } {
  if (typeof chunk !== 'object' || chunk === null || !('error' in chunk)) return false;
  // why: JSON.parse returns unknown; the guard's job is proving the frame shape once
  const body = (chunk as { error: unknown }).error;
  return typeof body === 'object' && body !== null;
}

describe('provider adapter contract (recorded SSE fixture replay)', () => {
  it.each([
    ['openai', 'openai/text.sse.txt'],
    ['anthropic', 'anthropic/text.sse.txt'],
  ])('%s normalizes fixture text, usage and a single terminal event', async (provider, file) => {
    const fixture = await readFile(new URL(`../../fixtures/${file}`, import.meta.url), 'utf8');
    const chunks = provider === 'openai' ? decodeOpenAI(fixture) : decodeAnthropic(fixture);
    const request = makeChatRequest({
      provider: {
        ...makeChatRequest().provider,
        key: provider,
        adapter: provider,
        secrets: { apiKey: 'contract-test-secret' },
      },
    });
    const openaiClient: OpenAIClientLike = {
      models: {
        async list() {
          return { data: [] };
        },
      },
      chat: {
        completions: {
          async create() {
            return (async function* () {
              yield* chunks;
            })();
          },
        },
      },
    };
    const anthropicClient: AnthropicClientLike = {
      models: {
        async list() {
          return { data: [] };
        },
      },
      messages: {
        async create() {
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    };
    const adapter =
      provider === 'openai'
        ? new OpenAIAdapter(() => openaiClient)
        : new AnthropicAdapter(() => anthropicClient);
    const events = await collect(adapter, request);
    expect(
      events
        .filter((event) => event.type === 'text_delta')
        .map((event) => (event.type === 'text_delta' ? event.text : '')),
    ).toEqual(['fixture response']);
    expect(events.filter((event) => event.type === 'usage')).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'finished' || event.type === 'error'),
    ).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('contract-test-secret');
  });

  it('contains no real credentials in recorded provider fixtures', async () => {
    for (const path of [
      '../../fixtures/openai/text.sse.txt',
      '../../fixtures/openai/error.sse.txt',
      '../../fixtures/anthropic/text.sse.txt',
      '../../fixtures/anthropic/error.sse.txt',
    ]) {
      const fixture = await readFile(new URL(path, import.meta.url), 'utf8');
      expect(fixture).not.toMatch(/Bearer\s+|sk-[A-Za-z0-9]{8,}|api[_-]?key/i);
    }
  });

  it.each([
    ['openai', 'openai/error.sse.txt'],
    ['anthropic', 'anthropic/error.sse.txt'],
  ])('%s surfaces a mid-stream error frame as one terminal error (no finished)', async (provider, file) => {
    const fixture = await readFile(new URL(`../../fixtures/${file}`, import.meta.url), 'utf8');
    const chunks = provider === 'openai' ? decodeOpenAI(fixture) : decodeAnthropic(fixture);
    const request = makeChatRequest({
      provider: {
        ...makeChatRequest().provider,
        key: provider,
        adapter: provider,
        secrets: { apiKey: 'contract-test-secret' },
      },
    });
    const openaiClient: OpenAIClientLike = {
      models: {
        async list() {
          return { data: [] };
        },
      },
      chat: {
        completions: {
          async create() {
            return (async function* () {
              for (const chunk of chunks) {
                // why: the real SDK never yields error frames — core/streaming.js throws APIError on them
                if (isErrorFrame(chunk)) {
                  throw new OpenAI.APIError(undefined, chunk.error, undefined, new Headers());
                }
                yield chunk;
              }
            })();
          },
        },
      },
    };
    const anthropicClient: AnthropicClientLike = {
      models: {
        async list() {
          return { data: [] };
        },
      },
      messages: {
        async create() {
          return (async function* () {
            yield* chunks;
          })();
        },
      },
    };
    const adapter =
      provider === 'openai'
        ? new OpenAIAdapter(() => openaiClient)
        : new AnthropicAdapter(() => anthropicClient);
    const events = await collect(adapter, request);
    expect(
      events
        .filter((event) => event.type === 'text_delta')
        .map((event) => (event.type === 'text_delta' ? event.text : '')),
    ).toEqual(['partial response']);
    expect(
      events.filter((event) => event.type === 'finished' || event.type === 'error'),
    ).toHaveLength(1);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('error');
    if (provider === 'anthropic' && terminal?.type === 'error') {
      expect(terminal.error.category).toBe('service_busy');
    }
    expect(JSON.stringify(events)).not.toContain('contract-test-secret');
  });

  it('aborts OpenAI fixture iteration promptly and emits one terminal error', async () => {
    const controller = new AbortController();
    const adapter = new OpenAIAdapter(() => ({
      models: {
        async list() {
          return { data: [] };
        },
      },
      chat: {
        completions: {
          async create() {
            return (async function* () {
              yield { id: 'abort', choices: [{ index: 0, delta: { content: 'x' } }] };
              throw new DOMException('aborted', 'AbortError');
            })();
          },
        },
      },
    }));
    const started = Date.now();
    const events = await collect(
      adapter,
      makeChatRequest({ provider: { ...makeChatRequest().provider, secrets: { apiKey: 'test' } } }),
    );
    controller.abort();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(
      events.filter((event) => event.type === 'finished' || event.type === 'error'),
    ).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('error');
  });
});
