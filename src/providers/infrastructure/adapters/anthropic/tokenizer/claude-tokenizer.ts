/**
 * Local Claude tokenizer approximation using o200k_base BPE ranks via js-tiktoken.
 */

import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';

let encoder: Tiktoken | null = null;

/** Lazily initialised shared o200k encoder (ranks are ~2 MB; load once per process). */
function getEncoder(): Tiktoken | null {
  try {
    if (!encoder) encoder = new Tiktoken(o200k_base);
    return encoder;
  } catch {
    return null;
  }
}

/** Claude message framing overhead: role/name delimiters per message (~4 tokens). */
const PER_MESSAGE_OVERHEAD = 4;
/** Assistant reply priming tokens. */
const REPLY_PRIMING = 3;
/** Allowance per media part for rough estimation. */
const PER_MEDIA_PART_ALLOWANCE = 256;

export interface ClaudeEstimate {
  readonly tokens: number;
  readonly confidence: 'approx';
}

/** Count tokens for one text chunk (pure; no I/O). Falls back to chars/4 if ranks fail to load. */
export function countClaudeTokens(text: string): number {
  const enc = getEncoder();
  if (enc === null) return Math.ceil(text.length / 4);
  return enc.encode(text).length;
}

export function estimateClaudeInputTokens(input: {
  readonly system?: string | undefined;
  readonly messages: readonly {
    readonly parts: readonly { readonly type: string; readonly text?: string }[];
  }[];
}): ClaudeEstimate {
  const enc = getEncoder();
  if (enc === null) {
    const textLength =
      input.messages.reduce(
        (total, message) =>
          total +
          message.parts.reduce(
            (partTotal, part) => (part.type === 'text' ? partTotal + (part.text?.length ?? 0) : partTotal + PER_MEDIA_PART_ALLOWANCE),
            0,
          ),
        input.system?.length ?? 0,
      ) || 0;
    return { tokens: Math.ceil(textLength / 4) + 8, confidence: 'approx' };
  }

  let tokens = 0;
  if (input.system !== undefined) {
    tokens += enc.encode(input.system).length + PER_MESSAGE_OVERHEAD;
  }
  for (const message of input.messages) {
    tokens += PER_MESSAGE_OVERHEAD;
    for (const part of message.parts) {
      if (part.type === 'text' && part.text !== undefined) {
        tokens += enc.encode(part.text).length;
      } else {
        tokens += PER_MEDIA_PART_ALLOWANCE;
      }
    }
  }
  tokens += REPLY_PRIMING;
  return { tokens, confidence: 'approx' };
}
