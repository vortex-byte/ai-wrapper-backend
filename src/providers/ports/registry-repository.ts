import type { TransactionContext } from '@/db/tx.ts';
import type { ModelRecord, ProviderRecord } from '../domain/registry.ts';
import type { ModelCapabilities } from '../domain/capabilities.ts';

/**
 * Persistence port for the registry (implemented by Drizzle in `infrastructure/`).
 * Reads are consumed through `ModelRegistry`; writes only by the admin application service.
 * Every write takes the transaction handle so the audit row commits with the change.
 */

export interface CreateProviderInput {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
  readonly adapter: string;
  readonly baseUrl: string | null;
  readonly secretRef: string;
  readonly status: 'active' | 'disabled';
  readonly config: Readonly<Record<string, unknown>>;
}

export interface UpdateProviderInput {
  readonly id: string;
  readonly displayName?: string;
  readonly baseUrl?: string | null;
  readonly secretRef?: string;
  readonly status?: 'active' | 'disabled';
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface CreateModelInput {
  readonly id: string;
  readonly providerId: string;
  readonly key: string;
  readonly apiModelId: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: 'active' | 'disabled';
  readonly capabilities: ModelCapabilities;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly defaultMaxOutputTokens: number;
  readonly quotaWeight: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly sortOrder: number;
}

export interface UpdateModelInput {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string | null;
  readonly status?: 'active' | 'disabled';
  readonly capabilities?: ModelCapabilities;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly defaultMaxOutputTokens?: number;
  readonly quotaWeight?: number;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly sortOrder?: number;
}

export interface UpsertPriceInput {
  readonly id: string;
  readonly modelId: string;
  readonly effectiveFrom: Date;
  readonly inputMicrosPerMtok: number;
  readonly outputMicrosPerMtok: number;
  readonly cachedInputMicrosPerMtok: number | null;
  readonly currency: string;
}

export interface ModelPrice {
  readonly id: string;
  readonly modelId: string;
  readonly effectiveFrom: Date;
  readonly inputMicrosPerMtok: number;
  readonly outputMicrosPerMtok: number;
  readonly cachedInputMicrosPerMtok: number | null;
  readonly currency: string;
}

export interface RegistryRepository {
  findAllProviders(tx?: TransactionContext): Promise<ProviderRecord[]>;
  findProviderById(id: string, tx?: TransactionContext): Promise<ProviderRecord | null>;
  findProviderByKey(key: string, tx?: TransactionContext): Promise<ProviderRecord | null>;
  createProvider(input: CreateProviderInput, tx?: TransactionContext): Promise<ProviderRecord>;
  updateProvider(input: UpdateProviderInput, tx?: TransactionContext): Promise<ProviderRecord | null>;

  /** Every model joined with its provider (the shape the registry cache stores). */
  findAllModels(tx?: TransactionContext): Promise<ModelRecord[]>;
  findModelById(id: string, tx?: TransactionContext): Promise<ModelRecord | null>;
  findModelByKey(key: string, tx?: TransactionContext): Promise<ModelRecord | null>;
  createModel(input: CreateModelInput, tx?: TransactionContext): Promise<ModelRecord>;
  updateModel(input: UpdateModelInput, tx?: TransactionContext): Promise<ModelRecord | null>;

  listPrices(modelId: string, tx?: TransactionContext): Promise<ModelPrice[]>;
  upsertPrice(input: UpsertPriceInput, tx?: TransactionContext): Promise<ModelPrice>;
}
