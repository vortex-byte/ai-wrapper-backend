import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
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
  requireApiKey,
} from '../shared.ts';
import {
  authHeaders,
  buildTransport,
  defaultFactory,
  modelsUrl,
} from './client.ts';
import { translateError } from './errors.ts';
import { estimateInputTokens } from './estimate.ts';
import { fetchArtifactStream, uploadInputFile } from './files.ts';
import { toProviderRequest } from './request.ts';
import { executeStream } from './stream.ts';
import type { GeminiClientFactory } from './types.ts';

export type {
  GeminiClientFactory,
  GeminiHttpRequest,
  GeminiResponseLike,
  GeminiTransport,
} from './types.ts';
export { defaultFactory } from './client.ts';

export class GeminiAdapter implements ProviderAdapter {
  readonly adapterKey = 'gemini';

  constructor(private readonly clientFactory: GeminiClientFactory = defaultFactory) {}

  toProviderRequest(req: NormalizedChatRequest): unknown {
    return toProviderRequest(req);
  }

  estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult> {
    return Promise.resolve(estimateInputTokens(req));
  }

  async *execute(req: NormalizedChatRequest, ctx: ExecuteContext): AsyncIterable<GenerationEvent> {
    const apiKey = req.provider.secrets['apiKey'];
    if (apiKey === undefined || apiKey === '') {
      yield {
        type: 'error',
        error: providerError('provider_unavailable', 'Google Gemini API key is not configured.', {
          retryable: false,
        }),
      };
      return;
    }

    const transport = buildTransport(this.clientFactory, req.provider, apiKey);
    yield* executeStream(req, ctx, transport, apiKey);
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
      const transport = buildTransport(this.clientFactory, provider, apiKey);
      const response = await transport({
        url: modelsUrl(provider),
        method: 'GET',
        headers: authHeaders(apiKey),
        signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          detail: `models.list failed (${response.status})`,
        };
      }
      const payload = (await response.json()) as { models?: readonly unknown[] };
      const count = Array.isArray(payload.models) ? payload.models.length : 0;
      return { ok: true, latencyMs: Date.now() - startedAt, detail: `models.list ok (${count})` };
    } catch (error) {
      return healthFailed(error, Date.now() - startedAt);
    }
  }

  async fetchArtifactStream(
    providerFileId: string,
    ctx: FilesApiContext,
  ): Promise<ProviderArtifact> {
    return fetchArtifactStream(providerFileId, ctx, this.clientFactory);
  }

  async uploadInputFile(file: InputFileUpload, ctx: FilesApiContext): Promise<UploadedInputFile> {
    return uploadInputFile(file, ctx, this.clientFactory);
  }

  async listModels(ctx: HealthCheckContext): Promise<readonly ProviderModelInfo[]> {
    const { provider, signal } = ctx;
    const apiKey = requireApiKey(provider.secrets);
    const transport = buildTransport(this.clientFactory, provider, apiKey);
    const response = await transport({
      url: `${modelsUrl(provider)}?pageSize=1000`,
      method: 'GET',
      headers: authHeaders(apiKey),
      signal,
    });
    if (!response.ok) {
      throw new Error(`models.list failed (${response.status})`);
    }
    const payload = (await response.json()) as {
      models?: readonly { name?: unknown; createTime?: unknown }[];
    };
    const models = Array.isArray(payload.models) ? payload.models : [];
    return models
      .map((model) => {
        const name = typeof model.name === 'string' ? model.name.replace(/^models\//, '') : '';
        const createdAt = typeof model.createTime === 'string' ? model.createTime : undefined;
        return { id: name, ...(createdAt === undefined ? {} : { createdAt }) };
      })
      .filter((model) => model.id !== '' && isChatCapableModelId(model.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
