import type { AuditLogRepository } from '@/audit/ports/audit-log-repository.ts';
import { AUDIT_ACTIONS } from '@/audit/actions.ts';
import type { Clock, IdGenerator } from '@/clock/index.ts';
import { withTransaction } from '@/db/index.ts';
import { AppError, isUniqueViolation } from '@/errors.ts';
import type { RequestMeta } from '@/request-context.ts';
import type { ModelCapabilities } from '../domain/capabilities.ts';
import type { ModelRecord, ModelStatus, ProviderRecord, ProviderStatus } from '../domain/registry.ts';
import type { ModelRegistry } from '../ports/model-registry.ts';
import type { ProviderAdapter } from '../ports/provider-adapter.ts';
import type { ProviderRegistry } from '../ports/provider-registry.ts';
import type { ModelPrice, RegistryRepository } from '../ports/registry-repository.ts';
import type { SecretResolver } from '../ports/secret-resolver.ts';

/** Admin service for managing providers, models, pricing, and health checks. */

export interface RegistryAdminDeps {
  readonly repository: RegistryRepository;
  readonly registry: ModelRegistry;
  readonly adapters: ProviderRegistry;
  readonly secrets: SecretResolver;
  readonly audit: AuditLogRepository;
  readonly clock: Clock;
  readonly idGen: IdGenerator;
}

export interface CreateProviderInput {
  readonly key: string;
  readonly displayName: string;
  readonly adapter: string;
  readonly baseUrl?: string | null;
  readonly secretRef: string;
  readonly status?: ProviderStatus;
  readonly config?: Record<string, unknown>;
  readonly actorUserId: string;
  readonly meta: RequestMeta;
}

export interface UpdateProviderInput {
  readonly id: string;
  readonly displayName?: string;
  readonly baseUrl?: string | null;
  readonly secretRef?: string;
  readonly status?: ProviderStatus;
  readonly config?: Record<string, unknown>;
  readonly actorUserId: string;
  readonly meta: RequestMeta;
}

export interface CreateModelInput {
  readonly providerId: string;
  readonly key: string;
  readonly apiModelId: string;
  readonly displayName: string;
  readonly description?: string | null;
  readonly status?: ModelStatus;
  readonly capabilities: ModelCapabilities;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly defaultMaxOutputTokens?: number;
  readonly quotaWeight?: number;
  readonly config?: Record<string, unknown>;
  readonly sortOrder?: number;
  readonly actorUserId: string;
  readonly meta: RequestMeta;
}

export interface UpdateModelInput {
  readonly id: string;
  readonly displayName?: string;
  readonly description?: string | null;
  readonly status?: ModelStatus;
  readonly capabilities?: ModelCapabilities;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly defaultMaxOutputTokens?: number;
  readonly quotaWeight?: number;
  readonly config?: Record<string, unknown>;
  readonly sortOrder?: number;
  readonly actorUserId: string;
  readonly meta: RequestMeta;
}

export interface SetPriceInput {
  readonly modelId: string;
  readonly effectiveFrom: Date;
  readonly inputMicrosPerMtok: number;
  readonly outputMicrosPerMtok: number;
  readonly cachedInputMicrosPerMtok?: number | null;
  readonly currency?: string;
  readonly actorUserId: string;
  readonly meta: RequestMeta;
}

export interface ProviderHealth {
  readonly providerId: string;
  readonly key: string;
  readonly status: 'healthy' | 'unhealthy' | 'unknown';
  readonly lastCheckAt: Date | null;
  readonly latencyMs: number | null;
  readonly detail: string | null;
}

export interface RegistryAdminService {
  listProviders(): Promise<readonly ProviderRecord[]>;
  listModels(): Promise<readonly ModelRecord[]>;
  listPrices(modelId: string): Promise<readonly ModelPrice[]>;
  createProvider(input: CreateProviderInput): Promise<ProviderRecord>;
  updateProvider(input: UpdateProviderInput): Promise<ProviderRecord>;
  createModel(input: CreateModelInput): Promise<ModelRecord>;
  updateModel(input: UpdateModelInput): Promise<ModelRecord>;
  setPrice(input: SetPriceInput): Promise<ModelPrice>;
  testProvider(id: string): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
  healthSnapshot(): Promise<readonly ProviderHealth[]>;
}

const DEFAULT_PROVIDER_CONFIG: Record<string, unknown> = {};

export function createRegistryAdminService(deps: RegistryAdminDeps): RegistryAdminService {
  const lastHealth = new Map<string, { at: Date; ok: boolean; latencyMs: number; detail: string | null }>();

  function requireAdapter(adapter: string): void {
    if (!deps.adapters.has(adapter)) {
      throw new AppError('invalid_request', `Unknown adapter "${adapter}".`, {
        details: { fields: [{ field: 'adapter', message: 'No such adapter is registered.' }] },
      });
    }
  }

  function assertOutputTokenBounds(input: { maxOutputTokens: number; defaultMaxOutputTokens: number }): void {
    if (input.defaultMaxOutputTokens > input.maxOutputTokens) {
      throw new AppError('invalid_request', 'defaultMaxOutputTokens must not exceed maxOutputTokens.');
    }
  }

  return {
    async listProviders() {
      return deps.repository.findAllProviders();
    },

    async listModels() {
      return deps.repository.findAllModels();
    },

    async listPrices(modelId) {
      const model = await deps.repository.findModelById(modelId);
      if (!model) throw new AppError('not_found', 'Model not found.');
      return deps.repository.listPrices(modelId);
    },

    async createProvider(input) {
      requireAdapter(input.adapter);
      const existing = await deps.repository.findProviderByKey(input.key);
      if (existing) {
        throw new AppError('conflict', 'A provider with this key already exists.');
      }
      const id = deps.idGen.uuidv7();
      const config = input.config ?? DEFAULT_PROVIDER_CONFIG;
      const createdAt = deps.clock.now();

      const provider = await withTransaction(async (tx) => {
        let created: ProviderRecord;
        try {
          created = await deps.repository.createProvider(
            {
              id,
              key: input.key,
              displayName: input.displayName,
              adapter: input.adapter,
              baseUrl: input.baseUrl ?? null,
              secretRef: input.secretRef,
              status: input.status ?? 'active',
              config,
            },
            tx,
          );
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new AppError('conflict', 'A provider with this key already exists.', { cause: error });
          }
          throw error;
        }
        await deps.audit.append(
          {
            actorUserId: input.actorUserId,
            action: AUDIT_ACTIONS.providerCreate,
            targetType: 'provider',
            targetId: created.id,
            after: publicProvider(created),
            requestId: input.meta.requestId,
            ip: input.meta.ip,
            userAgentHash: input.meta.userAgentHash,
          },
          tx,
        );
        return created;
      });

      void createdAt;
      deps.registry.invalidate();
      return provider;
    },

    async updateProvider(input) {
      const existing = await deps.repository.findProviderById(input.id);
      if (!existing) throw new AppError('not_found', 'Provider not found.');

      const updated = await withTransaction(async (tx) => {
        const result = await deps.repository.updateProvider(
          {
            id: input.id,
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
            ...(input.secretRef !== undefined ? { secretRef: input.secretRef } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(input.config !== undefined ? { config: input.config } : {}),
          },
          tx,
        );
        if (!result) throw new AppError('not_found', 'Provider not found.');
        await deps.audit.append(
          {
            actorUserId: input.actorUserId,
            action: AUDIT_ACTIONS.providerUpdate,
            targetType: 'provider',
            targetId: result.id,
            before: publicProvider(existing),
            after: publicProvider(result),
            requestId: input.meta.requestId,
            ip: input.meta.ip,
            userAgentHash: input.meta.userAgentHash,
          },
          tx,
        );
        return result;
      });

      deps.registry.invalidate();
      return updated;
    },

    async createModel(input) {
      const provider = await deps.repository.findProviderById(input.providerId);
      if (!provider) {
        throw new AppError('invalid_request', 'Provider not found.', {
          details: { fields: [{ field: 'providerId', message: 'No such provider.' }] },
        });
      }
      const capabilities = input.capabilities;
      const contextWindow = input.contextWindow ?? capabilities.contextWindow;
      const maxOutputTokens = input.maxOutputTokens ?? capabilities.maxOutputTokens;
      const defaultMaxOutputTokens = input.defaultMaxOutputTokens ?? capabilities.maxOutputTokens;
      assertOutputTokenBounds({ maxOutputTokens, defaultMaxOutputTokens });

      const existing = await deps.repository.findModelByKey(input.key);
      if (existing) throw new AppError('conflict', 'A model with this key already exists.');

      const id = deps.idGen.uuidv7();
      const model = await withTransaction(async (tx) => {
        let created: ModelRecord;
        try {
          created = await deps.repository.createModel(
            {
              id,
              providerId: input.providerId,
              key: input.key,
              apiModelId: input.apiModelId,
              displayName: input.displayName,
              description: input.description ?? null,
              status: input.status ?? 'disabled',
              capabilities,
              contextWindow,
              maxOutputTokens,
              defaultMaxOutputTokens,
              quotaWeight: input.quotaWeight ?? 1,
              config: input.config ?? {},
              sortOrder: input.sortOrder ?? 0,
            },
            tx,
          );
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new AppError('conflict', 'A model with this key or provider/api id already exists.', {
              cause: error,
            });
          }
          throw error;
        }
        await deps.audit.append(
          {
            actorUserId: input.actorUserId,
            action: AUDIT_ACTIONS.modelCreate,
            targetType: 'model',
            targetId: created.id,
            after: publicModel(created),
            requestId: input.meta.requestId,
            ip: input.meta.ip,
            userAgentHash: input.meta.userAgentHash,
          },
          tx,
        );
        return created;
      });

      deps.registry.invalidate();
      return model;
    },

    async updateModel(input) {
      const existing = await deps.repository.findModelById(input.id);
      if (!existing) throw new AppError('not_found', 'Model not found.');

      const maxOutputTokens = input.maxOutputTokens ?? existing.maxOutputTokens;
      const defaultMaxOutputTokens = input.defaultMaxOutputTokens ?? existing.defaultMaxOutputTokens;
      assertOutputTokenBounds({ maxOutputTokens, defaultMaxOutputTokens });

      const mergedCapabilities: ModelCapabilities | undefined =
        input.capabilities !== undefined || input.contextWindow !== undefined || input.maxOutputTokens !== undefined
          ? {
              ...existing.capabilities,
              ...(input.capabilities ?? {}),
              documents: {
                ...existing.capabilities.documents,
                ...(input.capabilities?.documents ?? {}),
              },
              contextWindow: input.contextWindow ?? input.capabilities?.contextWindow ?? existing.capabilities.contextWindow,
              maxOutputTokens: input.maxOutputTokens ?? input.capabilities?.maxOutputTokens ?? existing.capabilities.maxOutputTokens,
            }
          : undefined;

      const updated = await withTransaction(async (tx) => {
        const result = await deps.repository.updateModel(
          {
            id: input.id,
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(mergedCapabilities !== undefined ? { capabilities: mergedCapabilities } : {}),
            ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
            ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
            ...(input.defaultMaxOutputTokens !== undefined
              ? { defaultMaxOutputTokens: input.defaultMaxOutputTokens }
              : {}),
            ...(input.quotaWeight !== undefined ? { quotaWeight: input.quotaWeight } : {}),
            ...(input.config !== undefined ? { config: input.config } : {}),
            ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          },
          tx,
        );
        if (!result) throw new AppError('not_found', 'Model not found.');
        await deps.audit.append(
          {
            actorUserId: input.actorUserId,
            action: AUDIT_ACTIONS.modelUpdate,
            targetType: 'model',
            targetId: result.id,
            before: publicModel(existing),
            after: publicModel(result),
            requestId: input.meta.requestId,
            ip: input.meta.ip,
            userAgentHash: input.meta.userAgentHash,
          },
          tx,
        );
        return result;
      });

      deps.registry.invalidate();
      return updated;
    },

    async setPrice(input) {
      const model = await deps.repository.findModelById(input.modelId);
      if (!model) throw new AppError('not_found', 'Model not found.');
      const id = deps.idGen.uuidv7();

      return withTransaction(async (tx) => {
        const price = await deps.repository.upsertPrice(
          {
            id,
            modelId: input.modelId,
            effectiveFrom: input.effectiveFrom,
            inputMicrosPerMtok: input.inputMicrosPerMtok,
            outputMicrosPerMtok: input.outputMicrosPerMtok,
            cachedInputMicrosPerMtok: input.cachedInputMicrosPerMtok ?? null,
            currency: input.currency ?? 'USD',
          },
          tx,
        );
        await deps.audit.append(
          {
            actorUserId: input.actorUserId,
            action: AUDIT_ACTIONS.modelPriceSet,
            targetType: 'model',
            targetId: input.modelId,
            after: {
              effectiveFrom: price.effectiveFrom.toISOString(),
              inputMicrosPerMtok: price.inputMicrosPerMtok,
              outputMicrosPerMtok: price.outputMicrosPerMtok,
            },
            requestId: input.meta.requestId,
            ip: input.meta.ip,
            userAgentHash: input.meta.userAgentHash,
          },
          tx,
        );
        return price;
      });
    },

    async testProvider(id) {
      const provider = await deps.repository.findProviderById(id);
      if (!provider) throw new AppError('not_found', 'Provider not found.');
      const adapter = deps.adapters.get(provider.adapter);
      if (!adapter) {
        throw new AppError('invalid_request', `Unknown adapter "${provider.adapter}".`);
      }
      const resolved = await deps.registry.getRuntimeConfig(
        (await firstModelIdForProvider(deps, id)) ?? '',
      );
      const secret = deps.secrets.resolve(provider.secretRef);
      const secrets: Record<string, string> =
        resolved?.runtime.provider.secrets ?? (secret !== null ? { apiKey: secret } : {});
      const runtime = resolved?.runtime.provider ?? {
        providerId: provider.id,
        key: provider.key,
        adapter: provider.adapter,
        ...(provider.baseUrl !== null ? { baseUrl: provider.baseUrl } : {}),
        config: provider.config,
        secrets,
      };
      const controller = new AbortController();
      const result = await healthCheckAdapter(adapter, runtime, controller.signal);
      lastHealth.set(provider.id, {
        at: deps.clock.now(),
        ok: result.ok,
        latencyMs: result.latencyMs,
        detail: result.detail ?? null,
      });
      return { ok: result.ok, latencyMs: result.latencyMs, detail: result.detail ?? '' };
    },

    async healthSnapshot() {
      const providers = await deps.repository.findAllProviders();
      return providers.map((provider) => {
        const entry = lastHealth.get(provider.id);
        return {
          providerId: provider.id,
          key: provider.key,
          status: entry === undefined ? ('unknown' as const) : entry.ok ? ('healthy' as const) : ('unhealthy' as const),
          lastCheckAt: entry?.at ?? null,
          latencyMs: entry?.latencyMs ?? null,
          detail: entry?.detail ?? null,
        };
      });
    },
  };
}

async function firstModelIdForProvider(
  deps: RegistryAdminDeps,
  providerId: string,
): Promise<string | null> {
  const models = await deps.repository.findAllModels();
  return models.find((model) => model.providerId === providerId)?.id ?? null;
}

async function healthCheckAdapter(
  adapter: ProviderAdapter,
  provider: Parameters<ProviderAdapter['healthCheck']>[0]['provider'],
  signal: AbortSignal,
): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
  return adapter.healthCheck({ provider, signal });
}

/** Registry projections for audit rows — never includes any secret value (only `secretRef`). */
function publicProvider(provider: ProviderRecord): Record<string, unknown> {
  return {
    key: provider.key,
    displayName: provider.displayName,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    secretRef: provider.secretRef,
    status: provider.status,
    configVersion: provider.configVersion,
  };
}

function publicModel(model: ModelRecord): Record<string, unknown> {
  return {
    key: model.key,
    apiModelId: model.apiModelId,
    displayName: model.displayName,
    providerId: model.providerId,
    status: model.status,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    quotaWeight: model.quotaWeight,
  };
}
