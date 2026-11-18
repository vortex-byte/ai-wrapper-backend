import { afterEach, describe, expect, it, vi } from 'vitest';

import { AnthropicAdapter } from '@/providers/infrastructure/adapters/anthropic/adapter.ts';
import { OpenAIAdapter } from '@/providers/infrastructure/adapters/openai/adapter.ts';
import type { ProviderRuntimeConfig } from '@/providers/domain/capabilities.ts';

function providerRuntime(overrides: Partial<ProviderRuntimeConfig> = {}): ProviderRuntimeConfig {
  return {
    providerId: 'p-1',
    key: 'anthropic-main',
    adapter: 'anthropic',
    config: {},
    secrets: { apiKey: 'sk-test' },
    ...overrides,
  };
}

interface CapturedCall {
  readonly url: string;
  readonly method: string;
}

function stubFetch(response: unknown) {
  const calls: CapturedCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Anthropic file cleanup', () => {
  it('deletes a provider file with DELETE', async () => {
    const { calls } = stubFetch({});
    const adapter = new AnthropicAdapter();

    await adapter.deleteProviderFile('file_123', {
      provider: providerRuntime(),
      signal: AbortSignal.timeout(1000),
    });

    expect(calls).toEqual([
      { url: 'https://api.anthropic.com/v1/files/file_123', method: 'DELETE' },
    ]);
  });
});

describe('OpenAI file cleanup', () => {
  it('deletes a plain file', async () => {
    const { calls } = stubFetch({});
    const adapter = new OpenAIAdapter();

    await adapter.deleteProviderFile('file-123', {
      provider: providerRuntime({ key: 'openai-main', adapter: 'openai' }),
      signal: AbortSignal.timeout(1000),
    });

    expect(calls).toEqual([{ url: 'https://api.openai.com/v1/files/file-123', method: 'DELETE' }]);
  });

  it('deletes container-hosted files through the container endpoint', async () => {
    const { calls } = stubFetch({});
    const adapter = new OpenAIAdapter();

    await adapter.deleteProviderFile('container:cntr_1:file-9', {
      provider: providerRuntime({ key: 'openai-main', adapter: 'openai' }),
      signal: AbortSignal.timeout(1000),
    });

    expect(calls[0]?.url).toBe('https://api.openai.com/v1/containers/cntr_1/files/file-9');
    expect(calls[0]?.method).toBe('DELETE');
  });
});
