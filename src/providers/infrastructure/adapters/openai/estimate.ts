import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { EstimateResult } from '@/providers/ports/provider-adapter.ts';
import { approximateEstimate } from '../shared.ts';

let o200kEncoding: Tiktoken | null = null;
let cl100kEncoding: Tiktoken | null = null;

export function getTiktoken(modelId: string): Tiktoken | null {
  try {
    const lower = modelId.toLowerCase();
    const o200kPrefixes = ['gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-6', 'o1', 'o2', 'o3', 'o4', 'chatgpt-4o'];
    if (o200kPrefixes.some((prefix) => lower.startsWith(prefix))) {
      if (!o200kEncoding) o200kEncoding = getEncoding('o200k_base');
      return o200kEncoding;
    }
    if (!cl100kEncoding) cl100kEncoding = getEncoding('cl100k_base');
    return cl100kEncoding;
  } catch {
    return null;
  }
}

export function estimateInputTokens(req: NormalizedChatRequest): EstimateResult {
  const enc = getTiktoken(req.model.apiModelId);
  if (!enc) {
    const textLength = req.messages.reduce(
      (total, message) =>
        total +
        message.parts.reduce(
          (partTotal, part) => (part.type === 'text' ? partTotal + part.text.length : partTotal + 256),
          0,
        ),
      req.system ? req.system.length : 0,
    );
    return approximateEstimate(textLength);
  }

  let tokens = 0;
  if (req.system) {
    tokens += enc.encode(req.system).length + 4;
  }
  for (const msg of req.messages) {
    tokens += 3;
    for (const part of msg.parts) {
      if (part.type === 'text') {
        tokens += enc.encode(part.text).length;
      } else {
        tokens += 256;
      }
    }
  }
  tokens += 3;

  return { tokens, confidence: 'exact' };
}
