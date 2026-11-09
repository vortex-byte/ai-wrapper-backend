import type { TokenUsage } from '@/providers/domain/pal.ts';
import type { RawResponsesUsage } from '../types.ts';

export function responsesUsage(usage: RawResponsesUsage | null | undefined): TokenUsage | undefined {
  if (usage === null || usage === undefined) return undefined;
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
    source: 'provider',
  };
}
