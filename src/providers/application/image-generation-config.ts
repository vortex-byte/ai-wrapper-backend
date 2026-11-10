import type { ModelRegistry } from '../ports/model-registry.ts';
import type { ModelRecord } from '../domain/registry.ts';
import { conversationCapable, imageToolSupported } from '../domain/capabilities.ts';
import { findCatalogEntry } from '../domain/image-model-catalog.ts';
import type {
  ImageAspectRatio,
  ImageGenerationConfig,
  ImageSize,
} from '@/settings/domain/settings.ts';

export const DEFAULT_IMAGE_ASPECT_RATIOS: readonly ImageAspectRatio[] = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
];

export const DEFAULT_IMAGE_SIZES: readonly ImageSize[] = ['1K', '2K', '4K'];

/** What the composer may offer for one conversation model. `null` hides the image toggle. */
export interface ImageOutputSurface {
  readonly target: 'routed' | 'tool';
  readonly imageModel: { readonly id: string; readonly displayName: string };
  readonly aspectRatios: readonly ImageAspectRatio[];
  readonly imageSizes: readonly ImageSize[];
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length > 0 ? items : null;
}

/** Options a rendering model supports, from its admin-config `imageOutputOptions`. */
export function imageOutputOptionsOf(
  model: ModelRecord,
): { aspectRatios: readonly ImageAspectRatio[]; imageSizes: readonly ImageSize[] } {
  const raw = model.config['imageOutputOptions'];
  const config = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const ratios = readStringArray(config['aspectRatios']) ?? [...DEFAULT_IMAGE_ASPECT_RATIOS];
  const sizes = readStringArray(config['imageSizes']) ?? [...DEFAULT_IMAGE_SIZES];
  return {
    aspectRatios: ratios as readonly ImageAspectRatio[],
    imageSizes: sizes as readonly ImageSize[],
  };
}

export function configuredModelKey(
  providerKey: string,
  config: ImageGenerationConfig | undefined,
): string | null {
  const providerConfig =
    providerKey === 'gemini'
      ? config?.gemini
      : providerKey === 'openai'
        ? config?.openai
        : undefined;
  const modelKey = providerConfig?.modelKey;
  return modelKey !== undefined && modelKey.length > 0 ? modelKey : null;
}

/** The admin-configured active image model for one provider; `null` when none is usable, so nothing may offer image generation. */
export async function configuredImageModel(
  registry: ModelRegistry,
  providerKey: string,
  config: ImageGenerationConfig | undefined,
): Promise<ModelRecord | null> {
  const modelKey = configuredModelKey(providerKey, config);
  if (modelKey === null) return null;
  const models = await registry.listAllModels();
  const target = models.find(
    (model) =>
      model.providerKey === providerKey &&
      (model.id === modelKey || model.apiModelId === modelKey),
  );
  if (target === undefined || target.status !== 'active') return null;
  return target;
}

export interface ResolveImageExecutionDeps {
  readonly registry: ModelRegistry;
  readonly conversationModel: ModelRecord;
  readonly imageGeneration: ImageGenerationConfig | undefined;
}

export interface ResolvedImageExecution {
  readonly model: ModelRecord;
  readonly options: { readonly aspectRatio?: ImageAspectRatio; readonly imageSize?: ImageSize };
}

/** Picks the model that renders an image this turn; `null` means the conversation model renders on its own. */
export async function resolveRoutedImageModel(
  deps: ResolveImageExecutionDeps,
): Promise<ResolvedImageExecution | null> {
  const { registry, conversationModel, imageGeneration } = deps;
  const provider = conversationModel.providerKey;
  if (provider !== 'gemini' && provider !== 'openai') return null;
  if (!imageToolSupported(conversationModel.capabilities)) return null;

  const target = await configuredImageModel(registry, provider, imageGeneration);
  if (target === null) return null;
  if (!canRenderTurn(provider, target)) return null;

  return { model: target, options: {} };
}

/** Gemini runs the whole turn on the image model; OpenAI only names the tool's model. */
function canRenderTurn(providerKey: string, model: ModelRecord): boolean {
  if (providerKey === 'gemini') return conversationCapable(model.capabilities);
  return imageToolSupported(model.capabilities);
}

/** Builds the composer-facing image surface for one conversation model, or null when unavailable. */
export async function imageOutputSurface(
  registry: ModelRegistry,
  conversationModel: ModelRecord,
  imageGeneration: ImageGenerationConfig | undefined,
): Promise<ImageOutputSurface | null> {
  if (!imageToolSupported(conversationModel.capabilities)) return null;

  const configured = await configuredImageModel(
    registry,
    conversationModel.providerKey,
    imageGeneration,
  );
  if (configured === null) return null;

  const routed = conversationModel.providerKey === 'gemini' && canRenderTurn('gemini', configured);
  const imageModel = routed ? configured : conversationModel;
  const { aspectRatios, imageSizes } = imageOutputOptionsOf(imageModel);
  return {
    target: routed ? 'routed' : 'tool',
    imageModel: { id: imageModel.id, displayName: imageModel.displayName },
    aspectRatios,
    imageSizes,
  };
}

/** The provider model name a chat model passes to its image tool, when one is configured. */
export async function toolImageModel(
  registry: ModelRegistry,
  providerKey: string,
  config: ImageGenerationConfig | undefined,
): Promise<string | undefined> {
  const model = await configuredImageModel(registry, providerKey, config);
  return model?.apiModelId;
}

/** Write-time validation for the admin settings page. Returns a human-readable problem, or null. */
export function validateImageGenerationConfig(config: ImageGenerationConfig): string | null {
  for (const providerKey of ['gemini', 'openai'] as const) {
    const modelKey = configuredModelKey(providerKey, config);
    if (modelKey === null) continue;
    if (findCatalogEntry(providerKey, modelKey) === null) {
      return `Unknown ${providerKey} image model "${modelKey}".`;
    }
  }
  return null;
}
