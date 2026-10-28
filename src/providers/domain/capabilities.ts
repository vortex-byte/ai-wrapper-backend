/** Model and provider capability declarations for the Provider Abstraction Layer (PAL). */

import type { NormalizedMessage } from './pal.ts';

export interface DocumentCapabilities {
  readonly pdf: boolean;
  readonly maxPages?: number;
}

export interface PartialDocumentCapabilities {
  readonly pdf?: boolean;
  readonly maxPages?: number;
}

export interface ModelCapabilities {
  readonly streaming: boolean;
  readonly vision: boolean;
  readonly documents: DocumentCapabilities;
  readonly imageGeneration: boolean;
  readonly documentGeneration: boolean;
  readonly systemPrompt: boolean;
  readonly tools: boolean;
  readonly maxImagesPerRequest?: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

/** Admin patch: omitted keys keep their stored value. */
export interface PartialModelCapabilities {
  readonly streaming?: boolean;
  readonly vision?: boolean;
  readonly documents?: PartialDocumentCapabilities;
  readonly imageGeneration?: boolean;
  readonly documentGeneration?: boolean;
  readonly systemPrompt?: boolean;
  readonly tools?: boolean;
  readonly maxImagesPerRequest?: number;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
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
