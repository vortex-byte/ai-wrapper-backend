import type { TokenUsage } from '@/providers/domain/pal.ts';

export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other';

export interface RawOpenAIChunk {
  readonly id?: string;
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly refusal?: string | null;
      readonly role?: string;
    };
    readonly finish_reason?: string | null;
    readonly index?: number;
  }[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens?: number;
    readonly prompt_tokens_details?: {
      readonly cached_tokens?: number;
    };
    readonly completion_tokens_details?: {
      readonly reasoning_tokens?: number;
    };
  } | null;
}

export interface RawResponsesItem {
  readonly id?: string;
  readonly type?: string;
  readonly status?: string;
  readonly call_id?: string;
  readonly container_id?: string;
  readonly code?: string | null;
  readonly action?: { readonly commands?: readonly string[] };
  readonly environment?: { readonly type?: string; readonly container_id?: string } | null;
  readonly outputs?:
    readonly { readonly type?: string; readonly logs?: string; readonly url?: string }[] | null;
  readonly result?: string | null;
  readonly revised_prompt?: string | null;
  readonly encrypted_content?: string | null;
}

export interface RawResponsesUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
}

export interface ContainerFileEntry {
  readonly id: string;
  readonly filename: string;
  readonly bytes?: number;
  readonly source?: string;
}

export interface RawResponsesEvent {
  readonly type: string;
  readonly delta?: string;
  readonly item?: RawResponsesItem;
  readonly item_id?: string;
  readonly output_index?: number;
  /** `image_generation_call.partial_image` only: progressive previews as base64. */
  readonly partial_image_index?: number;
  readonly partial_image_b64?: string;
  readonly annotation?: {
    readonly type?: string;
    readonly container_id?: string;
    readonly file_id?: string;
    readonly filename?: string;
  } | null;
  readonly response?: {
    readonly id?: string;
    readonly status?: string;
    readonly incomplete_details?: { readonly reason?: string } | null;
    readonly error?: {
      readonly code?: string;
      readonly type?: string;
      readonly message?: string;
    } | null;
    readonly output?: readonly RawResponsesItem[];
    readonly usage?: RawResponsesUsage | null;
  };
  readonly message?: string;
  readonly code?: string | null;
}

export interface TranslatedMeta {
  readonly internalMessage?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly providerStatus?: number;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
}

export interface ApiErrorShape {
  readonly code?: unknown;
  readonly type?: unknown;
  readonly error?: unknown;
}

export type OpenAIContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }
  | {
      readonly type: 'file';
      readonly file: { readonly file_data: string; readonly filename?: string };
    };

export interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[];
}

export interface ExecutionState {
  started: boolean;
  textPartStarted: boolean;
  readonly containerIds: Set<string>;
  readonly emitted: Set<string>;
  readonly emittedPartials: Set<string>;
  readonly startedTools: Set<string>;
  readonly completedTools: Set<string>;
  imageCount: number;
  usage: TokenUsage | undefined;
  finishReason: FinishReason;
}
