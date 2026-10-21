import type { ModelRuntimeConfig, ProviderRuntimeConfig } from '../domain/capabilities.ts';
import type { ModelRecord, ProviderRecord } from '../domain/registry.ts';

/** Read-only registry port for retrieving models, providers, and runtime configurations. */

/** A model's runtime config plus the provider it belongs to, resolved together. */
export interface ResolvedModel {
  readonly model: ModelRecord;
  readonly provider: ProviderRecord;
  /** The PAL-shaped config the orchestrator hands to an adapter (secrets carry env values). */
  readonly runtime: {
    readonly model: ModelRuntimeConfig;
    readonly provider: ProviderRuntimeConfig;
  };
}

export interface ModelRegistry {
  /** All models the caller may pick for a new conversation, with provider labels. */
  listVisibleModels(): Promise<readonly ModelRecord[]>;

  /** Admin listing: every model regardless of status. */
  listAllModels(): Promise<readonly ModelRecord[]>;

  /** Admin listing: every provider regardless of status. */
  listAllProviders(): Promise<readonly ProviderRecord[]>;

  /** Resolve one model for `/models/:id`, or `null` when unknown. */
  getModel(modelId: string): Promise<ModelRecord | null>;

  /** Resolve one provider, or `null` when unknown. */
  getProvider(providerId: string): Promise<ProviderRecord | null>;

  /** Resolves runtime model and provider configuration for execution. */
  getRuntimeConfig(modelId: string): Promise<ResolvedModel | null>;

  /** Drop the in-process cache (called after an admin write in the same process). */
  invalidate(): void;
}
