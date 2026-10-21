import { describe, expect, it } from 'vitest';
import { interceptToolCall } from '@/quota/application/tool-interceptor.ts';

/** Tests tool call quota interception before provider billing execution. */
describe('interceptToolCall (pre-execution tool quota gate)', () => {
  it('allows a tariffed tool when remaining quota covers the tariff', () => {
    const verdict = interceptToolCall('image_generation', 3_500);
    expect(verdict.allowed).toBe(true);
    expect(verdict.syntheticToolResult).toBeNull();
    expect(verdict.tariff.tokens).toBe(3_500);
  });

  it('intercepts image generation with insufficient quota and returns a synthetic error', () => {
    const verdict = interceptToolCall('image_generation', 1_200);
    expect(verdict.allowed).toBe(false);
    expect(verdict.syntheticToolResult).toBe(
      'Error: Insufficient token quota for external image generation (diffusion) ' +
        '(requires 3,500 tokens, remaining: 1,200).',
    );
  });

  it('intercepts search grounding below its own (smaller) tariff', () => {
    // 3,000 remaining covers a 3,500-token image but not... wait — it does not; verify
    // the search tariff (500) independently.
    expect(interceptToolCall('web_search', 500).allowed).toBe(true);
    const blocked = interceptToolCall('web_search', 499);
    expect(blocked.allowed).toBe(false);
    expect(blocked.syntheticToolResult).toContain('web search grounding');
    expect(blocked.syntheticToolResult).toContain('requires 500 tokens');
  });

  it('treats null remaining (no account) as zero and blocks tariffed tools', () => {
    const verdict = interceptToolCall('image_generation', null);
    expect(verdict.allowed).toBe(false);
    expect(verdict.syntheticToolResult).toContain('remaining: 0');
  });

  it('allows token-native tools (code execution) unconditionally', () => {
    const verdict = interceptToolCall('code_execution', 0);
    expect(verdict.allowed).toBe(true);
    expect(verdict.syntheticToolResult).toBeNull();
    expect(verdict.tariff.tokens).toBe(0);
  });

  it('allows unknown tools unconditionally (billed via provider usage)', () => {
    expect(interceptToolCall('some_future_tool', 0).allowed).toBe(true);
  });
});
