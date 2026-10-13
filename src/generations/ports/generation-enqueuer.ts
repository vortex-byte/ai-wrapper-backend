import type { GenerationRecord } from './generation-repository.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';

export interface EnqueueGenerationInput {
  readonly generation: GenerationRecord;
  readonly userMessageId: string;
  readonly assistantMessageId: string;
  readonly chatRequest: NormalizedChatRequest;
  readonly contextInfo: {
    readonly truncated: boolean;
    readonly droppedMessageCount?: number | undefined;
  };
}

export interface GenerationEnqueuer {
  enqueue(input: EnqueueGenerationInput): void;
  readonly isDraining?: boolean;
}
