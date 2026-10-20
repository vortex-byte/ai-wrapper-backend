import { Hono } from 'hono';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { Config } from '@/config/index.ts';
import { AppError } from '@/errors.ts';
import { ok } from '@/http/envelope.ts';
import { requireSuperAdmin } from '@/http/middleware/require-role.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requireCsrf } from '@/http/middleware/require-csrf.ts';
import { requirePasswordChanged } from '@/http/middleware/require-password-changed.ts';
import { clientIp, requestMeta } from '@/http/request-meta.ts';
import type { AppEnv } from '@/http/types.ts';
import { parseJsonBody } from '@/http/validate.ts';
import type { ModelRecord, ProviderRecord } from '../domain/registry.ts';
import { parseCapabilities } from '../domain/capabilities-schema.ts';
import type { ModelPrice } from '../ports/registry-repository.ts';
import type { RegistryAdminService } from '../application/registry-admin-service.ts';
import {
  CreateModelBodySchema,
  CreateProviderBodySchema,
  SetPriceBodySchema,
  UpdateModelBodySchema,
  UpdateProviderBodySchema,
} from './schemas.ts';

export interface RegistryAdminRoutesDeps {
  readonly registryAdmin: RegistryAdminService;
  readonly auth: AuthService;
  readonly config: Config;
}

/**
 * `secretRef` is echoed back (it is an env-var name), never any key material.
 */
export function registryAdminRoutes(deps: RegistryAdminRoutesDeps): Hono<AppEnv> {
  const { registryAdmin, auth, config } = deps;
  const routes = new Hono<AppEnv>();

  routes.use('*', requireCsrf(config));
  routes.use('*', requireAuth(auth, config));
  routes.use('*', requirePasswordChanged());
  routes.use('*', requireSuperAdmin());

  routes.get('/providers', async (c) => {
    const providers = await registryAdmin.listProviders();
    return c.json(ok({ items: providers.map(toWireProvider) }));
  });

  routes.post('/providers', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const body = await parseJsonBody(c, CreateProviderBodySchema);
    const provider = await registryAdmin.createProvider({
      key: body.key,
      displayName: body.displayName,
      adapter: body.adapter,
      baseUrl: body.baseUrl ?? null,
      secretRef: body.secretRef,
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.config !== undefined ? { config: body.config } : {}),
      actorUserId: caller.user.id,
      meta: requestMeta(c, clientIp(c, config)),
    });
    return c.json(ok(toWireProvider(provider), 'Provider created.'), 201);
  });

  routes.patch('/providers/:id', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const body = await parseJsonBody(c, UpdateProviderBodySchema);
    const provider = await registryAdmin.updateProvider({
      id: c.req.param('id'),
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
      ...(body.secretRef !== undefined ? { secretRef: body.secretRef } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.config !== undefined ? { config: body.config } : {}),
      actorUserId: caller.user.id,
      meta: requestMeta(c, clientIp(c, config)),
    });
    return c.json(ok(toWireProvider(provider), 'Provider updated.'));
  });

  routes.get('/providers/health', async (c) => {
    const items = await registryAdmin.healthSnapshot();
    return c.json(
      ok({
        items: items.map((item) => ({
          providerId: item.providerId,
          key: item.key,
          status: item.status,
          lastCheckAt: item.lastCheckAt ? item.lastCheckAt.toISOString() : null,
          latencyMs: item.latencyMs,
          detail: item.detail,
        })),
      }),
    );
  });

  routes.post('/providers/:id/test', async (c) => {
    const result = await registryAdmin.testProvider(c.req.param('id'));
    return c.json(ok(result));
  });

  routes.get('/models', async (c) => {
    const models = await registryAdmin.listModels();
    return c.json(ok({ items: models.map(toWireModel) }));
  });

  routes.post('/models', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const body = await parseJsonBody(c, CreateModelBodySchema);
    const model = await registryAdmin.createModel({
      providerId: body.providerId,
      key: body.key,
      apiModelId: body.apiModelId,
      displayName: body.displayName,
      description: body.description ?? null,
      ...(body.status !== undefined ? { status: body.status } : {}),
      capabilities: parseCapabilities(body.capabilities),
      ...(body.contextWindow !== undefined ? { contextWindow: body.contextWindow } : {}),
      ...(body.maxOutputTokens !== undefined ? { maxOutputTokens: body.maxOutputTokens } : {}),
      ...(body.defaultMaxOutputTokens !== undefined
        ? { defaultMaxOutputTokens: body.defaultMaxOutputTokens }
        : {}),
      ...(body.quotaWeight !== undefined ? { quotaWeight: body.quotaWeight } : {}),
      ...(body.config !== undefined ? { config: body.config } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      actorUserId: caller.user.id,
      meta: requestMeta(c, clientIp(c, config)),
    });
    return c.json(ok(toWireModel(model), 'Model created.'), 201);
  });

  routes.patch('/models/:id', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const body = await parseJsonBody(c, UpdateModelBodySchema);
    const model = await registryAdmin.updateModel({
      id: c.req.param('id'),
      ...(body.displayName !== undefined ? { displayName: body.displayName } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.status !== undefined ? { status: body.status } : {}),
      ...(body.capabilities !== undefined
        ? { capabilities: parseCapabilities(body.capabilities) }
        : {}),
      ...(body.contextWindow !== undefined ? { contextWindow: body.contextWindow } : {}),
      ...(body.maxOutputTokens !== undefined ? { maxOutputTokens: body.maxOutputTokens } : {}),
      ...(body.defaultMaxOutputTokens !== undefined
        ? { defaultMaxOutputTokens: body.defaultMaxOutputTokens }
        : {}),
      ...(body.quotaWeight !== undefined ? { quotaWeight: body.quotaWeight } : {}),
      ...(body.config !== undefined ? { config: body.config } : {}),
      ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
      actorUserId: caller.user.id,
      meta: requestMeta(c, clientIp(c, config)),
    });
    return c.json(ok(toWireModel(model), 'Model updated.'));
  });

  routes.get('/models/:id/prices', async (c) => {
    const prices = await registryAdmin.listPrices(c.req.param('id'));
    return c.json(ok({ items: prices.map(toWirePrice) }));
  });

  routes.post('/models/:id/prices', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const body = await parseJsonBody(c, SetPriceBodySchema);
    const price = await registryAdmin.setPrice({
      modelId: c.req.param('id'),
      effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : new Date(),
      inputMicrosPerMtok: body.inputMicrosPerMtok,
      outputMicrosPerMtok: body.outputMicrosPerMtok,
      cachedInputMicrosPerMtok: body.cachedInputMicrosPerMtok ?? null,
      currency: body.currency ?? 'USD',
      actorUserId: caller.user.id,
      meta: requestMeta(c, clientIp(c, config)),
    });
    return c.json(ok(toWirePrice(price), 'Price recorded.'), 201);
  });

  return routes;
}

/** Never serializes anything derived from a secret; only `secretRef` (an env-var name). */
function toWireProvider(provider: ProviderRecord) {
  return {
    id: provider.id,
    key: provider.key,
    displayName: provider.displayName,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    secretRef: provider.secretRef,
    status: provider.status,
    config: provider.config,
    configVersion: provider.configVersion,
    createdAt: provider.createdAt.toISOString(),
    updatedAt: provider.updatedAt.toISOString(),
  };
}

function toWireModel(model: ModelRecord) {
  return {
    id: model.id,
    providerId: model.providerId,
    providerKey: model.providerKey,
    providerLabel: model.providerDisplayName,
    key: model.key,
    apiModelId: model.apiModelId,
    displayName: model.displayName,
    description: model.description,
    status: model.status,
    capabilities: model.capabilities,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    defaultMaxOutputTokens: model.defaultMaxOutputTokens,
    quotaWeight: model.quotaWeight,
    config: model.config,
    sortOrder: model.sortOrder,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
  };
}

function toWirePrice(price: ModelPrice) {
  return {
    id: price.id,
    modelId: price.modelId,
    effectiveFrom: price.effectiveFrom.toISOString(),
    inputMicrosPerMtok: price.inputMicrosPerMtok,
    outputMicrosPerMtok: price.outputMicrosPerMtok,
    cachedInputMicrosPerMtok: price.cachedInputMicrosPerMtok,
    currency: price.currency,
  };
}
