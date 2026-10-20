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

/**
 * The adapter contract every provider implements. Owned by the consumers
 * (`generations/`, `orchestrator/`) and implemented under `providers/adapters/<name>/`.
 *
 * Rules:
 * - config and secrets arrive by injection; adapters never read env or the DB;
 * - `execute` MUST honor `signal` and MUST emit exactly one terminal event;
 * - adapters never persist anything and never touch storage.
 */
export interface ProviderAdapter {
  readonly adapterKey: string;

  /** Pure transform used by tests and token estimation. No network. */
  toProviderRequest(req: NormalizedChatRequest): unknown;

  estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult>;

  execute(req: NormalizedChatRequest, ctx: ExecuteContext): AsyncIterable<GenerationEvent>;

  translateError(err: unknown): ProviderError;

  healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult>;

  /**
   * Downloads a provider-generated file (Anthropic/OpenAI Files API) so the `ArtifactSink`
   * can persist it locally. Optional: adapters without a Files API simply omit it, and the
   * orchestrator marks the file part failed.
   */
  fetchArtifactStream?(
    providerFileId: string,
    ctx: FilesApiContext,
  ): Promise<ProviderArtifact>;

  /**
   * Uploads an input binary to the provider's Files API so it can be mounted into the cloud
   * container (Anthropic `container_upload`, OpenAI `purpose: "responses"`). Optional.
   */
  uploadInputFile?(
    file: InputFileUpload,
    ctx: FilesApiContext,
  ): Promise<UploadedInputFile>;
}
