import { describe, expect, it } from 'vitest';
import { AdapterProviderFileCleaner } from '@/providers/infrastructure/adapter-provider-file-cleaner.ts';
import { InMemoryProviderRegistry } from '@/providers/infrastructure/registry.ts';
import type { ProviderAdapter } from '@/providers/ports/provider-adapter.ts';
import type { FilesApiContext } from '@/providers/ports/provider-adapter.ts';
import type { ModelRegistry } from '@/providers/ports/model-registry.ts';
import type { ProviderRecord } from '@/providers/domain/registry.ts';
import type { ProviderRuntimeConfig } from '@/providers/domain/capabilities.ts';
import type { SecretResolver } from '@/providers/ports/secret-resolver.ts';

function providerRecord(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'p-1',
    key: 'openai',
    displayName: 'OpenAI',
    adapter: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    secretRef: 'OPENAI_API_KEY',
    status: 'active',
    config: {},
    configVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function registryWith(providers: readonly ProviderRecord[]): ModelRegistry {
  return {
    listVisibleModels: async () => [],
    listAllModels: async () => [],
    listAllProviders: async () => providers,
    getModel: async () => null,
    getProvider: async () => null,
    getRuntimeConfig: async () => null,
    invalidate: () => {},
  };
}

function fakeAdapter(
  onDelete: (ctx: { provider: ProviderRuntimeConfig }) => void,
): ProviderAdapter {
  return {
    adapterKey: 'openai',
    execute: () => {
      throw new Error('not used');
    },
    listModels: async () => [],
    healthCheck: async () => ({ ok: true, latencyMs: 0, detail: '' }),
    estimateInputTokens: () => ({ tokens: 0, source: 'estimated' }),
    async deleteProviderFile(_providerFileId: string, ctx: FilesApiContext) {
      onDelete(ctx);
    },
  } as unknown as ProviderAdapter;
}

describe('AdapterProviderFileCleaner', () => {
  it('passes the resolved secret to the adapter', async () => {
    let seenSecrets: Record<string, string> | undefined;
    const adapters = new InMemoryProviderRegistry();
    adapters.register(
      fakeAdapter((ctx) => {
        seenSecrets = ctx.provider.secrets;
      }),
    );
    const secrets: SecretResolver = {
      resolve: (ref) => (ref === 'OPENAI_API_KEY' ? 'sk-resolved' : null),
    };
    const cleaner = new AdapterProviderFileCleaner({
      adapters,
      providers: registryWith([providerRecord()]),
      secrets,
    });

    const deleted = await cleaner.deleteFile({
      providerKey: 'openai',
      providerFileId: 'file-1',
    });

    expect(deleted).toBe(true);
    expect(seenSecrets).toEqual({ apiKey: 'sk-resolved' });
  });

  it('reports an unresolved secret as an empty secret map', async () => {
    let seenSecrets: Record<string, string> | undefined;
    const adapters = new InMemoryProviderRegistry();
    adapters.register(
      fakeAdapter((ctx) => {
        seenSecrets = ctx.provider.secrets;
      }),
    );
    const cleaner = new AdapterProviderFileCleaner({
      adapters,
      providers: registryWith([providerRecord()]),
      secrets: { resolve: () => null },
    });

    await cleaner.deleteFile({ providerKey: 'openai', providerFileId: 'file-1' });

    expect(seenSecrets).toEqual({});
  });

  it('skips unknown providers and empty file ids', async () => {
    const cleaner = new AdapterProviderFileCleaner({
      adapters: new InMemoryProviderRegistry(),
      providers: registryWith([]),
      secrets: { resolve: () => null },
    });

    await expect(
      cleaner.deleteFile({ providerKey: 'missing', providerFileId: 'file-1' }),
    ).resolves.toBe(false);
    await expect(cleaner.deleteFile({ providerKey: null, providerFileId: 'file-1' })).resolves.toBe(
      false,
    );
  });
});
