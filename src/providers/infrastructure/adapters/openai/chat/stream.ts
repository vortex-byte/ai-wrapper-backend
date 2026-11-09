import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationEvent, TokenUsage } from '@/providers/domain/pal.ts';
import { providerError } from '@/providers/domain/errors.ts';
import type { ExecuteContext } from '@/providers/ports/provider-adapter.ts';
import type { OpenAIClientLike } from '../client.ts';
import { translateError } from '../errors.ts';
import type { FinishReason, RawOpenAIChunk } from '../types.ts';
import { buildMessages, buildRequest, mapFinishReason, resolveMediaBlocks } from './request.ts';

export async function* executeChat(
  req: NormalizedChatRequest,
  ctx: ExecuteContext,
  client: OpenAIClientLike,
): AsyncIterable<GenerationEvent> {
  let params: unknown;
  try {
    params = buildRequest(req, buildMessages(req, await resolveMediaBlocks(req)));
  } catch (err) {
    yield { type: 'error', error: translateError(err) };
    return;
  }

  let stream: AsyncIterable<unknown>;
  try {
    stream = await client.chat.completions.create(params, { signal: ctx.signal });
  } catch (err) {
    yield { type: 'error', error: translateError(err) };
    return;
  }

  let started = false;
  let partStarted = false;
  let pendingUsage: TokenUsage | undefined;
  let terminalReason: FinishReason = 'stop';

  try {
    for await (const rawChunk of stream) {
      const chunk = rawChunk as RawOpenAIChunk;

      if (!started) {
        started = true;
        yield {
          type: 'started',
          ...(chunk.id ? { providerRequestId: chunk.id } : {}),
        };
      }

      const choice = chunk.choices?.[0];
      const refusalText = choice?.delta?.refusal;
      const contentText = choice?.delta?.content;
      if (refusalText || contentText) {
        if (!partStarted) {
          partStarted = true;
          yield { type: 'part_started', index: 0, partType: 'text' };
        }
        if (refusalText) {
          yield { type: 'text_delta', index: 0, text: refusalText };
        }
        if (contentText) {
          yield { type: 'text_delta', index: 0, text: contentText };
        }
      }

      if (choice?.finish_reason) {
        terminalReason = mapFinishReason(choice.finish_reason);
      }

      if (chunk.usage) {
        pendingUsage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
          cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          source: 'provider',
        };
      }
    }

    if (!started) {
      yield { type: 'started' };
    }
    if (partStarted) {
      yield { type: 'part_done', index: 0 };
    }
    if (pendingUsage) {
      yield { type: 'usage', usage: pendingUsage, final: true };
    }
    yield { type: 'finished', reason: terminalReason };
  } catch (err) {
    yield { type: 'error', error: translateError(err) };
  }
}

export function missingApiKey(): GenerationEvent {
  return {
    type: 'error',
    error: providerError('provider_unavailable', 'OpenAI API key is not configured.', {
      retryable: false,
    }),
  };
}
