import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import type {
  EstimateResult,
  ExecuteContext,
  FilesApiContext,
  HealthCheckContext,
  HealthCheckResult,
  ProviderAdapter,
  ProviderArtifact,
  ProviderModelInfo,
} from '@/providers/ports/provider-adapter.ts';
import {
  healthFailed,
  healthNotConfigured,
  isChatCapableModelId,
  isModelsEndpointMissing,
  listProviderModels,
  requireApiKey,
} from '../shared.ts';
import { buildClient, defaultFactory } from './client.ts';
import { translateError } from './errors.ts';
import { estimateInputTokens } from './estimate.ts';
import { resolveDialect } from '@/providers/domain/dialect.ts';
import { fetchArtifactStream, deleteProviderFile } from './files.ts';
import { resolveMediaBlocks } from './media.ts';
import { buildMessages, toProviderRequest } from './request.ts';
import { executeStream } from './stream.ts';
import type {
  AnthropicClientFactory,
  OutgoingMessage,
} from './types.ts';

export type { AnthropicClientFactory, AnthropicClientLike } from './types.ts';
export { defaultFactory } from './client.ts';
export { isModernEffortModel } from './config.ts';

export class AnthropicAdapter implements ProviderAdapter {
  readonly adapterKey = 'anthropic';

  constructor(private readonly clientFactory: AnthropicClientFactory = defaultFactory) {}

  toProviderRequest(req: NormalizedChatRequest, messages?: OutgoingMessage[]): unknown {
    return toProviderRequest(req, messages);
  }

  estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult> {
    return Promise.resolve(estimateInputTokens(req));
  }

  async *execute(req: NormalizedChatRequest, ctx: ExecuteContext): AsyncIterable<GenerationEvent> {
    const apiKey = req.provider.secrets['apiKey'];
    if (!apiKey) {
      yield {
        type: 'error',
        error: providerError('provider_unavailable', 'Anthropic API key is not configured.', {
          retryable: false,
        }),
      };
      return;
    }

    const client = buildClient(this.clientFactory, req.provider, apiKey);

    let baseMessages: OutgoingMessage[];
    try {
      baseMessages = buildMessages(req, await resolveMediaBlocks(req));
    } catch (err) {
      yield { type: 'error', error: translateError(err) };
      return;
    }

    const baseParams = toProviderRequest(req, baseMessages) as Record<string, unknown>;
    yield* executeStream(req, ctx, client, baseMessages, baseParams);
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
      const client = buildClient(this.clientFactory, provider, apiKey);
      const result = await client.models.list(undefined, { signal });
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        detail: `models.list ok (${result.data.length})`,
      };
    } catch (error) {
      if (isModelsEndpointMissing(error)) {
        return {
          ok: true,
          latencyMs: Date.now() - startedAt,
          detail: 'models endpoint unavailable; add models manually',
        };
      }
      return healthFailed(error, Date.now() - startedAt);
    }
  }

  async listModels(ctx: HealthCheckContext): Promise<readonly ProviderModelInfo[]> {
    const { provider, signal } = ctx;
    if (!resolveDialect(provider).modelCatalogue) {
      throw new Error('model_catalogue_unavailable');
    }
    const client = buildClient(this.clientFactory, provider, requireApiKey(provider.secrets));
    const models = await listProviderModels(() => client.models.list(undefined, { signal }));
    return models
      .map((model) => ({ id: model.id }))
      .filter((model) => isChatCapableModelId(model.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async fetchArtifactStream(
    providerFileId: string,
    ctx: FilesApiContext,
  ): Promise<ProviderArtifact> {
    if (!resolveDialect(ctx.provider).files.download) {
      throw providerError('provider_unavailable', 'This provider has no artifact download API.', {
        retryable: false,
      });
    }
    return fetchArtifactStream(providerFileId, ctx);
  }

  async deleteProviderFile(providerFileId: string, ctx: FilesApiContext): Promise<void> {
    if (!resolveDialect(ctx.provider).files.delete) return;
    return deleteProviderFile(providerFileId, ctx);
  }
}
