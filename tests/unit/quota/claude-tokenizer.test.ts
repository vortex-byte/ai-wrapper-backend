import { describe, expect, it } from 'vitest';
import {
  countClaudeTokens,
  estimateInputTokens,
} from '@/providers/infrastructure/adapters/anthropic/estimate.ts';
import { makeChatRequest } from '@/providers/infrastructure/fake/fake-provider.ts';

describe('claude tokenizer (local o200k BPE approximation)', () => {
  it('counts tokens deterministically for plain text', () => {
    const a = countClaudeTokens('The quick brown fox jumps over the lazy dog.');
    const b = countClaudeTokens('The quick brown fox jumps over the lazy dog.');
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(5);
    expect(a).toBeLessThan(30);
  });

  it('is sub-linear on repeated content (BPE merges across boundaries)', () => {
    const one = countClaudeTokens('hello world ');
    const many = countClaudeTokens('hello world '.repeat(10));
    expect(many).toBeGreaterThan(one);
    expect(many).toBeLessThan(one * 10);
  });

  it('handles unicode without crashing and stays positive', () => {
    const tokens = countClaudeTokens('こんにちは世界 🌍 émojis & 中文文本');
    expect(tokens).toBeGreaterThan(0);
  });

  it('returns 0 for empty input', () => {
    expect(countClaudeTokens('')).toBe(0);
  });

  it('estimateInputTokens adds per-message overhead and reply priming', () => {
    const estimate = estimateInputTokens(
      makeChatRequest({
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', parts: [{ type: 'text', text: 'there' }] },
        ],
      }),
    );
    const raw = countClaudeTokens('hi') + countClaudeTokens('there');
    expect(estimate.tokens).toBe(raw + 8 + 3);
    expect(estimate.confidence).toBe('approx');
  });

  it('counts media parts with a flat allowance', () => {
    const estimate = estimateInputTokens(
      makeChatRequest({
        messages: [
          {
            role: 'user',
            parts: [
              {
                type: 'image',
                file: {
                  fileId: 'f-1',
                  name: 'img.png',
                  mimeType: 'image/png',
                  sizeBytes: 10,
                  read: () => Promise.resolve(new Uint8Array()),
                  stream: () => Promise.resolve(new ReadableStream()),
                },
              },
              { type: 'text', text: 'describe this' },
            ],
          },
        ],
      }),
    );
    const text = countClaudeTokens('describe this');
    expect(estimate.tokens).toBe(text + 4 + 256 + 3);
  });
});
