import { describe, expect, it } from 'vitest';
import { LocalAdapter } from '@/providers/infrastructure/adapters/local/adapter.ts';
import { LOCAL_ADAPTER_KEY } from '@/providers/domain/local-model.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type {
  ExecuteContext,
  HealthCheckContext,
} from '@/providers/ports/provider-adapter.ts';

const request = {
  model: 'local-model',
  messages: [{ role: 'user', content: 'hello' }],
  maxOutputTokens: 128,
  temperature: 0.7,
  stream: true,
} as unknown as NormalizedChatRequest;

const executeContext = {
  signal: new AbortController().signal,
  deadline: 0,
} as ExecuteContext;

const healthContext = {
  provider: { key: 'local', adapter: 'local' },
  signal: new AbortController().signal,
} as unknown as HealthCheckContext;

describe('LocalAdapter', () => {
  it('registers under the local adapter key', () => {
    expect(new LocalAdapter().adapterKey).toBe(LOCAL_ADAPTER_KEY);
  });

  it('never reaches the network: execution yields an unsupported error', async () => {
    const events: string[] = [];
    for await (const event of new LocalAdapter().execute(request, executeContext)) {
      events.push(event.type);
      if (event.type === 'error') {
        expect(event.error.category).toBe('unsupported_for_model');
        expect(event.error.retryable).toBe(false);
      }
    }
    expect(events).toEqual(['error']);
  });

  it('reports itself healthy without contacting an upstream', async () => {
    const result = await new LocalAdapter().healthCheck(healthContext);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBe(0);
  });

  it('lists no remote models', async () => {
    expect(await new LocalAdapter().listModels(healthContext)).toEqual([]);
  });

  it('translates any error into the unsupported error', () => {
    const error = new LocalAdapter().translateError(new Error('boom'));
    expect(error.category).toBe('unsupported_for_model');
    expect(error.retryable).toBe(false);
  });
});
