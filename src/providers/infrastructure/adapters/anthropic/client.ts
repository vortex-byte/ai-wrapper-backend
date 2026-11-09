import Anthropic from '@anthropic-ai/sdk';
import type {
  NormalizedChatRequest,
  ProviderRuntimeConfig,
} from '@/providers/domain/capabilities.ts';
import { numberFromConfig } from '../shared.ts';
import {
  DEFAULT_ANTHROPIC_VERSION,
  ON_DEMAND_COMPACTION_BETA,
  THRESHOLD_COMPACTION_BETA,
} from './config.ts';
import type { AnthropicClientFactory, AnthropicClientLike } from './types.ts';

export const defaultFactory: AnthropicClientFactory = (options) =>
  new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    timeout: options.timeout,
    maxRetries: options.maxRetries,
    ...(options.defaultHeaders !== undefined ? { defaultHeaders: options.defaultHeaders } : {}),
  });

export function resolveAnthropicVersion(provider: ProviderRuntimeConfig): string {
  const version = provider.config['anthropicVersion'];
  return typeof version === 'string' && version !== '' ? version : DEFAULT_ANTHROPIC_VERSION;
}

export function apiBase(provider: ProviderRuntimeConfig): string {
  return provider.baseUrl !== undefined && provider.baseUrl !== ''
    ? provider.baseUrl.replace(/\/$/, '')
    : 'https://api.anthropic.com';
}

export function buildClient(
  clientFactory: AnthropicClientFactory,
  provider: ProviderRuntimeConfig,
  apiKey: string,
): AnthropicClientLike {
  return clientFactory({
    apiKey,
    ...(provider.baseUrl !== undefined ? { baseURL: provider.baseUrl } : {}),
    timeout: numberFromConfig(provider.config, 'timeoutMs', 60_000),
    maxRetries: numberFromConfig(provider.config, 'maxRetries', 1),
    defaultHeaders: {
      'anthropic-version': resolveAnthropicVersion(provider),
    },
  });
}

export function requestHeaders(
  req: NormalizedChatRequest,
  compactionActive: boolean,
): Record<string, string> {
  const configured = req.provider.config['anthropicBeta'];
  const betas: string[] = Array.isArray(configured)
    ? configured.filter((value): value is string => typeof value === 'string')
    : typeof configured === 'string' && configured !== ''
      ? [configured]
      : [];
  const hasCompactionMessage = req.messages.some((m) =>
    m.parts.some((p) => p.type === 'compaction'),
  );
  if (hasCompactionMessage || compactionActive) {
    if (!betas.includes(ON_DEMAND_COMPACTION_BETA)) {
      betas.push(ON_DEMAND_COMPACTION_BETA);
    }
    if (!betas.includes(THRESHOLD_COMPACTION_BETA)) {
      betas.push(THRESHOLD_COMPACTION_BETA);
    }
  }
  return betas.length > 0 ? { 'anthropic-beta': betas.join(',') } : {};
}

export function filesHeaders(
  provider: ProviderRuntimeConfig,
  apiKey: string,
): Record<string, string> {
  const version = resolveAnthropicVersion(provider);
  const beta = provider.config['anthropicBeta'];
  const betaHeader = Array.isArray(beta)
    ? beta.filter((v): v is string => typeof v === 'string').join(',')
    : typeof beta === 'string'
      ? beta
      : '';
  return {
    'x-api-key': apiKey,
    'anthropic-version': version,
    ...(betaHeader !== '' ? { 'anthropic-beta': betaHeader } : {}),
  };
}
