import { asc, desc, eq, sql } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { aiModelPrices, aiModels, aiProviders } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import type { ModelCapabilities } from '../domain/capabilities.ts';
import { parseCapabilities, parseConfig, toCapabilitiesJson } from '../domain/capabilities-schema.ts';
import type { ModelRecord, ModelStatus, ProviderRecord, ProviderStatus } from '../domain/registry.ts';
import type {
  CreateModelInput,
  CreateProviderInput,
  ModelPrice,
  RegistryRepository,
  UpdateModelInput,
  UpdateProviderInput,
  UpsertPriceInput,
} from '../ports/registry-repository.ts';

/**
 * Drizzle implementation of the registry persistence port. Explicit column lists only
 * (never `SELECT *`); JSONB blobs are parsed at this boundary so nothing above holds an
 * untyped object.
 */

const providerColumns = {
  id: aiProviders.id,
  key: aiProviders.key,
  displayName: aiProviders.displayName,
  adapter: aiProviders.adapter,
  baseUrl: aiProviders.baseUrl,
  secretRef: aiProviders.secretRef,
  status: aiProviders.status,
  config: aiProviders.config,
  configVersion: aiProviders.configVersion,
  createdAt: aiProviders.createdAt,
  updatedAt: aiProviders.updatedAt,
} as const;

const modelColumns = {
  id: aiModels.id,
  providerId: aiModels.providerId,
  providerKey: aiProviders.key,
  providerDisplayName: aiProviders.displayName,
  providerStatus: aiProviders.status,
  key: aiModels.key,
  apiModelId: aiModels.apiModelId,
  displayName: aiModels.displayName,
  description: aiModels.description,
  status: aiModels.status,
  capabilities: aiModels.capabilities,
  contextWindow: aiModels.contextWindow,
  maxOutputTokens: aiModels.maxOutputTokens,
  defaultMaxOutputTokens: aiModels.defaultMaxOutputTokens,
  quotaWeight: aiModels.quotaWeight,
  config: aiModels.config,
  sortOrder: aiModels.sortOrder,
  createdAt: aiModels.createdAt,
  updatedAt: aiModels.updatedAt,
} as const;

interface ProviderRow {
  id: string;
  key: string;
  displayName: string;
  adapter: string;
  baseUrl: string | null;
  secretRef: string;
  status: string;
  config: unknown;
  configVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ModelRow {
  id: string;
  providerId: string;
  providerKey: string;
  providerDisplayName: string;
  providerStatus: string;
  key: string;
  apiModelId: string;
  displayName: string;
  description: string | null;
  status: string;
  capabilities: unknown;
  contextWindow: number;
  maxOutputTokens: number;
  defaultMaxOutputTokens: number;
  quotaWeight: string | number;
  config: unknown;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

function toProvider(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    key: row.key,
    displayName: row.displayName,
    adapter: row.adapter,
    baseUrl: row.baseUrl,
    secretRef: row.secretRef,
    status: row.status as ProviderStatus,
    config: parseConfig(row.config),
    configVersion: row.configVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toModel(row: ModelRow): ModelRecord {
  return {
    id: row.id,
    providerId: row.providerId,
    providerKey: row.providerKey,
    providerDisplayName: row.providerDisplayName,
    providerStatus: row.providerStatus as ProviderStatus,
    key: row.key,
    apiModelId: row.apiModelId,
    displayName: row.displayName,
    description: row.description,
    status: row.status as ModelStatus,
    capabilities: parseCapabilities(row.capabilities),
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    defaultMaxOutputTokens: row.defaultMaxOutputTokens,
    quotaWeight: Number(row.quotaWeight),
    config: parseConfig(row.config),
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Model columns joined with the provider columns the registry records carry. */
function modelSelect(db: ReturnType<typeof runDb>) {
  return db.select(modelColumns).from(aiModels).innerJoin(aiProviders, eq(aiModels.providerId, aiProviders.id));
}

function capabilitiesToJson(capabilities: ModelCapabilities): Record<string, unknown> {
  return toCapabilitiesJson(capabilities);
}

export class DrizzleRegistryRepository implements RegistryRepository {
  async findAllProviders(tx?: TransactionContext): Promise<ProviderRecord[]> {
    const rows = await runDb(tx)
      .select(providerColumns)
      .from(aiProviders)
      .orderBy(asc(aiProviders.key));
    return rows.map(toProvider);
  }

  async findProviderById(id: string, tx?: TransactionContext): Promise<ProviderRecord | null> {
    const rows = await runDb(tx)
      .select(providerColumns)
      .from(aiProviders)
      .where(eq(aiProviders.id, id))
      .limit(1);
    return rows[0] ? toProvider(rows[0]) : null;
  }

  async findProviderByKey(key: string, tx?: TransactionContext): Promise<ProviderRecord | null> {
    const rows = await runDb(tx)
      .select(providerColumns)
      .from(aiProviders)
      .where(eq(aiProviders.key, key))
      .limit(1);
    return rows[0] ? toProvider(rows[0]) : null;
  }

  async createProvider(
    input: CreateProviderInput,
    tx?: TransactionContext,
  ): Promise<ProviderRecord> {
    const rows = await runDb(tx)
      .insert(aiProviders)
      .values({
        id: input.id,
        key: input.key,
        displayName: input.displayName,
        adapter: input.adapter,
        baseUrl: input.baseUrl,
        secretRef: input.secretRef,
        status: input.status,
        config: input.config,
      })
      .returning(providerColumns);
    const row = rows[0];
    if (!row) throw new Error('insert into ai_providers returned no row');
    return toProvider(row);
  }

  async updateProvider(
    input: UpdateProviderInput,
    tx?: TransactionContext,
  ): Promise<ProviderRecord | null> {
    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
      configVersion: sql`${aiProviders.configVersion} + 1`,
    };
    if (input.displayName !== undefined) updates.displayName = input.displayName;
    if (input.baseUrl !== undefined) updates.baseUrl = input.baseUrl;
    if (input.secretRef !== undefined) updates.secretRef = input.secretRef;
    if (input.status !== undefined) updates.status = input.status;
    if (input.config !== undefined) updates.config = input.config;

    const rows = await runDb(tx)
      .update(aiProviders)
      .set(updates)
      .where(eq(aiProviders.id, input.id))
      .returning(providerColumns);
    return rows[0] ? toProvider(rows[0]) : null;
  }

  async findAllModels(tx?: TransactionContext): Promise<ModelRecord[]> {
    const rows = await modelSelect(runDb(tx))
      .orderBy(asc(aiModels.sortOrder), asc(aiModels.id));
    return rows.map(toModel);
  }

  async findModelById(id: string, tx?: TransactionContext): Promise<ModelRecord | null> {
    const rows = await modelSelect(runDb(tx)).where(eq(aiModels.id, id)).limit(1);
    return rows[0] ? toModel(rows[0]) : null;
  }

  async findModelByKey(key: string, tx?: TransactionContext): Promise<ModelRecord | null> {
    const rows = await modelSelect(runDb(tx)).where(eq(aiModels.key, key)).limit(1);
    return rows[0] ? toModel(rows[0]) : null;
  }

  async createModel(input: CreateModelInput, tx?: TransactionContext): Promise<ModelRecord> {
    const inserted = await runDb(tx)
      .insert(aiModels)
      .values({
        id: input.id,
        providerId: input.providerId,
        key: input.key,
        apiModelId: input.apiModelId,
        displayName: input.displayName,
        description: input.description,
        status: input.status,
        capabilities: capabilitiesToJson(input.capabilities),
        contextWindow: input.contextWindow,
        maxOutputTokens: input.maxOutputTokens,
        defaultMaxOutputTokens: input.defaultMaxOutputTokens,
        quotaWeight: input.quotaWeight.toFixed(3),
        config: input.config,
        sortOrder: input.sortOrder,
      })
      .returning({ id: aiModels.id });
    const insertedRow = inserted[0];
    if (!insertedRow) throw new Error('insert into ai_models returned no row');
    const row = await this.findModelById(insertedRow.id, tx);
    if (!row) throw new Error('created model could not be re-read');
    return row;
  }

  async updateModel(input: UpdateModelInput, tx?: TransactionContext): Promise<ModelRecord | null> {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (input.displayName !== undefined) updates.displayName = input.displayName;
    if (input.description !== undefined) updates.description = input.description;
    if (input.status !== undefined) updates.status = input.status;
    if (input.capabilities !== undefined) updates.capabilities = capabilitiesToJson(input.capabilities);
    if (input.contextWindow !== undefined) updates.contextWindow = input.contextWindow;
    if (input.maxOutputTokens !== undefined) updates.maxOutputTokens = input.maxOutputTokens;
    if (input.defaultMaxOutputTokens !== undefined) {
      updates.defaultMaxOutputTokens = input.defaultMaxOutputTokens;
    }
    if (input.quotaWeight !== undefined) updates.quotaWeight = input.quotaWeight.toFixed(3);
    if (input.config !== undefined) updates.config = input.config;
    if (input.sortOrder !== undefined) updates.sortOrder = input.sortOrder;

    const rows = await runDb(tx)
      .update(aiModels)
      .set(updates)
      .where(eq(aiModels.id, input.id))
      .returning({ id: aiModels.id });
    if (!rows[0]) return null;
    return this.findModelById(input.id, tx);
  }

  async listPrices(modelId: string, tx?: TransactionContext): Promise<ModelPrice[]> {
    const rows = await runDb(tx)
      .select()
      .from(aiModelPrices)
      .where(eq(aiModelPrices.modelId, modelId))
      .orderBy(desc(aiModelPrices.effectiveFrom));
    return rows.map((row) => ({
      id: row.id,
      modelId: row.modelId,
      effectiveFrom: row.effectiveFrom,
      inputMicrosPerMtok: row.inputMicrosPerMtok,
      outputMicrosPerMtok: row.outputMicrosPerMtok,
      cachedInputMicrosPerMtok: row.cachedInputMicrosPerMtok,
      currency: row.currency,
    }));
  }

  async upsertPrice(input: UpsertPriceInput, tx?: TransactionContext): Promise<ModelPrice> {
    const rows = await runDb(tx)
      .insert(aiModelPrices)
      .values({
        id: input.id,
        modelId: input.modelId,
        effectiveFrom: input.effectiveFrom,
        inputMicrosPerMtok: input.inputMicrosPerMtok,
        outputMicrosPerMtok: input.outputMicrosPerMtok,
        cachedInputMicrosPerMtok: input.cachedInputMicrosPerMtok,
        currency: input.currency,
      })
      .onConflictDoUpdate({
        target: [aiModelPrices.modelId, aiModelPrices.effectiveFrom],
        set: {
          inputMicrosPerMtok: input.inputMicrosPerMtok,
          outputMicrosPerMtok: input.outputMicrosPerMtok,
          cachedInputMicrosPerMtok: input.cachedInputMicrosPerMtok,
          currency: input.currency,
        },
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error('upsert into ai_model_prices returned no row');
    return {
      id: row.id,
      modelId: row.modelId,
      effectiveFrom: row.effectiveFrom,
      inputMicrosPerMtok: row.inputMicrosPerMtok,
      outputMicrosPerMtok: row.outputMicrosPerMtok,
      cachedInputMicrosPerMtok: row.cachedInputMicrosPerMtok,
      currency: row.currency,
    };
  }
}
