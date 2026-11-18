import type { ProviderDialect, ProviderDialectInput } from '../domain/dialect.ts';
import type { ProviderAdapter } from './provider-adapter.ts';

/** Registry port mapping adapter keys to ProviderAdapter instances. */
export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  get(adapterKey: string): ProviderAdapter | null;
  has(adapterKey: string): boolean;
  keys(): readonly string[];
  /** Effective feature set for a provider deployment; adapter defaults narrowed by `config.dialect`. */
  dialect(provider: ProviderDialectInput): ProviderDialect;
}