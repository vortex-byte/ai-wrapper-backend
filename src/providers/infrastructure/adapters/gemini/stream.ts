import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import { providerError } from '@/providers/domain/errors.ts';
import type { GenerationEvent, TokenUsage } from '@/providers/domain/pal.ts';
import type { ExecuteContext } from '@/providers/ports/provider-adapter.ts';
import { jsonHeaders, streamUrl } from './client.ts';
import {
  INLINE_ARTIFACT_PREFIX,
  SAFETY_FINISH_REASONS,
} from './config.ts';
import { translateError, translateResponse } from './errors.ts';
import { extensionFor, fileIdFromUri, fromBase64 } from './media.ts';
import { assembleRequest, buildContents } from './request.ts';
import type {
  FinishReason,
  GeminiResponseLike,
  GeminiTransport,
  RawGeminiChunk,
  RawGeminiPart,
} from './types.ts';
import { usageFrom } from './usage.ts';

export function parseSseLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  const payload = trimmed.slice('data:'.length).trim();
  if (payload.length === 0 || payload === '[DONE]') return undefined;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
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

export function mapFinishReason(reason: string | null, sawFunctionCall: boolean): FinishReason {
  if (reason === null) return sawFunctionCall ? 'tool_use' : 'stop';
  switch (reason) {
    case 'STOP':
      return sawFunctionCall ? 'tool_use' : 'stop';
    case 'MAX_TOKENS':
    case 'CONTINUATION':
      return 'length';
    default:
      return SAFETY_FINISH_REASONS.has(reason) ? 'content_filter' : 'other';
  }
}

export function artifactFrom(
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

export async function* executeStream(
  req: NormalizedChatRequest,
  ctx: ExecuteContext,
  transport: GeminiTransport,
  apiKey: string,
): AsyncIterable<GenerationEvent> {
  let body: unknown;
  try {
    body = assembleRequest(req, await buildContents(req));
  } catch (err) {
    yield { type: 'error', error: translateError(err) };
    return;
  }

  let response: GeminiResponseLike;
  try {
    response = await transport({
      url: streamUrl(req.provider, req.model.apiModelId),
      method: 'POST',
      headers: jsonHeaders(apiKey),
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
  } catch (err) {
    yield { type: 'error', error: translateError(err) };
    return;
  }

  if (!response.ok) {
    yield { type: 'error', error: await translateResponse(response) };
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
  let nextPartIndex = 0;
  let textPartIndex: number | null = null;
  let usage: TokenUsage | null = null;
  let finishReason: string | null = null;
  let sawFunctionCall = false;
  let codeToolCallId: string | null = null;
  let toolCounter = 0;
  let artifactCounter = 0;

  try {
    for await (const raw of parseSseStream(response.body)) {
      if (ctx.signal.aborted) {
        yield {
          type: 'error',
          error: translateError(new DOMException('aborted', 'AbortError')),
        };
        return;
      }

      const chunk = raw as RawGeminiChunk;

      if (chunk.error !== undefined) {
        yield { type: 'error', error: translateError(chunk.error) };
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

        const artifact = artifactFrom(part, artifactCounter);
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
      if (chunk.usageMetadata !== undefined) usage = usageFrom(chunk.usageMetadata);
    }
  } catch (err) {
    yield { type: 'error', error: translateError(err) };
    return;
  } finally {
    try {
      await response.body.cancel();
    } catch {
      // ignore
    }
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
  yield { type: 'finished', reason: mapFinishReason(finishReason, sawFunctionCall) };
}
