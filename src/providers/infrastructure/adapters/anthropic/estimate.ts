import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { EstimateResult } from '@/providers/ports/provider-adapter.ts';
import { approximateEstimate } from '../shared.ts';

let encoder: Tiktoken | null = null;

const PER_MESSAGE_OVERHEAD = 4;
const REPLY_PRIMING = 3;
const PER_MEDIA_PART_ALLOWANCE = 256;

export function getEncoder(): Tiktoken | null {
  try {
    if (!encoder) encoder = new Tiktoken(o200k_base);
    return encoder;
  } catch {
    return null;
  }
}

export function countClaudeTokens(text: string): number {
  const enc = getEncoder();
  if (enc === null) return Math.ceil(text.length / 4);
  return enc.encode(text).length;
}

export function estimateInputTokens(req: NormalizedChatRequest): EstimateResult {
  const enc = getEncoder();
  if (!enc) {
    const textLength = req.messages.reduce(
      (total, message) =>
        total +
        message.parts.reduce(
          (partTotal, part) =>
            part.type === 'text' ? partTotal + part.text.length : partTotal + PER_MEDIA_PART_ALLOWANCE,
          0,
        ),
      req.system ? req.system.length : 0,
    );
    return approximateEstimate(textLength);
  }

  let tokens = 0;
  if (req.system) {
    tokens += enc.encode(req.system).length + PER_MESSAGE_OVERHEAD;
  }
  for (const message of req.messages) {
    tokens += PER_MESSAGE_OVERHEAD;
    for (const part of message.parts) {
      if (part.type === 'text') {
        tokens += enc.encode(part.text).length;
      } else {
        tokens += PER_MEDIA_PART_ALLOWANCE;
      }
    }
  }
  tokens += REPLY_PRIMING;

  return { tokens, confidence: 'approx' };
}
