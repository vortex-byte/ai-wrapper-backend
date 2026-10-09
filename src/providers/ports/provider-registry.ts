import type { ProviderAdapter } from './provider-adapter.ts';

/**
 * Resolves an adapter implementation by its `adapterKey` (the value stored in
 * `ai_providers.adapter`). Adding a provider is: write the adapter, register its key
 * here, insert registry rows — no orchestrator/API/schema changes.
 */
export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  get(adapterKey: string): ProviderAdapter | null;
  has(adapterKey: string): boolean;
  keys(): readonly string[];
}
