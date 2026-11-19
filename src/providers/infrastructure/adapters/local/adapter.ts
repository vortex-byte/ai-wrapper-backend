import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import { LOCAL_ADAPTER_KEY } from '@/providers/domain/local-model.ts';
import type {
  EstimateResult,
  ExecuteContext,
  HealthCheckContext,
  HealthCheckResult,
  ProviderAdapter,
  ProviderModelInfo,
} from '@/providers/ports/provider-adapter.ts';

/**
 * Marker adapter for browser-executed models. It never performs network calls: the SPA
 * runs the model with WebLLM, and the server only stores the finished turns.
 */
export class LocalAdapter implements ProviderAdapter {
  readonly adapterKey = LOCAL_ADAPTER_KEY;

  toProviderRequest(_req: NormalizedChatRequest): unknown {
    return {};
  }

  async estimateInputTokens(_req: NormalizedChatRequest): Promise<EstimateResult> {
    return { tokens: 0, confidence: 'exact' };
  }

  async *execute(
    _req: NormalizedChatRequest,
    _ctx: ExecuteContext,
  ): AsyncIterable<GenerationEvent> {
    yield {
      type: 'error',
      error: providerError(
        'unsupported_for_model',
        'This model runs in the browser and cannot be executed on the server.',
        { retryable: false },
      ),
    };
  }

  translateError(_err: unknown): ProviderError {
    return providerError(
      'unsupported_for_model',
      'This model runs in the browser and cannot be executed on the server.',
      { retryable: false },
    );
  }

  async healthCheck(_ctx: HealthCheckContext): Promise<HealthCheckResult> {
    return { ok: true, latencyMs: 0, detail: 'Runs in the browser' };
  }

  async listModels(_ctx: HealthCheckContext): Promise<readonly ProviderModelInfo[]> {
    return [];
  }
}
