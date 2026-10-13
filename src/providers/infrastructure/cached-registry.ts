import type { Clock } from '@/clock/index.ts';
import type { ModelRuntimeConfig, ProviderRuntimeConfig } from '../domain/capabilities.ts';
import type { ModelRecord, ProviderRecord } from '../domain/registry.ts';
import type { ModelRegistry, ResolvedModel } from '../ports/model-registry.ts';
import type { RegistryRepository } from '../ports/registry-repository.ts';
import type { SecretResolver } from '../ports/secret-resolver.ts';

/**
 * Read-through cache in front of the registry repository: a snapshot is
 * refreshed lazily and no older than `ttlMs` (30 s). An admin write in this process calls
 * `invalidate()` so a disabled model stops accepting new generations immediately; other
 * nodes converge within the TTL. In-flight generations keep the config they started with.
 */

interface Snapshot {
  readonly models: readonly ModelRecord[];
  readonly providers: readonly ProviderRecord[];
  readonly at: number;
}

export interface CachedRegistryOptions {
  readonly repository: RegistryRepository;
  readonly secrets: SecretResolver;
  readonly clock: Clock;
  readonly ttlMs?: number;
}

export class CachedModelRegistry implements ModelRegistry {
  private readonly repository: RegistryRepository;
  private readonly secrets: SecretResolver;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private snapshot: Snapshot | undefined;
  private inFlightLoad: Promise<Snapshot> | null = null;

  constructor(options: CachedRegistryOptions) {
    this.repository = options.repository;
    this.secrets = options.secrets;
    this.clock = options.clock;
    this.ttlMs = options.ttlMs ?? 30_000;
  }

  invalidate(): void {
    this.snapshot = undefined;
    this.inFlightLoad = null;
  }

  private async load(): Promise<Snapshot> {
    const now = this.clock.now().getTime();
    if (this.snapshot !== undefined && now - this.snapshot.at < this.ttlMs) {
      return this.snapshot;
    }
    if (this.inFlightLoad !== null) {
      return this.inFlightLoad;
    }

    this.inFlightLoad = Promise.all([
      this.repository.findAllModels(),
      this.repository.findAllProviders(),
    ])
      .then(([models, providers]) => {
        const snapshot: Snapshot = { models, providers, at: this.clock.now().getTime() };
        this.snapshot = snapshot;
        return snapshot;
      })
      .finally(() => {
        this.inFlightLoad = null;
      });

    return this.inFlightLoad;
  }

  async listVisibleModels(): Promise<readonly ModelRecord[]> {
    const { models, providers } = await this.load();
    const enabled = new Set(
      providers.filter((provider) => provider.status === 'active').map((provider) => provider.id),
    );
    return models.filter(
      (model) => enabled.has(model.providerId) && model.status === 'active',
    );
  }

  async listAllModels(): Promise<readonly ModelRecord[]> {
    return (await this.load()).models;
  }

  async listAllProviders(): Promise<readonly ProviderRecord[]> {
    return (await this.load()).providers;
  }

  async getModel(modelId: string): Promise<ModelRecord | null> {
    const { models } = await this.load();
    return models.find((model) => model.id === modelId) ?? null;
  }

  async getProvider(providerId: string): Promise<ProviderRecord | null> {
    const { providers } = await this.load();
    return providers.find((provider) => provider.id === providerId) ?? null;
  }

  async getRuntimeConfig(modelId: string): Promise<ResolvedModel | null> {
    const { models, providers } = await this.load();
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) return null;
    const provider = providers.find((candidate) => candidate.id === model.providerId);
    if (!provider) return null;

    const secret = this.secrets.resolve(provider.secretRef);
    const secrets: Record<string, string> = secret === null ? {} : { apiKey: secret };

    const modelRuntime: ModelRuntimeConfig = {
      modelId: model.id,
      providerId: provider.id,
      apiModelId: model.apiModelId,
      displayName: model.displayName,
      capabilities: model.capabilities,
      maxOutputTokens: model.maxOutputTokens,
      defaultMaxOutputTokens: model.defaultMaxOutputTokens,
      quotaWeight: model.quotaWeight,
      config: model.config,
    };
    const providerRuntime: ProviderRuntimeConfig = {
      providerId: provider.id,
      key: provider.key,
      adapter: provider.adapter,
      ...(provider.baseUrl !== null ? { baseUrl: provider.baseUrl } : {}),
      config: provider.config,
      secrets,
    };

    return { model, provider, runtime: { model: modelRuntime, provider: providerRuntime } };
  }
}
