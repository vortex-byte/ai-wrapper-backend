import { describe, expect, it } from 'vitest';
import {
  OpenAIAdapter,
  type OpenAIClientLike,
} from '@/providers/infrastructure/adapters/openai/adapter.ts';
import {
  buildMessages,
  buildRequest,
} from '@/providers/infrastructure/adapters/openai/chat/request.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import { collect, makeOpenAIRequest } from './openai/fixtures.ts';

const COMPAT_BASE_URL = 'https://llm.internal.example/v1';

function compatRequest() {
  return makeOpenAIRequest({
    provider: {
      providerId: 'p-compat',
      key: 'compat',
      adapter: 'openai',
      baseUrl: COMPAT_BASE_URL,
      config: {},
      secrets: { apiKey: 'sk-compat' },
    },
  });
}

const CHUNKS = [
  { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'Hello' } }] },
  {
    id: 'chatcmpl-1',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 1 },
  },
];

describe('OpenAI chat payload by dialect', () => {
  it('uses the first-party fields for api.openai.com', () => {
    const req = makeOpenAIRequest({ temperature: 0.2 });
    const params = buildRequest(req, buildMessages(req)) as Record<string, unknown>;

    expect(params['max_completion_tokens']).toBe(req.maxOutputTokens);
    expect(params['max_tokens']).toBeUndefined();
    expect(params['safety_identifier']).toBeDefined();
    expect(params['stream_options']).toEqual({ include_usage: true });
    expect(params['temperature']).toBe(0.2);
  });

  it('translates the payload for a compatible endpoint', () => {
    const req = compatRequest();
    const params = buildRequest(req, buildMessages(req)) as Record<string, unknown>;

    expect(params['max_tokens']).toBe(req.maxOutputTokens);
    expect(params['max_completion_tokens']).toBeUndefined();
    expect(params['safety_identifier']).toBeUndefined();
    expect(params['stream_options']).toEqual({ include_usage: true });
  });

  it('drops every optional field in strict mode', () => {
    const req = compatRequest();
    const params = buildRequest(req, buildMessages(req), undefined, true) as Record<
      string,
      unknown
    >;

    expect(Object.keys(params).sort()).toEqual(['max_tokens', 'messages', 'model', 'stream']);
  });
});

describe('OpenAI chat retry for compatible endpoints', () => {
  it('retries once with a minimal payload after a 400', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: OpenAIClientLike = {
      models: {
        async list() {
          return { data: [] };
        },
      },
      chat: {
        completions: {
          async create(params: unknown) {
            calls.push(params as Record<string, unknown>);
            if (calls.length === 1) {
              throw { status: 400, type: 'invalid_request_error', message: 'unknown field' };
            }
            return (async function* () {
              for (const chunk of CHUNKS) yield chunk;
            })();
          },
        },
      },
    };

    const adapter = new OpenAIAdapter(() => client);
    const events = await collect(adapter, compatRequest());

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0] ?? {}).sort()).toContain('stream_options');
    expect(Object.keys(calls[1] ?? {}).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'stream',
    ]);
  });

  it('does not retry first-party requests', async () => {
    const calls: unknown[] = [];
    const client: OpenAIClientLike = {
      models: {
        async list() {
          return { data: [] };
        },
      },
      chat: {
        completions: {
          async create(params: unknown) {
            calls.push(params);
            throw { status: 400, type: 'invalid_request_error', message: 'bad request' };
          },
        },
      },
    };

    const adapter = new OpenAIAdapter(() => client);
    const events: GenerationEvent[] = await collect(adapter, makeOpenAIRequest());

    expect(calls).toHaveLength(1);
    expect(events.some((event) => event.type === 'error')).toBe(true);
  });
});
