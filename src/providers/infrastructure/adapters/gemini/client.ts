import type { ProviderRuntimeConfig } from '@/providers/domain/capabilities.ts';
import { numberFromConfig } from '../shared.ts';
import { API_VERSION, DEFAULT_BASE_URL } from './config.ts';
import { fileIdFromUri } from './media.ts';
import type {
  GeminiClientFactory,
  GeminiResponseLike,
  GeminiTransport,
} from './types.ts';

export const defaultFactory: GeminiClientFactory = (options) => async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request timed out.', 'TimeoutError')),
    options.timeoutMs,
  );
  const relayAbort = (): void => controller.abort();
  const callerSignal = request.signal;
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', relayAbort, { once: true });
  }
  try {
    const res = (await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: controller.signal,
    })) as GeminiResponseLike;
    return res;
  } catch (err) {
    callerSignal?.removeEventListener('abort', relayAbort);
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

export function apiBase(provider: ProviderRuntimeConfig): string {
  return provider.baseUrl !== undefined && provider.baseUrl !== ''
    ? provider.baseUrl.replace(/\/$/, '')
    : DEFAULT_BASE_URL;
}

export function streamUrl(provider: ProviderRuntimeConfig, apiModelId: string): string {
  const model = apiModelId.replace(/^models\//, '');
  return `${apiBase(provider)}/${API_VERSION}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
}

export function modelsUrl(provider: ProviderRuntimeConfig): string {
  return `${apiBase(provider)}/${API_VERSION}/models`;
}

export function fileDownloadUrl(provider: ProviderRuntimeConfig, providerFileId: string): string {
  const id = fileIdFromUri(providerFileId);
  return `${apiBase(provider)}/${API_VERSION}/files/${encodeURIComponent(id)}?alt=media`;
}

export function filesUploadUrl(provider: ProviderRuntimeConfig): string {
  return `${apiBase(provider)}/${API_VERSION}/files`;
}

export function jsonHeaders(apiKey: string): Record<string, string> {
  return { 'x-goog-api-key': apiKey, 'content-type': 'application/json' };
}

export function authHeaders(apiKey: string): Record<string, string> {
  return { 'x-goog-api-key': apiKey };
}

export function buildTransport(
  clientFactory: GeminiClientFactory,
  provider: ProviderRuntimeConfig,
  apiKey: string,
): GeminiTransport {
  return clientFactory({
    apiKey,
    baseUrl: apiBase(provider),
    timeoutMs: numberFromConfig(provider.config, 'timeoutMs', 60_000),
  });
}
