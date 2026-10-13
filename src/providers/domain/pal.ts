/**
 * Provider Abstraction Layer (PAL) — the single normalized vocabulary shared by the
 * orchestrator, the context builder and every adapter.
 *
 * Pure types only: no I/O, no Drizzle, no provider SDKs, nothing from outside `domain/`.
 * Adapters translate to and from these shapes.
 */

/** A binary the platform has resolved for this request. Bytes are fetched lazily. */
export interface ResolvedFile {
  readonly fileId: string;
  readonly mimeType: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly width?: number;
  readonly height?: number;
  readonly pageCount?: number;
  read(): Promise<Uint8Array>;
  stream(): Promise<ReadableStream<Uint8Array>>;
}

export interface TextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface ImagePart {
  readonly type: 'image';
  readonly file: ResolvedFile;
}

export interface DocumentPart {
  readonly type: 'document';
  readonly file: ResolvedFile;
  readonly extractedText?: string;
  readonly preferNative: boolean;
}

export interface GeneratedFilePart {
  readonly type: 'generated_file';
  readonly file: ResolvedFile;
}

/** Reserved for a future tools feature; adapters must explicitly reject these. */
export interface ToolCallPart {
  readonly type: 'tool_call';
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ToolResultPart {
  readonly type: 'tool_result';
  readonly callId: string;
  readonly content: readonly NormalizedPart[];
  readonly isError?: boolean;
}

export type NormalizedPart =
  | TextPart
  | ImagePart
  | DocumentPart
  | GeneratedFilePart
  | ToolCallPart
  | ToolResultPart;

export interface NormalizedMessage {
  readonly role: 'user' | 'assistant';
  readonly parts: readonly NormalizedPart[];
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly source: 'provider' | 'estimated';
}

/**
 * Adapter output stream. Exactly one terminal event (`finished` or `error`) is emitted
 * per execution.
 */
export type GenerationEvent =
  | { readonly type: 'started'; readonly providerRequestId?: string }
  | {
      readonly type: 'part_started';
      readonly index: number;
      readonly partType: 'text' | 'image' | 'file';
      readonly mimeType?: string;
      readonly name?: string;
    }
  | { readonly type: 'text_delta'; readonly index: number; readonly text: string }
  | { readonly type: 'artifact_chunk'; readonly index: number; readonly bytes: Uint8Array }
  | { readonly type: 'part_done'; readonly index: number }
  | { readonly type: 'progress'; readonly stage: string; readonly percent?: number }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly final: boolean }
  | {
      readonly type: 'finished';
      readonly reason: 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other';
    }
  | { readonly type: 'error'; readonly error: ProviderError };

export type { ProviderError, AppErrorCategory } from './errors.ts';
import type { ProviderError } from './errors.ts';
