import { Hono } from 'hono';
import type { Config } from '@/config/index.ts';
import { ok } from '@/http/envelope.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requirePasswordChanged } from '@/http/middleware/require-password-changed.ts';
import type { AppEnv } from '@/http/types.ts';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { ModelRecord } from '../domain/registry.ts';
import { conversationCapable } from '../domain/capabilities.ts';
import type { ModelRegistry } from '../ports/model-registry.ts';
import type { SettingsLookup } from '@/settings/application/cached-settings-reader.ts';
import {
  KNOWN_SETTINGS,
  type ImageGenerationConfig,
} from '@/settings/domain/settings.ts';
import {
  imageOutputSurface,
  type ImageOutputSurface,
} from '../application/image-generation-config.ts';

export interface ModelRoutesDeps {
  readonly registry: ModelRegistry;
  readonly settings: SettingsLookup;
  readonly auth: AuthService;
  readonly config: Config;
}

/** Model listing endpoint for authenticated users. */
export function modelRoutes(deps: ModelRoutesDeps): Hono<AppEnv> {
  const { registry, settings, auth, config } = deps;
  const routes = new Hono<AppEnv>();

  routes.get(
    '/models',
    requireAuth(auth, config),
    requirePasswordChanged(),
    async (c) => {
      const models = await registry.listVisibleModels();
      const imageGeneration =
        (await settings.get<ImageGenerationConfig>(KNOWN_SETTINGS.imageGeneration))?.value ??
        undefined;
      const surfaces = new Map<string, ImageOutputSurface>();
      await Promise.all(
        models.map(async (model) => {
          const surface = await imageOutputSurface(registry, model, imageGeneration);
          if (surface !== null) surfaces.set(model.id, surface);
        }),
      );
      return c.json(
        ok({
          items: models.map((model) => {
            const surface = surfaces.get(model.id);
            return toWireModel(model, surface === undefined ? null : surface);
          }),
        }),
      );
    },
  );

  return routes;
}

export interface WireModel {
  readonly id: string;
  readonly displayName: string;
  readonly providerLabel: string;
  readonly status: string;
  readonly capabilities: ModelRecord['capabilities'];
  readonly limits: {
    readonly maxFilesPerMessage: number;
    readonly maxImagesPerMessage: number;
  };
  readonly imageOutput: ImageOutputSurface | null;
}

/** The public model shape: no other row ids, no config, no secrets. */
export function toWireModel(
  model: ModelRecord,
  imageOutput: ImageOutputSurface | null = null,
): WireModel {
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
        conversationCapable(model.capabilities) && model.capabilities.vision
          ? (model.capabilities.maxImagesPerRequest ?? 10)
          : 0,
    },
    imageOutput,
  };
}
