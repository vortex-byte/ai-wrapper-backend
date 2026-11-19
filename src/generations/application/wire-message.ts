import type { Message, MessagePart } from '@/conversations/domain/conversation.ts';

/** The persisted message shape returned by the API. */
export interface WireMessage {
  readonly id: string;
  readonly seq: number;
  readonly role: string;
  readonly status: string;
  readonly finishReason: string | null;
  readonly createdAt: string;
  readonly generationId: string | null;
  readonly parts: readonly unknown[];
}

/** Projects a persisted message and its parts into the wire shape. */
export function toWireMessage(
  message: Message,
  parts: readonly MessagePart[],
  generationId: string | null = null,
): WireMessage {
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    status: message.status,
    finishReason: message.finishReason,
    createdAt: message.createdAt.toISOString(),
    generationId,
    parts: parts.map((part) => ({
      id: part.id,
      position: part.position,
      type: part.type,
      format: 'markdown',
      text: part.textContent ?? '',
      ...(part.fileId !== null ? { fileId: part.fileId } : {}),
      ...(part.data && Object.keys(part.data).length > 0 ? { data: part.data } : {}),
    })),
  };
}
