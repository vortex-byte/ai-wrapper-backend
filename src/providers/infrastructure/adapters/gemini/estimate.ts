import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { EstimateResult } from '@/providers/ports/provider-adapter.ts';
import { approximateEstimate } from '../shared.ts';

export function estimateInputTokens(req: NormalizedChatRequest): EstimateResult {
  let textLength = req.system !== undefined ? req.system.length : 0;
  let mediaParts = 0;
  for (const message of req.messages) {
    for (const part of message.parts) {
      if (part.type === 'text') textLength += part.text.length;
      else mediaParts += 1;
    }
  }
  return approximateEstimate(textLength + mediaParts * 1024);
}
