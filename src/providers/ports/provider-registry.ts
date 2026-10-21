import type { ProviderAdapter } from './provider-adapter.ts';

/** Registry port mapping adapter keys to ProviderAdapter instances. */
export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  get(adapterKey: string): ProviderAdapter | null;
  has(adapterKey: string): boolean;
  keys(): readonly string[];
}
