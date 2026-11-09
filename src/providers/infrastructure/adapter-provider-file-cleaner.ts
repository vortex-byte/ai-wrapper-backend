import { getLogger } from '@/observability/logger.ts';
import type { ProviderRuntimeConfig } from '../domain/capabilities.ts';
import type { ModelRegistry } from '../ports/model-registry.ts';
import type { ProviderFileCleaner, ProviderFileRef } from '@/provider-file-cleaner.ts';
import type { ProviderRegistry } from '../ports/provider-registry.ts';

/** Deletes provider-hosted files through the adapter that owns them. */

export interface AdapterProviderFileCleanerDeps {
  readonly adapters: ProviderRegistry;
  readonly providers: ModelRegistry;
  readonly timeoutMs?: number;
}

export class AdapterProviderFileCleaner implements ProviderFileCleaner {
  constructor(private readonly deps: AdapterProviderFileCleanerDeps) {}

  async deleteFile(file: ProviderFileRef): Promise<boolean> {
    if (file.providerKey === null || file.providerFileId === '') return false;

    const providerRecord = await this.findProvider(file.providerKey);
    if (providerRecord === null) return false;

    const adapter = this.deps.adapters.get(providerRecord.adapter);
    if (adapter === undefined || adapter === null || adapter.deleteProviderFile === undefined) {
      return false;
    }

    const runtime: ProviderRuntimeConfig = {
      providerId: providerRecord.id,
      key: providerRecord.key,
      adapter: providerRecord.adapter,
      ...(providerRecord.baseUrl !== null ? { baseUrl: providerRecord.baseUrl } : {}),
      config: providerRecord.config,
      secrets: {},
    };

    try {
      await adapter.deleteProviderFile(file.providerFileId, {
        provider: runtime,
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 30_000),
      });
      return true;
    } catch (err) {
      // 404 is already treated as success by the adapters; anything else is logged, never thrown.
      const category = providerErrorCategory(err);
      getLogger().warn(
        {
          component: 'provider-file-cleaner',
          category,
          providerKey: file.providerKey,
        },
        'provider file delete failed',
      );
      return false;
    }
  }

  private async findProvider(key: string) {
    const providers = await this.deps.providers.listAllProviders();
    return providers.find((provider) => provider.key === key) ?? null;
  }
}

function providerErrorCategory(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'category' in err) {
    const category = (err as { category?: unknown }).category;
    if (typeof category === 'string') return category;
  }
  return 'internal_error';
}
