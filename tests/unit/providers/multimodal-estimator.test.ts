import { describe, expect, it } from 'vitest';
import {
  estimateAnthropicImageTokens,
  estimateDocumentTokens,
  estimateOpenAIImageTokens,
  hasMediaParts,
} from '@/providers/infrastructure/adapters/multimodal-estimator.ts';

describe('multimodal token estimator', () => {
  it('estimates OpenAI image tokens for low detail', () => {
    expect(estimateOpenAIImageTokens(1024, 1024, 'low').tokens).toBe(85);
  });

  it('safely falls back on zero, negative, or invalid image dimensions', () => {
    expect(estimateOpenAIImageTokens(0, 0).tokens).toBe(85);
    expect(estimateOpenAIImageTokens(-100, 500).tokens).toBe(85);
    expect(estimateOpenAIImageTokens(Number.NaN, 500).tokens).toBe(85);
    expect(estimateOpenAIImageTokens(Infinity, 500).tokens).toBe(85);

    expect(estimateAnthropicImageTokens(0, 0).tokens).toBe(85);
    expect(estimateAnthropicImageTokens(-50, 100).tokens).toBe(85);
    expect(estimateAnthropicImageTokens(Number.NaN, 100).tokens).toBe(85);
  });

  it('computes OpenAI high-detail tile tokens for valid dimensions', () => {
    const estimate = estimateOpenAIImageTokens(1024, 1024, 'high');
    expect(estimate.tokens).toBeGreaterThan(85);
    expect(Number.isFinite(estimate.tokens)).toBe(true);
  });

  it('computes Anthropic image tokens for valid dimensions', () => {
    const estimate = estimateAnthropicImageTokens(1500, 1000);
    expect(estimate.tokens).toBe(Math.ceil((1500 * 1000) / 750));
  });

  it('computes document tokens by page count or bytes', () => {
    expect(estimateDocumentTokens({ pageCount: 3 }).tokens).toBe(3 * 1600);
    expect(estimateDocumentTokens({ sizeBytes: 10_000 }).tokens).toBe(5);
    expect(estimateDocumentTokens({})).toEqual({ tokens: 1600 });
  });

  it('detects media parts in part list', () => {
    expect(hasMediaParts([{ type: 'text' }])).toBe(false);
    expect(hasMediaParts([{ type: 'text' }, { type: 'image' }])).toBe(true);
  });
});
