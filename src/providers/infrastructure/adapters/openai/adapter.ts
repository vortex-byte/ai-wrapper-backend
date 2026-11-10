import type {
  NormalizedChatRequest,
  ProviderRuntimeConfig,
} from '@/providers/domain/capabilities.ts';
import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import type {
  EstimateResult,
  ExecuteContext,
  FilesApiContext,
  HealthCheckContext,
  HealthCheckResult,
  InputFileUpload,
  ProviderAdapter,
  ProviderArtifact,
  ProviderModelInfo,
  UploadedInputFile,
} from '@/providers/ports/provider-adapter.ts';
import {
  healthFailed,
  healthNotConfigured,
  isChatCapableModelId,
  numberFromConfig,
  requireApiKey,
} from '../shared.ts';
import {
  apiBase,
  defaultClientFactory,
  requireProviderApiKey,
  type OpenAIClientFactory,
  type OpenAIClientLike,
} from './client.ts';
import { buildMessages, buildRequest } from './chat/request.ts';
import { executeChat, missingApiKey } from './chat/stream.ts';
import { translateError } from './errors.ts';
import { estimateInputTokens } from './estimate.ts';
import { parseContainerFileHandle } from './responses/artifacts.ts';
import { responsesEnabled } from './responses/request.ts';
import { executeResponses } from './responses/stream.ts';

export type { OpenAIClientFactory, OpenAIClientLike } from './client.ts';
export { getTiktoken } from './estimate.ts';
export { mimeFromFilename } from './media.ts';
export {
  artifactEvent,
  containerFileHandle,
  parseContainerFileHandle,
} from './responses/artifacts.ts';

export class OpenAIAdapter implements ProviderAdapter {
  readonly adapterKey = 'openai';

  private readonly clientFactory: OpenAIClientFactory;

  constructor(clientFactory: OpenAIClientFactory = defaultClientFactory()) {
    this.clientFactory = clientFactory;
  }

  toProviderRequest(req: NormalizedChatRequest): unknown {
    return buildRequest(req, buildMessages(req));
  }

  async *execute(req: NormalizedChatRequest, ctx: ExecuteContext): AsyncIterable<GenerationEvent> {
    const apiKey = req.provider.secrets['apiKey'];
    if (!apiKey) {
      yield missingApiKey();
      return;
    }

    const client = this.client(req.provider, apiKey);

    if (responsesEnabled(req)) {
      if (client.responses === undefined) {
        yield {
          type: 'error',
          error: providerError(
            'provider_unavailable',
            'This provider client does not support cloud tools.',
            { retryable: false },
          ),
        };
        return;
      }
      yield* executeResponses(req, ctx, client.responses);
      return;
    }

    yield* executeChat(req, ctx, client);
  }

  estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult> {
    return Promise.resolve(estimateInputTokens(req));
  }

  translateError(err: unknown): ProviderError {
    return translateError(err);
  }

  async healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
    const { provider, signal } = ctx;
    const apiKey = provider.secrets['apiKey'];
    if (apiKey === undefined || apiKey === '') {
      return healthNotConfigured('secret_not_configured');
    }
    const startedAt = Date.now();
    try {
      const client = this.client(provider, apiKey);
      const result = await client.models.list(undefined, { signal });
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        detail: `models.list ok (${result.data.length})`,
      };
    } catch (error) {
      return healthFailed(error, Date.now() - startedAt);
    }
  }

  async listModels(ctx: HealthCheckContext): Promise<readonly ProviderModelInfo[]> {
    const { provider, signal } = ctx;
    const client = this.client(provider, requireApiKey(provider.secrets));
    const result = await client.models.list(undefined, { signal });
    return result.data
      .filter((model) => model.shutdown_date === null || model.shutdown_date === undefined)
      .filter((model) => isChatCapableModelId(model.id))
      .map((model) => ({ id: model.id }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async fetchArtifactStream(
    providerFileId: string,
    ctx: FilesApiContext,
  ): Promise<ProviderArtifact> {
    const apiKey = requireProviderApiKey(ctx.provider);

    const containerFile = parseContainerFileHandle(providerFileId);
    const url =
      containerFile !== null
        ? `${apiBase(ctx.provider)}/containers/${encodeURIComponent(containerFile.containerId)}/files/${encodeURIComponent(containerFile.fileId)}/content`
        : `${apiBase(ctx.provider)}/files/${encodeURIComponent(providerFileId)}/content`;

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ctx.signal,
    });

    if (!response.ok || response.body === null) {
      throw providerError('provider_unavailable', 'Could not download the generated file.', {
        retryable: response.status >= 500 || response.status === 429,
        providerStatus: response.status,
      });
    }

    const contentType = response.headers.get('content-type');
    const contentLength = response.headers.get('content-length');
    const sizeBytes =
      contentLength !== null && Number.isFinite(Number(contentLength))
        ? Number(contentLength)
        : undefined;

    return {
      stream: response.body as ReadableStream<Uint8Array>,
      ...(contentType !== null ? { mimeType: contentType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    };
  }

  async uploadInputFile(file: InputFileUpload, ctx: FilesApiContext): Promise<UploadedInputFile> {
    const apiKey = requireProviderApiKey(ctx.provider);

    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', new Blob([file.bytes], { type: file.mimeType }), file.filename);
    // Without an explicit policy, `user_data` files persist until deleted manually.
    if (ctx.fileRetentionDays !== undefined && ctx.fileRetentionDays > 0) {
      form.append('expires_after[anchor]', 'created_at');
      form.append('expires_after[seconds]', String(ctx.fileRetentionDays * 86_400));
    }

    const response = await fetch(`${apiBase(ctx.provider)}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: ctx.signal,
    });

    if (!response.ok) {
      throw providerError('provider_unavailable', 'Could not upload the input file.', {
        retryable: response.status >= 500 || response.status === 429,
        providerStatus: response.status,
      });
    }

    const payload = (await response.json()) as { id?: unknown };
    if (typeof payload.id !== 'string' || payload.id.length === 0) {
      throw providerError('provider_unavailable', 'The provider did not return a file id.', {
        retryable: true,
      });
    }

    return { providerFileId: payload.id };
  }

  async deleteProviderFile(providerFileId: string, ctx: FilesApiContext): Promise<void> {
    const apiKey = requireProviderApiKey(ctx.provider);

    const containerFile = parseContainerFileHandle(providerFileId);
    const url =
      containerFile !== null
        ? `${apiBase(ctx.provider)}/containers/${encodeURIComponent(containerFile.containerId)}/files/${encodeURIComponent(containerFile.fileId)}`
        : `${apiBase(ctx.provider)}/files/${encodeURIComponent(providerFileId)}`;

    const response = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ctx.signal,
    });

    // Already gone is a success: deletion is idempotent.
    if (!response.ok && response.status !== 404) {
      throw providerError('provider_unavailable', 'Could not delete the provider file.', {
        retryable: response.status >= 500 || response.status === 429,
        providerStatus: response.status,
      });
    }
  }

  private client(provider: ProviderRuntimeConfig, apiKey: string): OpenAIClientLike {
    return this.clientFactory({
      apiKey,
      ...(provider.baseUrl !== undefined ? { baseURL: provider.baseUrl } : {}),
      timeout: numberFromConfig(provider.config, 'timeoutMs', 60_000),
      maxRetries: numberFromConfig(provider.config, 'maxRetries', 1),
    });
  }
}
