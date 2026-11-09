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
  const bodies: Array<FormData | undefined> = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    bodies.push(init.body instanceof FormData ? init.body : undefined);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls, bodies };
}

const upload = {
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  bytes: new TextEncoder().encode('pdf'),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Anthropic file expiration', () => {
  it('sends expires_in_seconds derived from the configured retention', async () => {
    const { bodies } = stubFetch({ id: 'file_123' });
    const adapter = new AnthropicAdapter();

    await adapter.uploadInputFile(upload, {
      provider: providerRuntime(),
      signal: AbortSignal.timeout(1000),
      fileRetentionDays: 30,
    });

    expect(bodies[0]?.get('expires_in_seconds')).toBe(String(30 * 86_400));
  });

  it('omits the expiration field when no retention is configured', async () => {
    const { bodies } = stubFetch({ id: 'file_123' });
    const adapter = new AnthropicAdapter();

    await adapter.uploadInputFile(upload, {
      provider: providerRuntime(),
      signal: AbortSignal.timeout(1000),
    });

    expect(bodies[0]?.has('expires_in_seconds')).toBe(false);
  });

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

describe('OpenAI file expiration', () => {
  it('sends an expires_after policy anchored at creation', async () => {
    const { bodies } = stubFetch({ id: 'file-123' });
    const adapter = new OpenAIAdapter();

    await adapter.uploadInputFile(upload, {
      provider: providerRuntime({ key: 'openai-main', adapter: 'openai' }),
      signal: AbortSignal.timeout(1000),
      fileRetentionDays: 7,
    });

    expect(bodies[0]?.get('expires_after[anchor]')).toBe('created_at');
    expect(bodies[0]?.get('expires_after[seconds]')).toBe(String(7 * 86_400));
  });

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
