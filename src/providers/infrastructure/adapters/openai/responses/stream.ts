import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import type { ExecuteContext } from '@/providers/ports/provider-adapter.ts';
import type { OpenAIClientLike } from '../client.ts';
import { responsesError, translateError } from '../errors.ts';
import type { ExecutionState, RawResponsesEvent, RawResponsesItem } from '../types.ts';
import {
  artifactEvent,
  emitContainerArtifacts,
  imageArtifact,
  partialImageArtifact,
  reachedImageCap,
  sweepImages,
} from './artifacts.ts';
import { buildResponsesRequest } from './request.ts';
import { responsesUsage } from './usage.ts';

function* ensureToolStarted(
  toolCallId: string,
  name: string,
  state: ExecutionState,
): Iterable<GenerationEvent> {
  if (state.startedTools.has(toolCallId)) return;
  state.startedTools.add(toolCallId);
  yield { type: 'tool_started', toolCallId, name };
}

function* completeTool(
  toolCallId: string,
  status: 'success' | 'error',
  state: ExecutionState,
): Iterable<GenerationEvent> {
  if (state.completedTools.has(toolCallId)) return;
  state.completedTools.add(toolCallId);
  yield { type: 'tool_completed', toolCallId, status };
}

function* handleItemStarted(
  item: RawResponsesItem | undefined,
  state: ExecutionState,
): Iterable<GenerationEvent> {
  if (item === undefined) return;

  if (item.type === 'message') {
    if (!state.textPartStarted) {
      state.textPartStarted = true;
      yield { type: 'part_started', index: 0, partType: 'text' };
    }
    return;
  }

  if (item.type === 'code_interpreter_call') {
    if (item.container_id !== undefined) state.containerIds.add(item.container_id);
    yield* ensureToolStarted(item.id ?? item.call_id ?? 'code_interpreter', 'code_interpreter', state);
    return;
  }

  if (item.type === 'shell_call') {
    if (item.environment?.container_id !== undefined) {
      state.containerIds.add(item.environment.container_id);
    }
    const toolCallId = item.id ?? item.call_id ?? 'shell';
    if (!state.startedTools.has(toolCallId)) {
      state.startedTools.add(toolCallId);
      yield {
        type: 'tool_started',
        toolCallId,
        name: 'shell',
        ...(item.action?.commands !== undefined ? { input: { commands: item.action.commands } } : {}),
      };
    }
  }

  if (item.type === 'image_generation_call') {
    yield* ensureToolStarted(item.id ?? 'image_generation', 'image_generation', state);
  }
}

function* handleItemDone(
  item: RawResponsesItem | undefined,
  state: ExecutionState,
  req: NormalizedChatRequest,
): Iterable<GenerationEvent> {
  if (item === undefined) return;

  if (item.type === 'code_interpreter_call') {
    if (item.container_id !== undefined) state.containerIds.add(item.container_id);
    const toolCallId = item.id ?? 'code_interpreter';
    for (const entry of item.outputs ?? []) {
      if (entry.type === 'logs' && entry.logs !== undefined && entry.logs.length > 0) {
        yield { type: 'tool_delta', toolCallId, delta: entry.logs };
      }
    }
    yield* completeTool(toolCallId, item.status === 'failed' ? 'error' : 'success', state);
    return;
  }

  if (item.type === 'shell_call') {
    if (item.environment?.container_id !== undefined) {
      state.containerIds.add(item.environment.container_id);
    }
    yield* completeTool(
      item.id ?? item.call_id ?? 'shell',
      item.status === 'incomplete' ? 'error' : 'success',
      state,
    );
    return;
  }

  if (item.type === 'image_generation_call') {
    const failed = item.status === 'failed' || item.status === 'incomplete';
    if (!failed && !reachedImageCap(req, state)) yield* imageArtifact(item, state, req);
    yield* completeTool(item.id ?? 'image_generation', failed ? 'error' : 'success', state);
    return;
  }

  if (item.type === 'compaction') {
    yield { type: 'compaction', provider: 'openai', payload: item };
  }
}

function* annotationArtifact(
  event: RawResponsesEvent,
  state: ExecutionState,
): Iterable<GenerationEvent> {
  const annotation = event.annotation;
  if (annotation === null || annotation === undefined) return;
  if (annotation.type !== 'container_file_citation') return;
  if (annotation.container_id === undefined || annotation.file_id === undefined) return;

  state.containerIds.add(annotation.container_id);
  const filename = annotation.filename ?? annotation.file_id;
  yield* artifactEvent(state, annotation.container_id, annotation.file_id, filename);
}

function recordContainerIds(
  output: readonly RawResponsesItem[] | undefined,
  state: ExecutionState,
): void {
  for (const item of output ?? []) {
    if (item.type === 'code_interpreter_call' && item.container_id !== undefined) {
      state.containerIds.add(item.container_id);
    }
    if (item.type === 'shell_call' && item.environment?.container_id !== undefined) {
      state.containerIds.add(item.environment.container_id);
    }
  }
}

export function* handleResponsesEvent(
  event: RawResponsesEvent,
  state: ExecutionState,
  req: NormalizedChatRequest,
): Iterable<GenerationEvent> {
  const output = event.response?.output;

  switch (event.type) {
    case 'response.created':
    case 'response.in_progress': {
      if (!state.started) {
        state.started = true;
        yield {
          type: 'started',
          ...(event.response?.id !== undefined ? { providerRequestId: event.response.id } : {}),
        };
      }
      return;
    }

    case 'response.output_item.added': {
      yield* handleItemStarted(event.item, state);
      return;
    }

    case 'response.output_text.delta':
    case 'response.refusal.delta': {
      if (event.delta === undefined || event.delta.length === 0) return;
      if (!state.textPartStarted) {
        state.textPartStarted = true;
        yield { type: 'part_started', index: 0, partType: 'text' };
      }
      yield { type: 'text_delta', index: 0, text: event.delta };
      return;
    }

    case 'response.code_interpreter_call_code.delta': {
      if (event.delta !== undefined && event.delta.length > 0) {
        const toolCallId = event.item_id ?? 'code_interpreter';
        yield* ensureToolStarted(toolCallId, 'code_interpreter', state);
        yield { type: 'tool_delta', toolCallId, delta: event.delta };
      }
      return;
    }

    case 'response.shell_call_command.delta':
    case 'response.shell_call_output_content.delta': {
      if (event.delta !== undefined && event.delta.length > 0) {
        const toolCallId = event.item_id ?? 'shell';
        yield* ensureToolStarted(toolCallId, 'shell', state);
        yield { type: 'tool_delta', toolCallId, delta: event.delta };
      }
      return;
    }

    case 'response.code_interpreter_call.completed': {
      yield* completeTool(event.item_id ?? 'code_interpreter', 'success', state);
      return;
    }

    case 'response.image_generation_call.partial_image': {
      yield* partialImageArtifact(event, state, req);
      return;
    }

    case 'response.image_generation_call.completed': {
      yield* completeTool(event.item_id ?? 'image_generation', 'success', state);
      return;
    }

    case 'response.output_text.annotation.added': {
      yield* annotationArtifact(event, state);
      return;
    }

    case 'response.output_item.done': {
      yield* handleItemDone(event.item, state, req);
      return;
    }

    case 'response.completed': {
      state.usage = responsesUsage(event.response?.usage);
      state.finishReason = 'stop';
      recordContainerIds(output, state);
      yield* sweepImages(output, state, req);
      return;
    }

    case 'response.incomplete': {
      state.usage = responsesUsage(event.response?.usage);
      state.finishReason =
        event.response?.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length';
      recordContainerIds(output, state);
      yield* sweepImages(output, state, req);
      return;
    }

    case 'response.failed': {
      state.finishReason = 'other';
      return;
    }

    default:
      return;
  }
}

export async function* executeResponses(
  req: NormalizedChatRequest,
  ctx: ExecuteContext,
  responses: NonNullable<OpenAIClientLike['responses']>,
): AsyncIterable<GenerationEvent> {
  let params: Record<string, unknown>;
  try {
    params = await buildResponsesRequest(req);
  } catch (err) {
    yield { type: 'error', error: translateError(err) };
    return;
  }

  let stream: AsyncIterable<unknown>;
  try {
    stream = await responses.create(params, { signal: ctx.signal });
  } catch (err) {
    yield { type: 'error', error: translateError(err) };
    return;
  }

  const state: ExecutionState = {
    started: false,
    textPartStarted: false,
    containerIds: new Set<string>(),
    emitted: new Set<string>(),
    emittedPartials: new Set<string>(),
    startedTools: new Set<string>(),
    completedTools: new Set<string>(),
    imageCount: 0,
    usage: undefined,
    finishReason: 'stop',
  };

  try {
    for await (const rawEvent of stream) {
      const event = rawEvent as RawResponsesEvent;
      yield* handleResponsesEvent(event, state, req);
      if (event.type === 'response.failed' || event.type === 'error') {
        yield { type: 'error', error: responsesError(event) };
        return;
      }
    }
  } catch (err) {
    yield { type: 'error', error: translateError(err) };
    return;
  }

  if (!state.started) {
    state.started = true;
    yield { type: 'started' };
  }

  yield* emitContainerArtifacts(req, state, ctx);

  if (state.textPartStarted) {
    yield { type: 'part_done', index: 0 };
  }
  if (state.usage !== undefined) {
    yield { type: 'usage', usage: state.usage, final: true };
  }
  yield { type: 'finished', reason: state.finishReason };
}
