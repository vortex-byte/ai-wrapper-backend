export type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other';

export interface GeminiResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface GeminiHttpRequest {
  readonly url: string;
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | FormData | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type GeminiTransport = (request: GeminiHttpRequest) => Promise<GeminiResponseLike>;

export type GeminiClientFactory = (options: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}) => GeminiTransport;

export interface RawGeminiInlineData {
  readonly mimeType?: string;
  readonly data?: string;
}

export interface RawGeminiFileData {
  readonly mimeType?: string;
  readonly fileUri?: string;
}

export interface RawGeminiPart {
  readonly text?: string;
  readonly inlineData?: RawGeminiInlineData;
  readonly fileData?: RawGeminiFileData;
  readonly functionCall?: { readonly name?: string; readonly args?: unknown };
  readonly functionResponse?: { readonly name?: string; readonly response?: unknown };
  readonly executableCode?: { readonly language?: string; readonly code?: string };
  readonly codeExecutionResult?: { readonly outcome?: string; readonly output?: string };
  readonly thought?: boolean;
}

export interface RawGeminiUsage {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
  readonly cachedContentTokenCount?: number;
  readonly thoughtsTokenCount?: number;
}

export interface RawGeminiCandidate {
  readonly content?: { readonly parts?: readonly RawGeminiPart[]; readonly role?: string };
  readonly finishReason?: string;
  readonly index?: number;
}

export interface RawGeminiChunk {
  readonly candidates?: readonly RawGeminiCandidate[];
  readonly usageMetadata?: RawGeminiUsage;
  readonly promptFeedback?: { readonly blockReason?: string };
  readonly error?: unknown;
}

export interface TranslatedMeta {
  readonly internalMessage?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly providerStatus?: number;
  readonly providerCode?: string;
}

export interface GeminiErrorShape {
  readonly status?: number;
  readonly statusText?: string;
  readonly message?: string;
  readonly retryAfterMs?: number;
  readonly error?: { readonly code?: number; readonly status?: string; readonly message?: string };
}

export interface InlineArtifact {
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
}
