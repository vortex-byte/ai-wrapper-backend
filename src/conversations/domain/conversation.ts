export interface Conversation {
  readonly id: string;
  readonly userId: string;
  readonly modelId: string;
  readonly title: string;
  readonly messageCount: number;
  readonly lastMessageAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'complete' | 'incomplete' | 'failed';
export type FinishReason =
  'stop' | 'length' | 'content_filter' | 'cancelled' | 'error' | 'timeout' | 'interrupted';

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly status: MessageStatus;
  readonly finishReason: FinishReason | null;
  readonly supersededBy: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export type PartType =
  | 'text'
  | 'image'
  | 'document'
  | 'generated_file'
  | 'structured'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning';

export type PartStatus = 'streaming' | 'complete' | 'incomplete' | 'failed';

export interface MessagePart {
  readonly id: string;
  readonly messageId: string;
  readonly position: number;
  readonly type: PartType;
  readonly status: PartStatus;
  readonly textContent: string | null;
  readonly data: Readonly<Record<string, unknown>>;
  readonly fileId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A message with its ordered parts — the unit the read API and context builder consume. */
export interface MessageWithParts {
  readonly message: Message;
  readonly parts: readonly MessagePart[];
}

export const MAX_TITLE_LENGTH = 200;
const DEFAULT_TITLE = 'New conversation';

/** Derives conversation title from first user message text, collapsing whitespace. */
export function deriveTitleFromText(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return DEFAULT_TITLE;
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

export const DEFAULT_CONVERSATION_TITLE = DEFAULT_TITLE;
