import { describe, expect, it } from 'vitest';
import {
  assertCatalogImageModel,
  syncImageModelCatalog,
  type SyncImageModelDeps,
} from '@/providers/application/image-model-sync.ts';
import type { ModelRecord, ProviderRecord } from '@/providers/domain/registry.ts';
import type { ModelRegistry } from '@/providers/ports/model-registry.ts';
import type { CreateModelInput, RegistryRepository } from '@/providers/ports/registry-repository.ts';

function provider(key: string, id: string): ProviderRecord {
  return {
    id,
    key,
    displayName: key,
    adapter: key,
    baseUrl: null,
    secretRef: 'KEY',
    status: 'active',
    config: {},
    configVersion: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as ProviderRecord;
}

function harness(existing: Partial<ModelRecord>[] = []) {
  const created: CreateModelInput[] = [];
  const models: ModelRecord[] = existing as ModelRecord[];
  let invalidated = 0;

  const repository = {
    findModelByProviderAndApiId: (providerId: string, apiModelId: string) =>
      Promise.resolve(
        models.find(
          (model) => model.providerId === providerId && model.apiModelId === apiModelId,
        ) ?? null,
      ),
    createModel: (input: CreateModelInput) => {
      created.push(input);
      return Promise.resolve({ ...input } as unknown as ModelRecord);
    },
  } as unknown as RegistryRepository;

  const registry = {
    listAllProviders: () =>
      Promise.resolve([provider('gemini', 'p-gemini'), provider('openai', 'p-openai')]),
    invalidate: () => {
      invalidated += 1;
    },
  } as unknown as ModelRegistry;

  const deps: SyncImageModelDeps = {
    registry,
    repository,
    clock: { now: () => new Date(0) },
    idGen: { uuidv7: () => 'generated-id' },
  };

  return { deps, created, invalidated: () => invalidated };
}

describe('syncImageModelCatalog', () => {
  it('creates a row for a newly selected Gemini model', async () => {
    const { deps, created, invalidated } = harness();
    await syncImageModelCatalog(deps, {
      schemaVersion: 1,
      gemini: { modelKey: 'gemini-nano-banana-2.1' },
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      providerId: 'p-gemini',
      apiModelId: 'gemini-nano-banana-2.1',
      status: 'active',
      config: {
        kind: 'image',
        imageOutputOptions: { imageSizes: ['1K', '2K', '4K'] },
      },
    });
    expect(created[0]?.config).not.toHaveProperty('internal');
    expect(created[0]?.capabilities.imageGeneration).toEqual({ mode: 'tool' });
    expect(invalidated()).toBe(1);
  });

  it('creates rows for both providers in one save', async () => {
    const { deps, created } = harness();
    await syncImageModelCatalog(deps, {
      schemaVersion: 1,
      gemini: { modelKey: 'gemini-3-pro-image' },
      openai: { modelKey: 'gpt-image-2.5-sunburst' },
    });
    expect(created.map((row) => row.providerId)).toEqual(['p-gemini', 'p-openai']);
  });

  it('leaves an existing row untouched so admin edits survive', async () => {
    const { deps, created, invalidated } = harness([
      {
        id: 'existing',
        providerId: 'p-gemini',
        apiModelId: 'gemini-nano-banana-2.1',
      },
    ]);
    await syncImageModelCatalog(deps, {
      schemaVersion: 1,
      gemini: { modelKey: 'gemini-nano-banana-2.1' },
    });
    expect(created).toHaveLength(0);
    expect(invalidated()).toBe(1);
  });

  it('writes nothing when no model is configured', async () => {
    const { deps, created, invalidated } = harness();
    await syncImageModelCatalog(deps, { schemaVersion: 1 });
    expect(created).toHaveLength(0);
    expect(invalidated()).toBe(0);
  });

  it('refuses a model that is not in the catalog', async () => {
    const { deps, created } = harness();
    await expect(
      syncImageModelCatalog(deps, { schemaVersion: 1, gemini: { modelKey: 'gemini-dos' } }),
    ).rejects.toThrow('not in the gemini catalog');
    expect(created).toHaveLength(0);
  });

  it('refuses when the provider is not registered', async () => {
    const { deps } = harness();
    const withoutOpenAi: SyncImageModelDeps = {
      ...deps,
      registry: {
        ...deps.registry,
        listAllProviders: () => Promise.resolve([provider('gemini', 'p-gemini')]),
      } as unknown as ModelRegistry,
    };
    await expect(
      syncImageModelCatalog(withoutOpenAi, {
        schemaVersion: 1,
        openai: { modelKey: 'gpt-image-2.5-flare' },
      }),
    ).rejects.toThrow('not registered');
  });
});

describe('assertCatalogImageModel', () => {
  it('accepts a catalog id and rejects a foreign one', () => {
    expect(() => assertCatalogImageModel('gemini', 'gemini-3-pro-image')).not.toThrow();
    expect(() => assertCatalogImageModel('openai', 'gemini-3-pro-image')).toThrow();
  });
});
