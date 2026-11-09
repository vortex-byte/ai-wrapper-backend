import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import type { ExecuteContext } from '@/providers/ports/provider-adapter.ts';
import { MAX_PAUSE_TURNS } from './config.ts';
import { requestHeaders } from './client.ts';
import { translateError } from './errors.ts';
import { extractGeneratedFiles, toolResultOutput } from './files.ts';
import { compactionEdit, mergeContent, replayContent } from './request.ts';
import type {
  AnthropicClientLike,
  FinishReason,
  OutgoingMessage,
  RawAnthropicStreamEvent,
  ReplayBlock,
  RunState,
} from './types.ts';
import { accumulateInputUsage, createRunState, resetTurn } from './usage.ts';

export function parseToolInput(rawJson: string): unknown {
  if (rawJson.length === 0) return undefined;
  try {
    return JSON.parse(rawJson) as unknown;
  } catch {
    return undefined;
  }
}

export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
      return 'content_filter';
    default:
      return 'other';
  }
}

export function toolCallIdFor(runState: RunState, index: number): string {
  return runState.toolBlocks.get(index)?.toolCallId ?? `tool-${index}`;
}

export function* handleToolResult(
  ev: RawAnthropicStreamEvent,
  blockType: string,
): Iterable<GenerationEvent> {
  const toolCallId = ev.content_block?.tool_use_id ?? `tool-${ev.index ?? 0}`;
  const output = toolResultOutput(ev.content_block);
  for (const chunk of [output.stdout, output.stderr]) {
    if (typeof chunk === 'string' && chunk.length > 0) {
      yield { type: 'tool_delta', toolCallId, delta: chunk };
    }
  }

  for (const file of extractGeneratedFiles(ev.content_block?.content)) {
    yield {
      type: 'artifact_emitted',
      providerFileId: file.fileId,
      filename: file.filename,
      ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
      ...(file.sizeBytes !== undefined ? { sizeBytes: file.sizeBytes } : {}),
    };
  }

  const isError = blockType.includes('error');
  yield { type: 'tool_completed', toolCallId, status: isError ? 'error' : 'success' };
}

export function* handleBlockStart(
  ev: RawAnthropicStreamEvent,
  runState: RunState,
): Iterable<GenerationEvent> {
  const index = ev.index ?? 0;
  const blockType = ev.content_block?.type ?? 'text';
  runState.openBlocks.add(index);
  runState.blockTypes.set(index, blockType);

  if (ev.content_block !== undefined) {
    runState.turnBlockOrder.push(index);
    runState.turnBlocks.set(index, {
      ...(ev.content_block as unknown as Record<string, unknown>),
      type: blockType,
    } as ReplayBlock);
  }

  if (blockType === 'text') {
    runState.blockText.set(index, '');
    yield { type: 'part_started', index, partType: 'text' };
    return;
  }

  if (blockType === 'compaction') {
    const blockRecord = ev.content_block as Record<string, unknown> | undefined;
    const content = typeof blockRecord?.['content'] === 'string' ? blockRecord['content'] : '';
    const signature =
      typeof blockRecord?.['signature'] === 'string' ? blockRecord['signature'] : undefined;
    const block = runState.turnBlocks.get(index);
    if (block !== undefined) {
      if (content.length > 0) block['content'] = content;
      if (signature !== undefined && signature.length > 0) block['signature'] = signature;
    }
    if (content.length > 0 && !runState.compactionEmittedIndices.has(index)) {
      runState.compactionEmittedIndices.add(index);
      yield {
        type: 'compaction',
        provider: 'anthropic',
        payload: {
          type: 'compaction',
          content,
          ...(signature !== undefined && signature.length > 0 ? { signature } : {}),
        },
      };
    }
    return;
  }

  if (blockType.endsWith('_tool_result')) {
    yield* handleToolResult(ev, blockType);
    return;
  }

  if (
    blockType === 'tool_use' ||
    blockType === 'server_tool_use' ||
    blockType.endsWith('_tool_use')
  ) {
    const toolCallId = ev.content_block?.id ?? `tool-${index}`;
    const name = ev.content_block?.name ?? blockType;
    runState.toolBlocks.set(index, { toolCallId, name });
    runState.toolInputJson.set(index, '');
    yield {
      type: 'tool_started',
      toolCallId,
      name,
      ...(ev.content_block?.input !== undefined ? { input: ev.content_block.input } : {}),
    };
  }
}

export function* handleBlockDelta(
  ev: RawAnthropicStreamEvent,
  runState: RunState,
): Iterable<GenerationEvent> {
  const index = ev.index ?? 0;
  const blockType = runState.blockTypes.get(index) ?? 'text';

  if (!runState.openBlocks.has(index)) {
    runState.openBlocks.add(index);
    if (blockType === 'text') {
      runState.blockText.set(index, '');
      yield { type: 'part_started', index, partType: 'text' };
    }
  }

  if (ev.delta?.type === 'compaction_delta') {
    const content = typeof ev.delta.content === 'string' ? ev.delta.content : '';
    const block = runState.turnBlocks.get(index);
    if (block !== undefined && content.length > 0) {
      block['content'] = content;
    }
    return;
  }

  if (ev.delta?.type === 'input_json_delta' && ev.delta.partial_json !== undefined) {
    runState.toolInputJson.set(
      index,
      (runState.toolInputJson.get(index) ?? '') + ev.delta.partial_json,
    );
    return;
  }

  if (ev.delta?.type === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
    const block = runState.turnBlocks.get(index);
    if (block !== undefined) {
      block['thinking'] =
        (typeof block['thinking'] === 'string' ? block['thinking'] : '') + ev.delta.thinking;
    }
    return;
  }

  if (ev.delta?.type === 'signature_delta' && typeof ev.delta.signature === 'string') {
    const block = runState.turnBlocks.get(index);
    if (block !== undefined) {
      block['signature'] =
        (typeof block['signature'] === 'string' ? block['signature'] : '') + ev.delta.signature;
    }
    return;
  }

  if (ev.delta?.text !== undefined) {
    if (blockType === 'text') {
      runState.blockText.set(index, (runState.blockText.get(index) ?? '') + ev.delta.text);
      const block = runState.turnBlocks.get(index);
      if (block !== undefined) {
        block['text'] = (typeof block['text'] === 'string' ? block['text'] : '') + ev.delta.text;
      }
      yield { type: 'text_delta', index, text: ev.delta.text };
    } else {
      yield {
        type: 'tool_delta',
        toolCallId: toolCallIdFor(runState, index),
        delta: ev.delta.text,
      };
    }
  }
}

export function* handleBlockStop(
  ev: RawAnthropicStreamEvent,
  runState: RunState,
): Iterable<GenerationEvent> {
  const index = ev.index ?? 0;
  const blockType = runState.blockTypes.get(index) ?? 'text';
  if (!runState.openBlocks.has(index)) return;
  runState.openBlocks.delete(index);

  if (blockType === 'text') {
    const text = runState.blockText.get(index) ?? '';
    const block = runState.turnBlocks.get(index);
    if (block !== undefined) block['text'] = text;
    yield { type: 'part_done', index };
    return;
  }

  if (blockType === 'compaction') {
    const block = runState.turnBlocks.get(index);
    const content = typeof block?.['content'] === 'string' ? block['content'] : '';
    const signature =
      typeof block?.['signature'] === 'string' && block['signature'].length > 0
        ? block['signature']
        : undefined;
    if (content.length > 0 && !runState.compactionEmittedIndices.has(index)) {
      runState.compactionEmittedIndices.add(index);
      yield {
        type: 'compaction',
        provider: 'anthropic',
        payload: {
          type: 'compaction',
          content,
          ...(signature !== undefined && signature.length > 0 ? { signature } : {}),
        },
      };
    }
    return;
  }

  const tool = runState.toolBlocks.get(index);
  if (tool !== undefined) {
    const rawJson = runState.toolInputJson.get(index) ?? '';
    const parsed = parseToolInput(rawJson);
    const block = runState.turnBlocks.get(index);
    if (block !== undefined && parsed !== undefined) block['input'] = parsed;
    yield { type: 'tool_completed', toolCallId: tool.toolCallId, status: 'success' };
  }
}

export async function* executeStream(
  req: NormalizedChatRequest,
  ctx: ExecuteContext,
  client: AnthropicClientLike,
  baseMessages: OutgoingMessage[],
  baseParams: Record<string, unknown>,
): AsyncIterable<GenerationEvent> {
  const runState = createRunState();
  let turn = 0;
  let messages = baseMessages;
  let providerStarted = false;
  let currentContainerId: string | undefined;

  while (turn <= MAX_PAUSE_TURNS) {
    resetTurn(runState);

    let stream: AsyncIterable<unknown>;
    try {
      const compactionActive = compactionEdit(req) !== undefined;
      stream = await client.messages.create(
        { ...baseParams, messages },
        { signal: ctx.signal, headers: requestHeaders(req, compactionActive) },
      );
    } catch (err) {
      yield { type: 'error', error: translateError(err) };
      return;
    }

    let paused = false;

    try {
      for await (const rawEvent of stream) {
        const ev = rawEvent as RawAnthropicStreamEvent;

        if (ev.type === 'error') {
          yield { type: 'error', error: translateError(ev.error ?? ev) };
          return;
        }

        if (ev.type === 'message_start') {
          if (!providerStarted) {
            providerStarted = true;
            yield {
              type: 'started',
              ...(ev.message?.id ? { providerRequestId: ev.message.id } : {}),
            };
          }
          if (ev.message?.container?.id !== undefined) {
            currentContainerId = ev.message.container.id;
          }
          accumulateInputUsage(runState, ev);
        } else if (ev.type === 'content_block_start') {
          if (!providerStarted) {
            providerStarted = true;
            yield { type: 'started' };
          }
          yield* handleBlockStart(ev, runState);
        } else if (ev.type === 'content_block_delta') {
          if (!providerStarted) {
            providerStarted = true;
            yield { type: 'started' };
          }
          yield* handleBlockDelta(ev, runState);
        } else if (ev.type === 'content_block_stop') {
          yield* handleBlockStop(ev, runState);
        } else if (ev.type === 'message_delta') {
          if (ev.delta?.stop_reason !== undefined && ev.delta.stop_reason !== null) {
            runState.stopReason = ev.delta.stop_reason;
            if (ev.delta.stop_reason === 'pause_turn') paused = true;
          }
          if (ev.usage?.output_tokens !== undefined) {
            runState.outputTokens =
              runState.priorTurnsOutputTokens + ev.usage.output_tokens + runState.iterationOutputTokens;
          }
        }
        if (ev.container?.id !== undefined) {
          currentContainerId = ev.container.id;
        }
      }

      for (const index of [...runState.openBlocks]) {
        yield { type: 'part_done', index };
        runState.openBlocks.delete(index);
      }
    } catch (err) {
      yield { type: 'error', error: translateError(err) };
      return;
    }

    if (!paused) break;
    turn += 1;
    if (turn > MAX_PAUSE_TURNS) {
      runState.stopReason = 'pause_turn_exceeded';
      break;
    }
    if (currentContainerId !== undefined) {
      const existingContainer =
        typeof baseParams['container'] === 'object' && baseParams['container'] !== null
          ? (baseParams['container'] as Record<string, unknown>)
          : {};
      baseParams['container'] = {
        ...existingContainer,
        id: currentContainerId,
      };
    }
    messages = [
      ...messages,
      {
        role: 'assistant',
        content: replayContent(runState),
      },
    ];
    const lastMessage = messages[messages.length - 1];
    const previous = messages[messages.length - 2];
    if (lastMessage !== undefined && previous !== undefined && previous.role === 'assistant') {
      previous.content = mergeContent(previous.content, lastMessage.content);
      messages = messages.slice(0, -1);
    }
  }

  if (!providerStarted) {
    yield { type: 'started' };
  }

  yield {
    type: 'usage',
    usage: {
      inputTokens: runState.inputTokens,
      outputTokens: runState.outputTokens,
      ...(runState.cachedInputTokens !== undefined
        ? { cachedInputTokens: runState.cachedInputTokens }
        : {}),
      source: 'provider',
    },
    final: true,
  };

  yield { type: 'finished', reason: mapFinishReason(runState.stopReason) };
}
