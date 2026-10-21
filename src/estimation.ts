/** Deterministic token estimation from character count, for context budgeting and pre-flight checks. */

const CHARS_PER_TOKEN = 4;
const PER_MESSAGE_OVERHEAD = 8;

export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(text: string): number {
  return estimateTextTokens(text) + PER_MESSAGE_OVERHEAD;
}

export function estimateMediaTokens(part: {
  readonly type: string;
  readonly extractedText?: string | undefined;
  readonly metadata?: { readonly width?: number; readonly height?: number; readonly pageCount?: number } | undefined;
}): number {
  if (part.type === 'document') {
    if (part.extractedText) return estimateTextTokens(part.extractedText);
    const pages = part.metadata?.pageCount ?? 1;
    return pages * 1600;
  }
  if (part.type === 'image') {
    const w = part.metadata?.width ?? 1024;
    const h = part.metadata?.height ?? 1024;
    const tilesX = Math.ceil(Math.min(w, 2048) / 512);
    const tilesY = Math.ceil(Math.min(h, 2048) / 512);
    return 85 + tilesX * tilesY * 170;
  }
  return 100;
}

/** Estimates input token budget for system prompt and message texts before provider execution. */
export function estimateRequestTokens(
  system: string | undefined,
  messageTexts: readonly string[],
): number {
  let total = system ? estimateTextTokens(system) : 0;
  for (const text of messageTexts) total += estimateMessageTokens(text);
  return total;
}
