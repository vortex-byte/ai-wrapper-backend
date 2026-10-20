/**
 * Model/provider capability and runtime configuration as seen by the PAL.
 * The orchestrator and context builder ask "can this model take images?"
 * — never "is this OpenAI?". These shapes are assembled by the registry from the DB
 * rows plus the environment; adapters receive them by injection and never read env/DB
 * themselves.
 *
 * Pure types only.
 */

import type { NormalizedMessage } from './pal.ts';

export interface DocumentCapabilities {
  readonly pdf: boolean;
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
  /**
   * Cloud-container document generation. When set, adapters attach their provider's sandbox tool
   * and skills, and the prompt writes generated artifacts to `$OUTPUT_DIR` so the provider hands
   * them back as files.
   */
  readonly container?: ContainerRequest | undefined;
  /**
   * Input binaries the container should mount, already uploaded to the provider's Files API.
   * Nothing populates this yet: the adapters consume it, but no caller uploads and caches ids.
   */
  readonly inputFiles?: readonly MountedInputFile[] | undefined;
}

/** Anthropic's official document-generation skills; OpenAI uses its own skill ids. */
export type ContainerSkillId = 'pdf' | 'docx' | 'xlsx' | 'pptx';

export interface ContainerRequest {
  readonly codeExecution: boolean;
  readonly skills?: readonly ContainerSkillId[] | undefined;
  readonly containerId?: string | undefined;
  /**
   * Environment variable the prompt must write generated files to. The adapter never
   * interpolates a filesystem path — the provider owns the sandbox layout.
   */
  readonly outputDirEnv?: string | undefined;
}

export interface MountedInputFile {
  readonly providerFileId: string;
  readonly filename: string;
  readonly mimeType: string;
}
