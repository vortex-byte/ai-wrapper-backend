/**
 * Deterministic token estimation heuristic based on character count.
 * Used for context budgeting and pre-flight checks.
 */

const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 8;

export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Estimate a whole message: its text plus a fixed per-message overhead. */
export function estimateMessageTokens(text: string): number {
  return estimateTextTokens(text) + PER_MESSAGE_OVERHEAD;
}

/**
 * Estimate the input budget a set of message texts will consume, including the system
 * instructions. Used before a provider call; the provider's `usage` event is authoritative.
 */
export function estimateRequestTokens(system: string | undefined, messageTexts: readonly string[]): number {
  let total = system ? estimateTextTokens(system) : 0;
  for (const text of messageTexts) total += estimateMessageTokens(text);
  return total;
}
