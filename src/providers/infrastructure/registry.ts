import type { ProviderAdapter } from '../ports/provider-adapter.ts';
import type { ProviderRegistry } from '../ports/provider-registry.ts';

/** In-memory adapter registry mapping adapter keys to ProviderAdapter instances. */
export class InMemoryProviderRegistry implements ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.adapterKey, adapter);
  }

  get(adapterKey: string): ProviderAdapter | null {
    return this.adapters.get(adapterKey) ?? null;
  }

  has(adapterKey: string): boolean {
    return this.adapters.has(adapterKey);
  }

  keys(): readonly string[] {
    return [...this.adapters.keys()];
  }
}
