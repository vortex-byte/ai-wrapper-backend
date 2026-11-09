/** Model and provider capability declarations for the Provider Abstraction Layer (PAL). */

import type { NormalizedMessage } from './pal.ts';

/** Selectable reasoning depths, ordered from shallowest to deepest. */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ReasoningCapability {
  readonly availableEfforts: readonly ReasoningEffort[];
  readonly defaultEffort: ReasoningEffort;
}

export interface PartialReasoningCapability {
  readonly availableEfforts?: readonly ReasoningEffort[];
  readonly defaultEffort?: ReasoningEffort;
}

export interface DocumentCapabilities {
  readonly pdf: boolean;
  readonly maxPages?: number;
}

/** Provider-side compaction: older turns are summarized by the provider once the trigger fires. */
export interface CompactionCapability {
  /** Tokens of input at which the provider compacts. Defaults to 80% of the context window. */
  readonly triggerTokens?: number;
}

/** How a model produces images: through the chat tool, or as a dedicated image endpoint. */
export type ImageGenerationMode = 'tool' | 'provider';

export interface ImageGenerationCapability {
  readonly mode: ImageGenerationMode;
  /** The provider model id that renders the images. Only meaningful for `tool` (default) and image-only rows. */
  readonly model?: string;
}

/** Whether the model can produce images at all, regardless of role. */
export function canGenerateImages(
  capabilities: Pick<ModelCapabilities, 'imageGeneration'>,
): boolean {
  return capabilities.imageGeneration !== undefined && capabilities.imageGeneration !== null;
}

/**
 * Whether the chat tool can ask this model for images. `provider`-mode rows are image endpoints:
 * they never run as a conversation target, so they never drive a chat request.
 */
export function imageToolSupported(
  capabilities: Pick<ModelCapabilities, 'imageGeneration'>,
): boolean {
  return capabilities.imageGeneration?.mode === 'tool';
}

/** Whether the model can be the target of a conversation. Image endpoints cannot. */
export function conversationCapable(
  capabilities: Pick<ModelCapabilities, 'imageGeneration'>,
): boolean {
  return capabilities.imageGeneration?.mode !== 'provider';
}

export interface PartialDocumentCapabilities {
  readonly pdf?: boolean;
  readonly maxPages?: number;
}

export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly vision: boolean;
  readonly documents: DocumentCapabilities;
  readonly imageGeneration: ImageGenerationCapability | null;
  readonly documentGeneration: boolean;
  readonly systemPrompt: boolean;
  readonly tools: boolean;
  readonly maxImagesPerRequest?: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  /** Omitted when the provider cannot compact this model's history server-side. */
  readonly compaction?: CompactionCapability;
  /** Omitted when the model is not configurable as a reasoning model. */
  readonly reasoning?: ReasoningCapability;
}

/** Admin patch: omitted keys keep their stored value. */
export interface PartialModelCapabilities {
  readonly streaming?: boolean;
  readonly vision?: boolean;
  readonly documents?: PartialDocumentCapabilities;
  /** `null` clears the stored capability; omission keeps it. */
  readonly imageGeneration?: ImageGenerationCapability | null;
  readonly documentGeneration?: boolean;
  readonly systemPrompt?: boolean;
  readonly tools?: boolean;
  readonly maxImagesPerRequest?: number | null;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  /** `null` clears the stored capability; omission keeps it. */
  readonly compaction?: CompactionCapability | null;
  /** `null` clears the stored capability; omission keeps it. */
  readonly reasoning?: PartialReasoningCapability | null;
}

/** The model a generation runs on, resolved from the registry. */
export interface ModelRuntimeConfig {
  readonly modelId: string;
  readonly providerId: string;
  readonly apiModelId: string;
  readonly displayName: string;
  readonly capabilities: ModelCapabilities;
  readonly maxOutputTokens: number;
  readonly defaultMaxOutputTokens: number;
  readonly quotaWeight: number;
  readonly config: Readonly<Record<string, unknown>>;
}

/** The provider a generation runs through. Secrets are resolved from env by the composition root. */
export interface ProviderRuntimeConfig {
  readonly providerId: string;
  readonly key: string;
  readonly adapter: string;
  readonly baseUrl?: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
}

export interface NormalizedChatRequest {
  readonly requestId: string;
  readonly generationId: string;
  readonly model: ModelRuntimeConfig;
  readonly provider: ProviderRuntimeConfig;
  readonly system?: string;
  readonly messages: readonly NormalizedMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly responseModalities: readonly ('text' | 'image' | 'file')[];
  /** Reasoning depth for this turn; absent when the model has no reasoning capability. */
  readonly reasoningEffort?: ReasoningEffort | undefined;
  readonly tools?: never;
  readonly metadata: { readonly userIdHash: string };
  /** Container sandbox request for code execution and file generation. */
  readonly container?: ContainerRequest | undefined;
  /** Input files to mount into container execution environment. */
  readonly inputFiles?: readonly MountedInputFile[] | undefined;
}

/** Anthropic's official document-generation skills; OpenAI uses its own skill ids. */
export type ContainerSkillId = 'pdf' | 'docx' | 'xlsx' | 'pptx';

export interface ContainerRequest {
  readonly codeExecution: boolean;
  readonly skills?: readonly ContainerSkillId[] | undefined;
  readonly containerId?: string | undefined;
  /** Environment variable name specifying sandbox output directory. */
  readonly outputDirEnv?: string | undefined;
}

export interface MountedInputFile {
  readonly providerFileId: string;
  readonly filename: string;
  readonly mimeType: string;
}
