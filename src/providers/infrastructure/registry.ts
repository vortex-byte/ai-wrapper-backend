import type { ProviderAdapter } from '../ports/provider-adapter.ts';
import type { ProviderRegistry } from '../ports/provider-registry.ts';

/**
 * In-process adapter registry. Populated once at boot from `services.ts`; the DB rows
 * only ever reference an adapter by its `adapterKey`, so a missing registration is a
 * configuration error surfaced as `internal_error` by the caller.
 */
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
