import OpenAI from 'openai';
import type { ProviderRuntimeConfig } from '@/providers/domain/capabilities.ts';
import { providerError } from '@/providers/domain/errors.ts';
import { parseRetryAfter } from '../shared.ts';

export interface OpenAIClientLike {
  models: {
    list(
      params?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<{ data: readonly { id: string }[] }>;
  };
  chat: {
    completions: {
      create(params: unknown, options?: { signal?: AbortSignal }): Promise<AsyncIterable<unknown>>;
    };
  };
  responses?: {
    create(params: unknown, options?: { signal?: AbortSignal }): Promise<AsyncIterable<unknown>>;
  };
}

export type OpenAIClientFactory = (options: {
  apiKey: string;
  baseURL?: string;
  timeout: number;
  maxRetries: number;
}) => OpenAIClientLike;

const defaultFactory: OpenAIClientFactory = (options) =>
  new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    timeout: options.timeout,
    maxRetries: options.maxRetries,
  });

export function defaultClientFactory(): OpenAIClientFactory {
  return defaultFactory;
}

export function apiBase(provider: ProviderRuntimeConfig): string {
  return provider.baseUrl !== undefined && provider.baseUrl !== ''
    ? provider.baseUrl.replace(/\/$/, '')
    : 'https://api.openai.com/v1';
}

export function parseRetryAfterHeader(headers: unknown): number | undefined {
  if (!headers) return undefined;
  const headerVal =
    typeof (headers as { get?: (k: string) => string | null }).get === 'function'
      ? (headers as { get: (k: string) => string | null }).get('retry-after')
      : (headers as Record<string, string>)['retry-after'];
  return parseRetryAfter(headerVal);
}

export function requireProviderApiKey(provider: ProviderRuntimeConfig): string {
  const apiKey = provider.secrets['apiKey'];
  if (apiKey === undefined || apiKey === '') {
    throw providerError('provider_unavailable', 'OpenAI API key is not configured.', {
      retryable: false,
    });
  }
  return apiKey;
}
