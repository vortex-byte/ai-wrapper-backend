import type {
  NormalizedChatRequest,
  ProviderRuntimeConfig,
} from '@/providers/domain/capabilities.ts';
import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import type {
  GenerationEvent,
  NormalizedPart,
  ResolvedFile,
  TokenUsage,
} from '@/providers/domain/pal.ts';
import type {
  EstimateResult,
  ExecuteContext,
  FilesApiContext,
  HealthCheckContext,
  HealthCheckResult,
  InputFileUpload,
  ProviderAdapter,
  ProviderArtifact,
  UploadedInputFile,
} from '@/providers/ports/provider-adapter.ts';
import {
  approximateEstimate,
  healthFailed,
  healthNotConfigured,
  isAbortLikeError,
  isTimeoutLikeError,
  numberFromConfig,
  parseRetryAfter,
  scrubSecrets,
} from '../shared.ts';

type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other';

/**
 * Google Gemini adapter, spoken over the public REST API.
 *
 * SDK-free on purpose: the whole HTTP layer is injectable, so unit tests script SSE frames
 * without a network or a mock module.
 */

/** Public REST host; `provider.baseUrl` overrides it (proxy or self-hosted gateway). */
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
/** `v1beta` is the version exposing `tools.googleSearch` and `tools.codeExecution`. */
const API_VERSION = 'v1beta';
/** Gemini rejects oversized inline parts; 15 MB leaves headroom for the base64 wrapper. */
const MAX_INLINE_BYTES = 15 * 1024 * 1024;
/**
 * Inline (in-band base64) generated files have no Files API handle to re-fetch later, so the
 * adapter emits the decoded bytes on the `artifact_emitted` event and uses a small label as
 * `providerFileId` — the payload itself must never be persisted as an identifier.
 */
const INLINE_ARTIFACT_PREFIX = 'gemini-inline:';
/**
 * Legacy self-describing handle (`data:<mime>;base64,…`) still accepted by
 * `fetchArtifactStream`, so artifacts emitted before the inline-bytes switch stay readable.
 */
const INLINE_DATA_URL_PREFIX = 'data:';

/** Minimal structural view of a `fetch` Response, so the adapter owns SSE parsing. */
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

/** The injectable HTTP layer: tests script it, production uses global `fetch`. */
export type GeminiTransport = (request: GeminiHttpRequest) => Promise<GeminiResponseLike>;

export type GeminiClientFactory = (options: {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}) => GeminiTransport;

const defaultFactory: GeminiClientFactory = (options) => async (request) => {
  // The adapter composes the URL and puts the key in `x-goog-api-key`; the factory only owns
  // transport concerns. A timeout aborts with a `TimeoutError` so `translateError` maps it.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Request timed out.', 'TimeoutError')),
    options.timeoutMs,
  );
  const relayAbort = (): void => controller.abort();
  const callerSignal = request.signal;
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', relayAbort, { once: true });
  }
  try {
    return (await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: controller.signal,
    })) as GeminiResponseLike;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', relayAbort);
  }
};

interface RawGeminiInlineData {
  readonly mimeType?: string;
  readonly data?: string;
}

interface RawGeminiFileData {
  readonly mimeType?: string;
  readonly fileUri?: string;
}

interface RawGeminiPart {
  readonly text?: string;
  readonly inlineData?: RawGeminiInlineData;
  readonly fileData?: RawGeminiFileData;
  readonly functionCall?: { readonly name?: string; readonly args?: unknown };
  readonly functionResponse?: { readonly name?: string; readonly response?: unknown };
  readonly executableCode?: { readonly language?: string; readonly code?: string };
  readonly codeExecutionResult?: { readonly outcome?: string; readonly output?: string };
  /** Gemini 2.5 marks reasoning summaries as "thought" parts; they are never message text. */
  readonly thought?: boolean;
}

interface RawGeminiUsage {
  readonly promptTokenCount?: number;
  readonly candidatesTokenCount?: number;
  readonly totalTokenCount?: number;
  readonly cachedContentTokenCount?: number;
  readonly thoughtsTokenCount?: number;
}

interface RawGeminiChunk {
  readonly candidates?: readonly {
    readonly content?: { readonly parts?: readonly RawGeminiPart[]; readonly role?: string };
    readonly finishReason?: string;
    readonly index?: number;
  }[];
  readonly usageMetadata?: RawGeminiUsage;
  readonly promptFeedback?: { readonly blockReason?: string };
  readonly error?: unknown;
}

/** Shared metadata attached to every translated Gemini error. */
interface TranslatedMeta {
  readonly internalMessage?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly providerStatus?: number;
  readonly providerCode?: string;
}

/** Structural view of a Gemini error body (`{error:{code,status,message}}`) or transport failure. */
interface GeminiErrorShape {
  readonly status?: number;
  readonly statusText?: string;
  readonly message?: string;
  readonly retryAfterMs?: number;
  readonly error?: { readonly code?: number; readonly status?: string; readonly message?: string };
}

/** `finishReason` values that mean "the provider stopped the output", mapped to `content_filter`. */
const SAFETY_FINISH_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'IMAGE_SAFETY',
  'SPII',
]);

/**
 * Gemini sends one JSON object per `data:` line under `alt=sse`. Parsed here (not by the
 * transport) so the injected test transport and the real `fetch` body share one parser.
 */
async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        const payload = parseSseLine(line);
        if (payload !== undefined) yield payload;
        newline = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    const tail = parseSseLine(buffer.replace(/\r$/, ''));
    if (tail !== undefined) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** `undefined` for comments, keep-alives, `[DONE]` and malformed frames. */
function parseSseLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload.length === 0 || payload === '[DONE]') return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    // A single corrupt frame must not abort an otherwise healthy stream.
    return undefined;
  }
}

/** REST APIs carry binaries base64-encoded; `Buffer` keeps large images off the call stack. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(data: string): Uint8Array {
  return Buffer.from(data, 'base64');
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

interface InlineArtifact {
  readonly bytes: Uint8Array;
  readonly mimeType?: string;
}

/** Decodes the `data:` handle this adapter emits for in-band generated files. */
function parseInlineHandle(providerFileId: string): InlineArtifact | null {
  if (!providerFileId.startsWith(INLINE_DATA_URL_PREFIX)) return null;
  const match = /^data:([^;,]*);base64,(.*)$/.exec(providerFileId);
  if (match === null) return null;
  const mimeType = match[1] ?? '';
  const bytes = fromBase64(match[2] ?? '');
  return { bytes, ...(mimeType.length > 0 ? { mimeType } : {}) };
}

/** Accepts a bare id, a `files/<id>` name, or a full Files API URI and yields the trailing id. */
function fileIdFromUri(uri: string): string {
  const withoutQuery = uri.split('?')[0] ?? uri;
  const last = withoutQuery
    .split('/')
    .filter((segment) => segment.length > 0)
    .pop();
  return last !== undefined ? decodeURIComponent(last) : uri;
}

function extensionFor(mimeType: string | undefined): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'application/pdf':
      return '.pdf';
    default:
      return '.bin';
  }
}

export class GeminiAdapter implements ProviderAdapter {
  readonly adapterKey = 'gemini';

  constructor(private readonly clientFactory: GeminiClientFactory = defaultFactory) {}

  /**
   * Pure transform used by tests and token estimation: text-only, no network. Media parts are
   * resolved in `execute` because `ResolvedFile.read()` is asynchronous (see `buildContents`).
   */
  toProviderRequest(req: NormalizedChatRequest): unknown {
    return this.assembleRequest(req, this.textContents(req));
  }

  async estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult> {
    // Gemini has no local tokenizer and `models.countTokens` is a network round-trip per request,
    // so estimation stays local and approximate — mirroring the OpenAI adapter's fallback.
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

  async *execute(req: NormalizedChatRequest, ctx: ExecuteContext): AsyncIterable<GenerationEvent> {
    const apiKey = req.provider.secrets['apiKey'];
    if (apiKey === undefined || apiKey === '') {
      yield {
        type: 'error',
        error: providerError('provider_unavailable', 'Google Gemini API key is not configured.', {
          retryable: false,
        }),
      };
      return;
    }

    // Resolving media can fail (unsupported part, oversize inline part) before any network call.
    let body: unknown;
    try {
      body = this.assembleRequest(req, await this.buildContents(req));
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
      return;
    }

    const transport = this.buildTransport(req.provider, apiKey);
    let response: GeminiResponseLike;
    try {
      response = await transport({
        url: this.streamUrl(req),
        method: 'POST',
        headers: this.jsonHeaders(apiKey),
        body: JSON.stringify(body),
        signal: ctx.signal,
      });
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
      return;
    }

    if (!response.ok) {
      yield { type: 'error', error: await this.translateResponse(response) };
      return;
    }
    if (response.body === null) {
      yield {
        type: 'error',
        error: providerError(
          'provider_unavailable',
          'The model provider returned an empty response.',
          {
            retryable: true,
            providerStatus: response.status,
          },
        ),
      };
      return;
    }

    let started = false;
    /** Part indices are shared by text and generated-file parts so `part_done`/`artifact_emitted` correlate. */
    let nextPartIndex = 0;
    let textPartIndex: number | null = null;
    let usage: TokenUsage | null = null;
    let finishReason: string | null = null;
    let sawFunctionCall = false;
    /** `executableCode` and its `codeExecutionResult` arrive as separate parts with no shared id. */
    let codeToolCallId: string | null = null;
    let toolCounter = 0;
    let artifactCounter = 0;

    try {
      for await (const raw of parseSseStream(response.body)) {
        // Scripted transports are not wired to the signal, so check it explicitly.
        if (ctx.signal.aborted) {
          yield {
            type: 'error',
            error: this.translateError(new DOMException('aborted', 'AbortError')),
          };
          return;
        }

        const chunk = raw as RawGeminiChunk;

        if (chunk.error !== undefined) {
          yield { type: 'error', error: this.translateError(chunk.error) };
          return;
        }

        const blockReason = chunk.promptFeedback?.blockReason;
        if (blockReason !== undefined && blockReason !== 'BLOCK_REASON_UNSPECIFIED') {
          yield {
            type: 'error',
            error: providerError(
              'content_filtered',
              'The request was blocked by the provider safety filter.',
              { retryable: false, providerCode: blockReason },
            ),
          };
          return;
        }

        if (!started) {
          started = true;
          yield { type: 'started' };
        }

        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          // Reasoning summaries are surfaced as parts but are never assistant text.
          if (part.thought === true) continue;

          if (typeof part.text === 'string' && part.text.length > 0) {
            if (textPartIndex === null) {
              textPartIndex = nextPartIndex;
              nextPartIndex += 1;
              yield { type: 'part_started', index: textPartIndex, partType: 'text' };
            }
            yield { type: 'text_delta', index: textPartIndex, text: part.text };
            continue;
          }

          if (part.functionCall !== undefined) {
            // A client-side call: announce it, then close it — the model produced no output for it.
            sawFunctionCall = true;
            const toolCallId = `call-${toolCounter}`;
            toolCounter += 1;
            yield {
              type: 'tool_started',
              toolCallId,
              name: part.functionCall.name ?? 'function_call',
              ...(part.functionCall.args !== undefined ? { input: part.functionCall.args } : {}),
            };
            yield { type: 'tool_completed', toolCallId, status: 'success' };
            continue;
          }

          if (part.executableCode !== undefined) {
            const toolCallId = `code-${toolCounter}`;
            toolCounter += 1;
            codeToolCallId = toolCallId;
            yield {
              type: 'tool_started',
              toolCallId,
              name: 'code_execution',
              input: {
                ...(part.executableCode.language !== undefined
                  ? { language: part.executableCode.language }
                  : {}),
                ...(part.executableCode.code !== undefined
                  ? { code: part.executableCode.code }
                  : {}),
              },
            };
            continue;
          }

          if (part.codeExecutionResult !== undefined) {
            const toolCallId = codeToolCallId ?? `code-${toolCounter}`;
            if (codeToolCallId === null) toolCounter += 1;
            codeToolCallId = null;
            const output = part.codeExecutionResult.output;
            if (output !== undefined && output.length > 0) {
              yield { type: 'tool_delta', toolCallId, delta: output };
            }
            yield {
              type: 'tool_completed',
              toolCallId,
              status: part.codeExecutionResult.outcome === 'OUTCOME_OK' ? 'success' : 'error',
              ...(output !== undefined ? { output } : {}),
            };
            continue;
          }

          const artifact = this.artifactFrom(part, artifactCounter);
          if (artifact !== null) {
            const filename = `gemini-generated-${artifactCounter}${extensionFor(artifact.mimeType)}`;
            artifactCounter += 1;
            const index = nextPartIndex;
            nextPartIndex += 1;
            yield {
              type: 'part_started',
              index,
              partType: artifact.mimeType?.startsWith('image/') === true ? 'image' : 'file',
              ...(artifact.mimeType !== undefined ? { mimeType: artifact.mimeType } : {}),
              name: filename,
            };
            yield {
              type: 'artifact_emitted',
              providerFileId: artifact.providerFileId,
              filename,
              ...(artifact.mimeType !== undefined ? { mimeType: artifact.mimeType } : {}),
              ...(artifact.bytes !== undefined
                ? { bytes: artifact.bytes, sizeBytes: artifact.bytes.byteLength }
                : {}),
              index,
            };
          }
        }

        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason !== undefined) finishReason = candidate.finishReason;
        if (chunk.usageMetadata !== undefined) usage = this.usageFrom(chunk.usageMetadata);
      }
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
      return;
    }

    if (!started) {
      yield { type: 'started' };
    }
    if (textPartIndex !== null) {
      yield { type: 'part_done', index: textPartIndex };
    }
    if (usage !== null) {
      yield { type: 'usage', usage, final: true };
    }
    yield { type: 'finished', reason: this.mapFinishReason(finishReason, sawFunctionCall) };
  }

  /** Builds the JSON body, resolving non-text parts to `inlineData` / extracted text. */
  private assembleRequest(
    req: NormalizedChatRequest,
    contents: unknown[],
  ): Record<string, unknown> {
    const tools = this.buildTools(req);

    return {
      ...(req.system !== undefined && req.system.trim().length > 0
        ? { systemInstruction: { parts: [{ text: req.system }] } }
        : {}),
      contents,
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens,
        ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
        ...(typeof req.topP === 'number' ? { topP: req.topP } : {}),
      },
      ...(tools.length > 0 ? { tools } : {}),
    };
  }

  /** Input images/documents become `inlineData` parts; a pre-extracted document may stay text. */
  private async buildContents(req: NormalizedChatRequest): Promise<unknown[]> {
    const contents: unknown[] = [];
    for (const message of req.messages) {
      const parts: unknown[] = [];
      for (const part of message.parts) {
        if (part.type === 'text') {
          if (part.text.length > 0) parts.push({ text: part.text });
          continue;
        }
        parts.push(await this.mediaPart(part));
      }
      this.pushContent(contents, message.role === 'assistant' ? 'model' : 'user', parts);
    }
    this.normalizeTurns(contents);
    return contents;
  }

  /** Sync, media-free contents for `toProviderRequest`. */
  private textContents(req: NormalizedChatRequest): unknown[] {
    const contents: unknown[] = [];
    for (const message of req.messages) {
      const parts: unknown[] = [];
      for (const part of message.parts) {
        if (part.type === 'text' && part.text.length > 0) parts.push({ text: part.text });
      }
      this.pushContent(contents, message.role === 'assistant' ? 'model' : 'user', parts);
    }
    this.normalizeTurns(contents);
    return contents;
  }

  private async mediaPart(part: NormalizedPart): Promise<unknown> {
    if (part.type === 'text') return { text: part.text };
    if (part.type === 'tool_call' || part.type === 'tool_result') {
      throw providerError(
        'unsupported_for_model',
        'This request uses client-side tools, which this provider does not accept.',
        { retryable: false },
      );
    }

    // A document the context builder already extracted stays cheap text unless native is required.
    if (
      part.type === 'document' &&
      !part.preferNative &&
      part.extractedText !== undefined &&
      part.extractedText.trim().length > 0
    ) {
      return { text: part.extractedText };
    }

    const bytes = await this.readInlineBytes(part.file);
    const mimeType = this.mimeTypeFor(part.file);
    return { inlineData: { mimeType, data: toBase64(bytes) } };
  }

  private async readInlineBytes(file: ResolvedFile): Promise<Uint8Array> {
    if (file.sizeBytes > MAX_INLINE_BYTES) throw this.inlineTooLargeError();
    const bytes = await file.read();
    if (bytes.byteLength > MAX_INLINE_BYTES) throw this.inlineTooLargeError();
    return bytes;
  }

  private inlineTooLargeError(): ProviderError {
    return providerError(
      'unsupported_for_model',
      'The attached file is too large to send inline to this model.',
      { retryable: false },
    );
  }

  private mimeTypeFor(file: ResolvedFile): string {
    return file.mimeType !== undefined && file.mimeType.length > 0
      ? file.mimeType
      : 'application/octet-stream';
  }

  private pushContent(contents: unknown[], role: 'user' | 'model', parts: unknown[]): void {
    // Gemini rejects empty `parts` and requires alternating roles, so adjacent turns merge.
    const safeParts = parts.length > 0 ? parts : [{ text: ' ' }];
    const previous = contents[contents.length - 1] as
      { role: string; parts: unknown[] } | undefined;
    if (previous !== undefined && previous.role === role) {
      previous.parts.push(...safeParts);
      return;
    }
    contents.push({ role, parts: safeParts });
  }

  private normalizeTurns(contents: unknown[]): void {
    if (contents.length === 0) {
      contents.push({ role: 'user', parts: [{ text: ' ' }] });
      return;
    }
    const first = contents[0] as { role: string };
    if (first.role !== 'user') contents.unshift({ role: 'user', parts: [{ text: ' ' }] });
  }

  /**
   * Code execution rides along whenever the model declares `tools`; Google Search grounding is
   * opt-in per model/provider config, because grounding changes answers (and cost) even when the
   * model merely *can* ground.
   */
  private buildTools(req: NormalizedChatRequest): unknown[] {
    if (!req.model.capabilities.tools) return [];
    const tools: unknown[] = [];
    if (this.flag(req, 'googleSearch', false)) tools.push({ googleSearch: {} });
    if (this.flag(req, 'codeExecution', true)) tools.push({ codeExecution: {} });
    return tools;
  }

  private flag(req: NormalizedChatRequest, key: string, fallback: boolean): boolean {
    const modelValue = req.model.config[key];
    if (typeof modelValue === 'boolean') return modelValue;
    const providerValue = req.provider.config[key];
    if (typeof providerValue === 'boolean') return providerValue;
    return fallback;
  }

  /**
   * In-band `inlineData` arrives as base64 with no file handle, so the artifact carries the
   * decoded bytes and a small label. `fileData` keeps the Files API id for later download.
   */
  private artifactFrom(
    part: RawGeminiPart,
    sequence: number,
  ): {
    readonly providerFileId: string;
    readonly mimeType?: string;
    readonly bytes?: Uint8Array;
  } | null {
    const inline = part.inlineData;
    if (inline !== undefined && typeof inline.data === 'string' && inline.data.length > 0) {
      const mimeType =
        typeof inline.mimeType === 'string' && inline.mimeType.length > 0
          ? inline.mimeType
          : 'application/octet-stream';
      const bytes = fromBase64(inline.data);
      if (bytes.byteLength === 0) return null;
      return { providerFileId: `${INLINE_ARTIFACT_PREFIX}${sequence}`, mimeType, bytes };
    }

    const file = part.fileData;
    if (file !== undefined && typeof file.fileUri === 'string' && file.fileUri.length > 0) {
      const mimeType =
        typeof file.mimeType === 'string' && file.mimeType.length > 0 ? file.mimeType : undefined;
      return {
        providerFileId: fileIdFromUri(file.fileUri),
        ...(mimeType !== undefined ? { mimeType } : {}),
      };
    }

    return null;
  }

  private usageFrom(meta: RawGeminiUsage): TokenUsage {
    const cached = meta.cachedContentTokenCount;
    const thoughts = meta.thoughtsTokenCount;
    return {
      inputTokens: typeof meta.promptTokenCount === 'number' ? meta.promptTokenCount : 0,
      outputTokens: typeof meta.candidatesTokenCount === 'number' ? meta.candidatesTokenCount : 0,
      ...(typeof cached === 'number' && cached > 0 ? { cachedInputTokens: cached } : {}),
      ...(typeof thoughts === 'number' && thoughts > 0 ? { reasoningTokens: thoughts } : {}),
      source: 'provider',
    };
  }

  /**
   * `STOP` after a client-side `functionCall` means "the turn ended because I need tool results",
   * which is the PAL's `tool_use`; server-side grounding/code execution keeps `stop`.
   */
  private mapFinishReason(reason: string | null, sawFunctionCall: boolean): FinishReason {
    if (reason === null) return sawFunctionCall ? 'tool_use' : 'stop';
    switch (reason) {
      case 'STOP':
        return sawFunctionCall ? 'tool_use' : 'stop';
      case 'MAX_TOKENS':
        return 'length';
      default:
        return SAFETY_FINISH_REASONS.has(reason) ? 'content_filter' : 'other';
    }
  }

  translateError(err: unknown): ProviderError {
    if (isAbortLikeError(err)) {
      return providerError('generation_cancelled', 'The generation was cancelled.', {
        retryable: false,
      });
    }

    const shape: GeminiErrorShape = typeof err === 'object' && err !== null ? err : {};
    const inner = shape.error;
    const message = inner?.message ?? shape.message ?? (err instanceof Error ? err.message : '');
    const sanitized = scrubSecrets(message);
    const status =
      typeof shape.status === 'number'
        ? shape.status
        : typeof inner?.code === 'number'
          ? inner.code
          : undefined;
    const statusName = inner?.status ?? shape.statusText;
    const retryAfterMs = shape.retryAfterMs;

    if (
      isTimeoutLikeError(err) ||
      status === 408 ||
      status === 504 ||
      statusName === 'DEADLINE_EXCEEDED'
    ) {
      return providerError('generation_timeout', 'The model provider timed out.', {
        retryable: true,
        ...(status !== undefined ? { providerStatus: status } : {}),
        internalMessage: sanitized,
      });
    }

    if (status !== undefined || statusName !== undefined) {
      const withMeta = (extra: Omit<TranslatedMeta, 'internalMessage'> = {}): TranslatedMeta => ({
        internalMessage: sanitized,
        ...(status !== undefined ? { providerStatus: status } : {}),
        ...(statusName !== undefined ? { providerCode: statusName } : {}),
        ...extra,
      });
      const retryOpts = retryAfterMs !== undefined ? { retryAfterMs } : {};

      if (status === 400) {
        // Gemini reports an over-long prompt as INVALID_ARGUMENT with a token-count message.
        const isContext = /context|token|too large|maximum/i.test(message);
        return providerError(
          isContext ? 'context_too_large' : 'invalid_request',
          isContext
            ? 'The conversation exceeds the model context window.'
            : 'The model provider rejected the request.',
          { retryable: false, ...withMeta() },
        );
      }

      if (
        status === 401 ||
        status === 403 ||
        statusName === 'UNAUTHENTICATED' ||
        statusName === 'PERMISSION_DENIED'
      ) {
        return providerError(
          'provider_unavailable',
          'The model provider rejected authentication.',
          {
            retryable: false,
            ...withMeta(),
          },
        );
      }

      if (status === 404 || statusName === 'NOT_FOUND') {
        return providerError(
          'model_unavailable',
          'The requested model is not available from the provider.',
          {
            retryable: false,
            ...withMeta(),
          },
        );
      }

      if (status === 413) {
        return providerError('context_too_large', 'The request exceeds the provider size limits.', {
          retryable: false,
          ...withMeta(),
        });
      }

      if (status === 429 || statusName === 'RESOURCE_EXHAUSTED') {
        return providerError(
          'provider_rate_limited',
          'The model provider is rate limiting requests.',
          {
            retryable: true,
            ...retryOpts,
            ...withMeta(),
          },
        );
      }

      if (status !== undefined && status >= 500) {
        return providerError(
          'provider_unavailable',
          'The model provider is temporarily unavailable.',
          {
            retryable: true,
            ...retryOpts,
            ...withMeta(),
          },
        );
      }

      if (status !== undefined && status >= 400) {
        return providerError('provider_unavailable', 'The model provider rejected the request.', {
          retryable: false,
          ...withMeta(),
        });
      }

      // Status-name-only failures (a mid-stream frame carrying an error object, no HTTP status).
      if (statusName === 'INVALID_ARGUMENT') {
        return providerError('invalid_request', 'The model provider rejected the request.', {
          retryable: false,
          ...withMeta(),
        });
      }
      if (statusName === 'UNAVAILABLE' || statusName === 'INTERNAL') {
        return providerError(
          'provider_unavailable',
          'The model provider is temporarily unavailable.',
          {
            retryable: true,
            ...retryOpts,
            ...withMeta(),
          },
        );
      }
    }

    const errMsg = err instanceof Error ? scrubSecrets(err.message) : 'unknown_error';
    return providerError('provider_unavailable', 'The model provider is unavailable.', {
      retryable: true,
      internalMessage: errMsg,
    });
  }

  /** Turns a non-2xx HTTP response into a `ProviderError` without ever echoing the body raw. */
  private async translateResponse(response: GeminiResponseLike): Promise<ProviderError> {
    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const inner =
      typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
    return this.translateError({
      status: response.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(inner !== undefined && inner !== null ? { error: inner } : {}),
    });
  }

  async healthCheck(ctx: HealthCheckContext): Promise<HealthCheckResult> {
    const { provider, signal } = ctx;
    const apiKey = provider.secrets['apiKey'];
    if (apiKey === undefined || apiKey === '') {
      return healthNotConfigured('secret_not_configured');
    }
    const startedAt = Date.now();
    try {
      const transport = this.buildTransport(provider, apiKey);
      const response = await transport({
        url: this.modelsUrl(provider),
        method: 'GET',
        headers: this.authHeaders(apiKey),
        signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          detail: `models.list failed (${response.status})`,
        };
      }
      const payload = (await response.json()) as { models?: readonly unknown[] };
      const count = Array.isArray(payload.models) ? payload.models.length : 0;
      return { ok: true, latencyMs: Date.now() - startedAt, detail: `models.list ok (${count})` };
    } catch (error) {
      return healthFailed(error, Date.now() - startedAt);
    }
  }

  /**
   * Downloads a provider-generated file. In-band (`inlineData`) artifacts are decoded locally —
   * they have no Files API handle — while `fileData` artifacts hit `files/{id}?alt=media`.
   */
  async fetchArtifactStream(
    providerFileId: string,
    ctx: FilesApiContext,
  ): Promise<ProviderArtifact> {
    const inline = parseInlineHandle(providerFileId);
    if (inline !== null) {
      return {
        stream: bytesToStream(inline.bytes),
        sizeBytes: inline.bytes.byteLength,
        ...(inline.mimeType !== undefined ? { mimeType: inline.mimeType } : {}),
      };
    }

    // Inline labels carry no payload: the bytes travelled with `artifact_emitted`, and the sink
    // only calls this method when no bytes were supplied.
    if (providerFileId.startsWith(INLINE_ARTIFACT_PREFIX)) {
      throw providerError(
        'provider_unavailable',
        'The generated file was not retained by the provider.',
        {
          retryable: false,
        },
      );
    }

    const apiKey = ctx.provider.secrets['apiKey'];
    if (apiKey === undefined || apiKey === '') {
      throw providerError('provider_unavailable', 'Google Gemini API key is not configured.', {
        retryable: false,
      });
    }

    const transport = this.buildTransport(ctx.provider, apiKey);
    const response = await transport({
      url: this.fileDownloadUrl(ctx.provider, providerFileId),
      method: 'GET',
      headers: this.authHeaders(apiKey),
      signal: ctx.signal,
    });

    if (!response.ok || response.body === null) {
      throw providerError('provider_unavailable', 'Could not download the generated file.', {
        retryable: response.status >= 500 || response.status === 429,
        providerStatus: response.status,
      });
    }

    const contentType = response.headers.get('content-type');
    const lengthHeader = response.headers.get('content-length');
    const sizeBytes =
      lengthHeader !== null && Number.isFinite(Number(lengthHeader))
        ? Number(lengthHeader)
        : undefined;

    return {
      stream: response.body,
      ...(contentType !== null ? { mimeType: contentType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    };
  }

  /** Uploads an input binary to the Files API so `fileData` can reference it from a later turn. */
  async uploadInputFile(file: InputFileUpload, ctx: FilesApiContext): Promise<UploadedInputFile> {
    const apiKey = ctx.provider.secrets['apiKey'];
    if (apiKey === undefined || apiKey === '') {
      throw providerError('provider_unavailable', 'Google Gemini API key is not configured.', {
        retryable: false,
      });
    }

    const form = new FormData();
    form.append('file', new Blob([file.bytes], { type: file.mimeType }), file.filename);

    const transport = this.buildTransport(ctx.provider, apiKey);
    const response = await transport({
      url: `${this.apiBase(ctx.provider)}/${API_VERSION}/files`,
      method: 'POST',
      // No content-type: `fetch` sets the multipart boundary itself.
      headers: this.authHeaders(apiKey),
      body: form,
      signal: ctx.signal,
    });

    if (!response.ok) {
      throw providerError('provider_unavailable', 'Could not upload the input file.', {
        retryable: response.status >= 500 || response.status === 429,
        providerStatus: response.status,
      });
    }

    const payload = (await response.json()) as { name?: unknown; file?: { name?: unknown } };
    const nestedName = payload.file?.name;
    const name =
      typeof payload.name === 'string' && payload.name.length > 0
        ? payload.name
        : typeof nestedName === 'string' && nestedName.length > 0
          ? nestedName
          : undefined;
    if (name === undefined) {
      throw providerError('provider_unavailable', 'The provider did not return a file id.', {
        retryable: true,
      });
    }

    return { providerFileId: name };
  }

  private streamUrl(req: NormalizedChatRequest): string {
    const model = req.model.apiModelId.replace(/^models\//, '');
    return `${this.apiBase(req.provider)}/${API_VERSION}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  }

  private modelsUrl(provider: ProviderRuntimeConfig): string {
    return `${this.apiBase(provider)}/${API_VERSION}/models`;
  }

  private fileDownloadUrl(provider: ProviderRuntimeConfig, providerFileId: string): string {
    const id = fileIdFromUri(providerFileId);
    return `${this.apiBase(provider)}/${API_VERSION}/files/${encodeURIComponent(id)}?alt=media`;
  }

  private apiBase(provider: ProviderRuntimeConfig): string {
    return provider.baseUrl !== undefined && provider.baseUrl !== ''
      ? provider.baseUrl.replace(/\/$/, '')
      : DEFAULT_BASE_URL;
  }

  /** The key travels in the header, never the URL, so it can never leak into a log line. */
  private jsonHeaders(apiKey: string): Record<string, string> {
    return { 'x-goog-api-key': apiKey, 'content-type': 'application/json' };
  }

  private authHeaders(apiKey: string): Record<string, string> {
    return { 'x-goog-api-key': apiKey };
  }

  private buildTransport(provider: ProviderRuntimeConfig, apiKey: string): GeminiTransport {
    return this.clientFactory({
      apiKey,
      baseUrl: this.apiBase(provider),
      timeoutMs: numberFromConfig(provider.config, 'timeoutMs', 60_000),
    });
  }
}
