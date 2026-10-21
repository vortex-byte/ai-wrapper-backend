/**
 * SSE Event types and wire shapes for generation streaming.
 */

export type SSEEventType =
  | 'generation.state'
  | 'message.created'
  | 'context.truncated'
  | 'part.started'
  | 'text.delta'
  | 'part.completed'
  | 'progress'
  | 'tool.started'
  | 'tool.delta'
  | 'tool.completed'
  | 'usage.updated'
  | 'generation.completed'
  | 'generation.cancelled'
  | 'generation.failed';

export interface GenerationStatePayload {
  readonly state: 'pending' | 'generating' | 'completed' | 'cancelled' | 'failed';
}

export interface MessageCreatedPayload {
  readonly userMessageId: string;
  readonly assistantMessageId: string;
}

export interface ContextTruncatedPayload {
  readonly droppedMessages: number;
  readonly droppedAttachments?: number;
}

export interface PartStartedPayload {
  readonly partId: string;
  readonly position: number;
  readonly type: 'text' | 'image' | 'file';
  readonly mimeType?: string;
  readonly name?: string;
}

export interface TextDeltaPayload {
  readonly partId: string;
  readonly delta: string;
}

export interface PartCompletedPayload {
  readonly partId: string;
  readonly status: 'complete' | 'incomplete' | 'failed';
  readonly fileId?: string;
  readonly downloadUrl?: string;
}

export interface ProgressPayload {
  readonly stage: string;
  readonly percent?: number;
}

/** Tool activity payload correlating started, delta, and completion events. */
export interface ToolStartedPayload {
  readonly partId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly command?: string;
}

export interface ToolDeltaPayload {
  readonly partId: string;
  readonly toolCallId: string;
  readonly delta: string;
}

export interface ToolCompletedPayload {
  readonly partId: string;
  readonly toolCallId: string;
  readonly status: 'success' | 'error' | 'interrupted';
  readonly durationMs?: number;
}

export interface UsageUpdatedPayload {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface GenerationCompletedPayload {
  readonly finishReason: 'stop' | 'length' | 'content_filter' | 'cancelled' | 'error' | 'timeout' | 'interrupted';
  readonly usage: {
    readonly input: number;
    readonly output: number;
    readonly quotaTokens: number;
  };
  readonly remainingQuota: number | null;
}

export interface GenerationCancelledPayload {
  readonly reason: 'user_cancel' | 'detached' | 'shutdown' | string;
}

export interface GenerationFailedPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  };
}

export interface SSEFrame {
  readonly id: number;
  readonly event: SSEEventType;
  readonly data: string;
  readonly byteLength: number;
  /**
   * When true, this is an SSE comment keep-alive (`:heartbeat`) rather than a named event.
   */
  readonly comment?: boolean | undefined;
}

export function formatSSE(frame: SSEFrame): string {
  if (frame.comment === true) return formatHeartbeat();
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${frame.data}\n\n`;
}

export function formatHeartbeat(): string {
  return ':heartbeat\n\n';
}
