import type { TokenUsage } from '@/providers/domain/pal.ts';
import type { RawGeminiUsage } from './types.ts';

export function usageFrom(meta: RawGeminiUsage): TokenUsage {
  const cached = meta.cachedContentTokenCount;
  const thoughts = meta.thoughtsTokenCount;
  return {
    inputTokens: typeof meta.promptTokenCount === 'number' ? meta.promptTokenCount : 0,
    outputTokens: typeof meta.candidatesTokenCount === 'number' ? meta.candidatesTokenCount : 0,
    ...(typeof cached === 'number' && cached > 0 ? { cachedInputTokens: cached } : {}),
    ...(typeof thoughts === 'number' && thoughts > 0 ? { reasoningTokens: thoughts } : {}),
    source: 'provider',
  };
}
