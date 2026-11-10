export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other';

export interface AnthropicClientLike {
  models: {
    list(
      params?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<{ data: readonly { id: string }[] }>;
  };
  messages: {
    create(
      params: unknown,
      options?: { signal?: AbortSignal; headers?: Record<string, string> },
    ): Promise<AsyncIterable<unknown>>;
  };
}

export type AnthropicClientFactory = (options: {
  apiKey: string;
  baseURL?: string;
  timeout: number;
  maxRetries: number;
  defaultHeaders?: Record<string, string>;
}) => AnthropicClientLike;

export interface CacheControlEphemeral {
  readonly type: 'ephemeral';
}

export interface TextBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: CacheControlEphemeral;
}

export interface ContainerUploadBlock {
  readonly type: 'container_upload';
  readonly file_id: string;
  readonly cache_control?: CacheControlEphemeral;
}

export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
  readonly cache_control?: CacheControlEphemeral;
}

export interface ImageBlock {
  readonly type: 'image';
  readonly source: { readonly type: 'base64'; readonly media_type: string; readonly data: string };
  readonly cache_control?: CacheControlEphemeral;
}

export interface DocumentBlock {
  readonly type: 'document';
  readonly source: {
    readonly type: 'base64';
    readonly media_type: 'application/pdf';
    readonly data: string;
  };
  readonly cache_control?: CacheControlEphemeral;
}

export interface CompactionBlock {
  readonly type: 'compaction';
  readonly content: string;
  readonly signature?: string;
  readonly cache_control?: CacheControlEphemeral;
}

export type ReplayBlock = { readonly type: string } & Record<string, unknown>;

export type OutgoingBlock =
  | TextBlock
  | ContainerUploadBlock
  | ToolUseBlock
  | ImageBlock
  | DocumentBlock
  | CompactionBlock
  | ReplayBlock;

export interface OutgoingMessage {
  role: 'user' | 'assistant';
  content: string | OutgoingBlock[];
}

export interface RunState {
  readonly openBlocks: Set<number>;
  readonly toolBlocks: Map<number, { toolCallId: string; name: string }>;
  readonly blockTypes: Map<number, string>;
  readonly blockText: Map<number, string>;
  readonly toolInputJson: Map<number, string>;
  readonly turnBlockOrder: number[];
  readonly turnBlocks: Map<number, ReplayBlock>;
  readonly compactionEmittedIndices: Set<number>;
  inputTokens: number;
  outputTokens: number;
  priorTurnsOutputTokens: number;
  iterationOutputTokens: number;
  cachedInputTokens: number | undefined;
  stopReason: string;
}

export interface RawAnthropicStreamEvent {
  readonly type: string;
  readonly index?: number;
  readonly message?: {
    readonly id?: string;
    readonly container?: { readonly id?: string; readonly expires_at?: string };
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_read_input_tokens?: number;
      readonly cache_creation_input_tokens?: number;
      readonly iterations?: readonly {
        readonly type?: string;
        readonly input_tokens?: number;
        readonly output_tokens?: number;
        readonly cache_read_input_tokens?: number;
        readonly cache_creation_input_tokens?: number;
      }[];
    };
  };
  readonly container?: { readonly id?: string; readonly expires_at?: string };
  readonly content_block?: {
    readonly type?: string;
    readonly id?: string;
    readonly name?: string;
    readonly input?: unknown;
    readonly text?: string;
    readonly tool_use_id?: string;
    readonly content?: unknown;
    readonly stdout?: string;
    readonly stderr?: string;
    readonly signature?: string;
  };
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly partial_json?: string;
    readonly thinking?: string;
    readonly signature?: string;
    readonly content?: string | null;
    readonly stop_reason?: string | null;
  };
  readonly usage?: {
    readonly output_tokens?: number;
    readonly iterations?: readonly {
      readonly type?: string;
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_read_input_tokens?: number;
      readonly cache_creation_input_tokens?: number;
    }[];
  };
  readonly error?: {
    readonly type?: string;
    readonly message?: string;
  };
}
