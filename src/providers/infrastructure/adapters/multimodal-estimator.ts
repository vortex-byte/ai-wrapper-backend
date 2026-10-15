const OPENAI_LOW_DETAIL = 85;
const OPENAI_TILE_TOKENS = 170;
const OPENAI_TILE_SIZE = 512;
const OPENAI_MAX_DIM = 2048;
const OPENAI_MIN_SHORTEST_SIDE = 768;

const ANTHROPIC_PIXELS_PER_TOKEN = 750;

const DOCUMENT_PAGE_TOKENS = 1600;

export interface MediaEstimate {
  readonly tokens: number;
}

export function estimateOpenAIImageTokens(
  width: number,
  height: number,
  detail: 'low' | 'high' = 'high',
): MediaEstimate {
  if (detail === 'low' || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { tokens: OPENAI_LOW_DETAIL };
  }

  const scale = Math.min(1, OPENAI_MAX_DIM / Math.max(width, height));
  let w = Math.ceil(width * scale);
  let h = Math.ceil(height * scale);

  if (Math.min(w, h) < OPENAI_MIN_SHORTEST_SIDE) {
    const upscale = OPENAI_MIN_SHORTEST_SIDE / Math.min(w, h);
    w = Math.ceil(w * upscale);
    h = Math.ceil(h * upscale);
  }

  const tilesX = Math.ceil(w / OPENAI_TILE_SIZE);
  const tilesY = Math.ceil(h / OPENAI_TILE_SIZE);
  return { tokens: OPENAI_LOW_DETAIL + OPENAI_TILE_TOKENS * tilesX * tilesY };
}

export function estimateAnthropicImageTokens(width: number, height: number): MediaEstimate {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { tokens: OPENAI_LOW_DETAIL };
  }
  return { tokens: Math.ceil((width * height) / ANTHROPIC_PIXELS_PER_TOKEN) };
}

export function estimateDocumentTokens(input: {
  readonly pageCount?: number | undefined;
  readonly sizeBytes?: number | undefined;
}): MediaEstimate {
  if (input.pageCount !== undefined && Number.isFinite(input.pageCount) && input.pageCount > 0) {
    return { tokens: Math.ceil(input.pageCount * DOCUMENT_PAGE_TOKENS) };
  }
  if (input.sizeBytes !== undefined && Number.isFinite(input.sizeBytes) && input.sizeBytes > 0) {
    return { tokens: Math.ceil(input.sizeBytes / 2000) };
  }
  return { tokens: DOCUMENT_PAGE_TOKENS };
}

export function hasMediaParts(parts: readonly { readonly type: string }[]): boolean {
  return parts.some((part) => part.type !== 'text');
}
