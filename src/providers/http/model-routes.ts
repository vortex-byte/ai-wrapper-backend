import { Hono } from 'hono';
import type { Config } from '@/config/index.ts';
import { ok } from '@/http/envelope.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requirePasswordChanged } from '@/http/middleware/require-password-changed.ts';
import type { AppEnv } from '@/http/types.ts';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { ModelRecord } from '../domain/registry.ts';
import type { ModelRegistry } from '../ports/model-registry.ts';

export interface ModelRoutesDeps {
  readonly registry: ModelRegistry;
  readonly auth: AuthService;
  readonly config: Config;
}

/** Model listing endpoint for authenticated users. */
export function modelRoutes(deps: ModelRoutesDeps): Hono<AppEnv> {
  const { registry, auth, config } = deps;
  const routes = new Hono<AppEnv>();

  routes.get(
    '/models',
    requireAuth(auth, config),
    requirePasswordChanged(),
    async (c) => {
      const models = await registry.listVisibleModels();
      return c.json(ok({ items: models.map(toWireModel) }));
    },
  );

  return routes;
}

/** The public model shape: no other row ids, no config, no secrets. */
function toWireModel(model: ModelRecord) {
  return {
    id: model.id,
    displayName: model.displayName,
    providerLabel: model.providerDisplayName,
    status: model.status,
    capabilities: model.capabilities,
    limits: {
      maxFilesPerMessage:
        model.capabilities.documents.pdf || model.capabilities.vision ? 5 : 0,
      maxImagesPerMessage:
        model.capabilities.maxImagesPerRequest ?? (model.capabilities.vision ? 10 : 0),
    },
  };
}
