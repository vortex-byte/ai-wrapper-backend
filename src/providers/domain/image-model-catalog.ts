import type { ModelCapabilities } from '../domain/capabilities.ts';

/** Upstream identifiers, not rows: `syncImageModelCatalog()` materializes a row on first selection, so quota and usage reference the model that rendered the turn. */
export interface ImageModelCatalogEntry {
  readonly apiModelId: string;
  readonly displayName: string;
  readonly description: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly defaultMaxOutputTokens: number;
  readonly quotaWeight: number;
  readonly imageSizes: readonly string[];
  readonly aspectRatios: readonly string[];
}

const NANO_BANANA_ASPECT_RATIOS = [
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

const GEMINI_IMAGE_DEFAULTS = {
  contextWindow: 1_048_576,
  maxOutputTokens: 65_536,
  defaultMaxOutputTokens: 16_384,
  aspectRatios: NANO_BANANA_ASPECT_RATIOS,
} as const;

export const IMAGE_MODEL_CATALOG: Readonly<
  Record<'gemini' | 'openai', readonly ImageModelCatalogEntry[]>
> = {
  gemini: [
    {
      apiModelId: 'gemini-nano-banana-2.1',
      displayName: 'Nano Banana 2.1',
      description: 'Gemini image model that renders and edits images in the same turn.',
      ...GEMINI_IMAGE_DEFAULTS,
      quotaWeight: 1,
      imageSizes: ['1K', '2K', '4K'],
    },
    {
      apiModelId: 'gemini-3.1-flash-image',
      displayName: 'Nano Banana 2',
      description: 'Fast image generation and editing variant of the Nano Banana family.',
      ...GEMINI_IMAGE_DEFAULTS,
      quotaWeight: 0.75,
      imageSizes: ['1K', '2K', '4K'],
    },
    {
      apiModelId: 'gemini-3.1-flash-lite-image',
      displayName: 'Nano Banana 2 Lite',
      description: 'Cheapest image generation and editing variant of the Nano Banana family.',
      ...GEMINI_IMAGE_DEFAULTS,
      quotaWeight: 0.5,
      imageSizes: ['1K', '2K'],
    },
    {
      apiModelId: 'gemini-3-pro-image',
      displayName: 'Nano Banana Pro',
      description:
        'Highest-fidelity image generation and editing model, with text rendering up to 4K.',
      ...GEMINI_IMAGE_DEFAULTS,
      maxOutputTokens: 32768,
      quotaWeight: 1.5,
      imageSizes: ['1K', '2K', '4K'],
    },
    {
      apiModelId: 'gemini-2.5-flash-image',
      displayName: 'Nano Banana',
      description: 'Legacy Nano Banana model for image generation and editing.',
      ...GEMINI_IMAGE_DEFAULTS,
      maxOutputTokens: 32768,
      quotaWeight: 0.5,
      imageSizes: ['1K', '2K'],
    },
  ],
  openai: [
    {
      apiModelId: 'gpt-image-2.5-sunburst',
      displayName: 'GPT Image 2.5 Sunburst',
      description: 'OpenAI image model used by the hosted image tool.',
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      defaultMaxOutputTokens: 4_096,
      quotaWeight: 1,
      imageSizes: ['1024x1024', '1536x1024', '1024x1536'],
      aspectRatios: [],
    },
    {
      apiModelId: 'gpt-image-2.5-flare',
      displayName: 'GPT Image 2.5 Flare',
      description: 'OpenAI image model used by the hosted image tool.',
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
      defaultMaxOutputTokens: 4_096,
      quotaWeight: 1,
      imageSizes: ['1024x1024', '1536x1024', '1024x1536'],
      aspectRatios: [],
    },
  ],
};

export function findCatalogEntry(
  providerKey: string,
  apiModelId: string,
): ImageModelCatalogEntry | null {
  if (providerKey !== 'gemini' && providerKey !== 'openai') return null;
  return IMAGE_MODEL_CATALOG[providerKey].find((entry) => entry.apiModelId === apiModelId) ?? null;
}

/** `mode: 'tool'` keeps it conversation-capable (can execute a routed turn); `internal: true` keeps it out of the admin model page and user picker. */
export function imageModelCapabilities(): ModelCapabilities {
  return {
    streaming: true,
    vision: true,
    documents: { pdf: false },
    imageGeneration: { mode: 'tool' },
    documentGeneration: false,
    systemPrompt: true,
    tools: false,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
  };
}
