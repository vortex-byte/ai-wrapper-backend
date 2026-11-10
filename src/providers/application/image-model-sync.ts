import type { Clock, IdGenerator } from '@/clock/index.ts';
import type { ModelRegistry } from '../ports/model-registry.ts';
import type { RegistryRepository } from '../ports/registry-repository.ts';
import type { ProviderRecord } from '../domain/registry.ts';
import {
  findCatalogEntry,
  imageModelCapabilities,
  type ImageModelCatalogEntry,
} from '../domain/image-model-catalog.ts';
import type { ImageGenerationConfig } from '@/settings/domain/settings.ts';

export interface SyncImageModelDeps {
  readonly registry: ModelRegistry;
  readonly repository: RegistryRepository;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
}

const INTERNAL_SORT_ORDER = 900;

function catalogError(providerKey: string, apiModelId: string): Error {
  return new Error(
    `Image model "${apiModelId}" is not in the ${providerKey} catalog; add it to IMAGE_MODEL_CATALOG.`,
  );
}

function sortOrderBase(): number {
  return INTERNAL_SORT_ORDER;
}

async function materialize(
  deps: SyncImageModelDeps,
  provider: ProviderRecord,
  entry: ImageModelCatalogEntry,
): Promise<string> {
  const existing = await deps.repository.findModelByProviderAndApiId(
    provider.id,
    entry.apiModelId,
  );
  if (existing !== null) return existing.id;

  const created = await deps.repository.createModel({
    id: deps.idGen.uuidv7(),
    providerId: provider.id,
    apiModelId: entry.apiModelId,
    displayName: entry.displayName,
    description: entry.description,
    status: 'active',
    capabilities: {
      ...imageModelCapabilities(),
      contextWindow: entry.contextWindow,
      maxOutputTokens: entry.maxOutputTokens,
    },
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    defaultMaxOutputTokens: entry.defaultMaxOutputTokens,
    quotaWeight: entry.quotaWeight,
    config: {
      kind: 'image',
      imageOutputOptions: {
        aspectRatios: [...entry.aspectRatios],
        imageSizes: [...entry.imageSizes],
      },
    },
    sortOrder: sortOrderBase(),
  });
  return created.id;
}

/** Ensures each settings image model exists as an `ai_models` row; idempotent — existing rows untouched so admin edits survive later saves. */
export async function syncImageModelCatalog(
  deps: SyncImageModelDeps,
  config: ImageGenerationConfig,
): Promise<void> {
  const providers = await deps.registry.listAllProviders();
  let changed = false;

  for (const providerKey of ['gemini', 'openai'] as const) {
    const modelKey =
      providerKey === 'gemini' ? config.gemini?.modelKey : config.openai?.modelKey;
    if (modelKey === undefined || modelKey.length === 0) continue;

    const entry = findCatalogEntry(providerKey, modelKey);
    if (entry === null) throw catalogError(providerKey, modelKey);

    const provider = providers.find((candidate) => candidate.key === providerKey);
    if (provider === undefined) {
      throw new Error(`Provider "${providerKey}" is not registered.`);
    }
    await materialize(deps, provider, entry);
    changed = true;
  }

  if (changed) deps.registry.invalidate();
}

export function assertCatalogImageModel(providerKey: string, modelKey: string): void {
  if (findCatalogEntry(providerKey, modelKey) === null) {
    throw catalogError(providerKey, modelKey);
  }
}
