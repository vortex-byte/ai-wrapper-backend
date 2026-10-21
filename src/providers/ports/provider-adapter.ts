import type { NormalizedChatRequest, ProviderRuntimeConfig } from '../domain/capabilities.ts';
import type { ProviderError } from '../domain/errors.ts';
import type { GenerationEvent } from '../domain/pal.ts';

export interface EstimateResult {
  readonly tokens: number;
  readonly confidence: 'exact' | 'approx';
}

export interface ExecuteContext {
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export interface HealthCheckResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail?: string;
}

/** Provider config + resolved secrets, passed to a health check (no PAL request context). */
export interface HealthCheckContext {
  readonly provider: ProviderRuntimeConfig;
  readonly signal: AbortSignal;
}

/** A provider-owned binary fetched back from a Files API, ready for `ArtifactSink` to store. */
export interface ProviderArtifact {
  readonly stream: ReadableStream<Uint8Array>;
  /** Size when the provider reports it; `ArtifactSink` always re-measures the stored bytes. */
  readonly sizeBytes?: number | undefined;
  readonly mimeType?: string | undefined;
  readonly filename?: string | undefined;
}

/** Context for Files-API calls (artifact download, input upload). */
export interface FilesApiContext {
  readonly provider: ProviderRuntimeConfig;
  readonly signal: AbortSignal;
}

/** An input binary the platform wants the provider to mount into its cloud container. */
export interface InputFileUpload {
  readonly filename: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface UploadedInputFile {
  readonly providerFileId: string;
}

/** Provider adapter contract implemented by each upstream model provider. */
export interface ProviderAdapter {
  readonly adapterKey: string;

  /** Pure transform used by tests and token estimation. No network. */
  toProviderRequest(req: NormalizedChatRequest): unknown;

  estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult>;

  execute(req: NormalizedChatRequest, ctx: ExecuteContext): AsyncIterable<GenerationEvent>;

  translateError(err: unknown): ProviderError;

  healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult>;

  /** Downloads a provider-generated artifact file stream. */
  fetchArtifactStream?(
    providerFileId: string,
    ctx: FilesApiContext,
  ): Promise<ProviderArtifact>;

  /** Uploads an input file to the provider's file storage API for container mounting. */
  uploadInputFile?(
    file: InputFileUpload,
    ctx: FilesApiContext,
  ): Promise<UploadedInputFile>;
}
