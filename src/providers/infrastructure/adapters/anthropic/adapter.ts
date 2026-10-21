import Anthropic from '@anthropic-ai/sdk';
import type {
  NormalizedChatRequest,
  ProviderRuntimeConfig,
} from '@/providers/domain/capabilities.ts';
import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
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
  healthFailed,
  healthNotConfigured,
  isAbortLikeError,
  isTimeoutLikeError,
  numberFromConfig,
  parseRetryAfter,
  scrubSecrets,
} from '../shared.ts';
import { estimateClaudeInputTokens } from './tokenizer/claude-tokenizer.ts';

type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other';

export interface AnthropicClientLike {
  models: {
    list(
      params?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<{ data: readonly { id: string }[] }>;
  };
  messages: {
    create(params: unknown, options?: { signal?: AbortSignal }): Promise<AsyncIterable<unknown>>;
  };
}

export type AnthropicClientFactory = (options: {
  apiKey: string;
  baseURL?: string;
  timeout: number;
  maxRetries: number;
}) => AnthropicClientLike;

const defaultFactory: AnthropicClientFactory = (options) =>
  new Anthropic({
    apiKey: options.apiKey,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    timeout: options.timeout,
    maxRetries: options.maxRetries,
  });

/** Server-side code-execution tool identifier, overridable through provider config. */
const DEFAULT_CODE_EXECUTION_TOOL_TYPE = 'code_execution_20250825';

/** Hard cap on `pause_turn` continuations, so a provider cannot loop us forever. */
const MAX_PAUSE_TURNS = 8;

const DEFAULT_OUTPUT_DIR_ENV = 'OUTPUT_DIR';

/** Output directory instruction appended to system prompt when a container is active. */
function outputDirAddendum(envVar: string): string {
  return (
    `\n\nCRITICAL: Always copy or save all generated files (PDF, DOCX, XLSX, PPTX, images) ` +
    `directly into the directory specified by $${envVar} so they can be captured.`
  );
}

/** A content block in an outgoing message: text, an inline image, a document, a mount, a tool call. */
interface TextBlock {
  readonly type: 'text';
  readonly text: string;
}
interface ContainerUploadBlock {
  readonly type: 'container_upload';
  readonly file_id: string;
}
interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}
/** Base64 image block — the only way to send bytes we already hold (no URL to reference). */
interface ImageBlock {
  readonly type: 'image';
  readonly source: { readonly type: 'base64'; readonly media_type: string; readonly data: string };
}
/** Base64 PDF document block. Other formats must be converted to text (see `files` docs). */
interface DocumentBlock {
  readonly type: 'document';
  readonly source: {
    readonly type: 'base64';
    readonly media_type: 'application/pdf';
    readonly data: string;
  };
}
/** Provider block replayed verbatim on a pause_turn continuation. */
type ReplayBlock = { readonly type: string } & Record<string, unknown>;

type OutgoingBlock =
  TextBlock | ContainerUploadBlock | ToolUseBlock | ImageBlock | DocumentBlock | ReplayBlock;

interface OutgoingMessage {
  role: 'user' | 'assistant';
  content: string | OutgoingBlock[];
}

/** Merges consecutive turns with the same role into alternating message blocks. */
function mergeContent(
  left: OutgoingMessage['content'],
  right: OutgoingMessage['content'],
): OutgoingMessage['content'] {
  if (typeof left === 'string' && typeof right === 'string') return `${left}\n\n${right}`;
  const asBlocks = (content: OutgoingMessage['content']): OutgoingBlock[] =>
    typeof content === 'string' ? [{ type: 'text', text: content }] : [...content];
  return [...asBlocks(left), ...asBlocks(right)];
}

/** Replays paused response content verbatim on continuation. */
function replayContent(runState: RunState): string | OutgoingBlock[] {
  const blocks = runState.turnBlockOrder
    .map((index) => runState.turnBlocks.get(index))
    .filter((block): block is ReplayBlock => block !== undefined);
  return blocks.length > 0 ? blocks : ' ';
}

/** Mutable per-execution state for the streaming loop. */
interface RunState {
  readonly openBlocks: Set<number>;
  readonly toolBlocks: Map<number, { toolCallId: string; name: string }>;
  readonly blockTypes: Map<number, string>;
  readonly blockText: Map<number, string>;
  readonly toolInputJson: Map<number, string>;
  /** Raw blocks of the current turn, in arrival order — replayed on a `pause_turn` continuation. */
  readonly turnBlockOrder: number[];
  readonly turnBlocks: Map<number, ReplayBlock>;
  inputTokens: number;
  outputTokens: number;
  priorTurnsOutputTokens: number;
  cachedInputTokens: number | undefined;
  stopReason: string;
}

/** Recursively extracts generated file references from tool-result content. */
function extractGeneratedFiles(
  content: unknown,
): Array<{ fileId: string; filename: string; mimeType?: string; sizeBytes?: number }> {
  const found: Array<{ fileId: string; filename: string; mimeType?: string; sizeBytes?: number }> =
    [];

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = node as Record<string, unknown>;
    const fileId = record['file_id'];
    if (typeof fileId === 'string' && fileId.length > 0) {
      const filename =
        (typeof record['filename'] === 'string' && record['filename']) ||
        (typeof record['name'] === 'string' && record['name']) ||
        'generated-file';
      const mimeType = typeof record['mime_type'] === 'string' ? record['mime_type'] : undefined;
      const sizeBytes = typeof record['size_bytes'] === 'number' ? record['size_bytes'] : undefined;
      found.push({
        fileId,
        filename,
        ...(mimeType !== undefined ? { mimeType } : {}),
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      });
    }
    for (const value of Object.values(record)) visit(value);
  };

  visit(content);
  return found;
}

/** Extracts stdout/stderr strings from server tool-result block. */
function toolResultOutput(block: RawAnthropicStreamEvent['content_block']): {
  stdout?: string;
  stderr?: string;
} {
  const nested = block?.content;
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    const record = nested as Record<string, unknown>;
    const stdout = typeof record['stdout'] === 'string' ? record['stdout'] : undefined;
    const stderr = typeof record['stderr'] === 'string' ? record['stderr'] : undefined;
    if (stdout !== undefined || stderr !== undefined) {
      return {
        ...(stdout !== undefined ? { stdout } : {}),
        ...(stderr !== undefined ? { stderr } : {}),
      };
    }
  }
  return {
    ...(block?.stdout !== undefined ? { stdout: block.stdout } : {}),
    ...(block?.stderr !== undefined ? { stderr: block.stderr } : {}),
  };
}

interface RawAnthropicStreamEvent {
  readonly type: string;
  readonly index?: number;
  readonly message?: {
    readonly id?: string;
    readonly usage?: {
      readonly input_tokens?: number;
      readonly output_tokens?: number;
      readonly cache_read_input_tokens?: number;
      readonly cache_creation_input_tokens?: number;
    };
  };
  readonly content_block?: {
    readonly type?: string;
    readonly id?: string;
    readonly name?: string;
    readonly input?: unknown;
    readonly text?: string;
    readonly tool_use_id?: string;
    /** Tool-result payload: `bash_code_execution_result` nests `stdout`/`stderr`/`content[]`. */
    readonly content?: unknown;
    readonly stdout?: string;
    readonly stderr?: string;
  };
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly partial_json?: string;
    readonly stop_reason?: string | null;
  };
  readonly usage?: {
    readonly output_tokens?: number;
  };
  readonly error?: {
    readonly type?: string;
    readonly message?: string;
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly adapterKey = 'anthropic';

  constructor(private readonly clientFactory: AnthropicClientFactory = defaultFactory) {}

  toProviderRequest(req: NormalizedChatRequest, messages?: OutgoingMessage[]): unknown {
    const turns = messages ?? this.buildMessages(req);
    const system = this.buildSystem(req);
    const container = this.buildContainer(req);

    return {
      model: req.model.apiModelId,
      max_tokens: req.maxOutputTokens,
      ...(system !== undefined ? { system } : {}),
      messages: turns,
      stream: true,
      ...(typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(typeof req.topP === 'number' ? { top_p: req.topP } : {}),
      ...(container.tools !== undefined ? { tools: container.tools } : {}),
      ...(container.container !== undefined ? { container: container.container } : {}),
    };
  }

  /** Formats system prompt with output directory instructions when container is enabled. */
  private buildSystem(req: NormalizedChatRequest): string | undefined {
    const base = req.system !== undefined && req.system.trim().length > 0 ? req.system : undefined;
    if (!this.containerEnabled(req)) return base;
    const addendum = outputDirAddendum(req.container?.outputDirEnv ?? DEFAULT_OUTPUT_DIR_ENV);
    return base === undefined ? addendum.trimStart() : `${base}${addendum}`;
  }

  /** Attaches sandbox code execution tool and skills when document generation is requested. */
  private buildContainer(req: NormalizedChatRequest): {
    readonly tools?: readonly unknown[];
    readonly container?: unknown;
  } {
    if (!this.containerEnabled(req)) return {};
    const containerRequest = req.container;
    if (containerRequest === undefined) return {};

    const tools = [{ type: this.codeExecutionToolType(req.provider), name: 'code_execution' }];

    const skills = (containerRequest.skills ?? []).map((skillId) => ({
      type: 'anthropic' as const,
      skill_id: skillId,
      version: 'latest' as const,
    }));

    const container =
      containerRequest.containerId !== undefined
        ? {
            id: containerRequest.containerId,
            ...(skills.length > 0 ? { skills } : {}),
          }
        : skills.length > 0
          ? { skills }
          : undefined;

    return {
      tools,
      ...(container !== undefined ? { container } : {}),
    };
  }

  private containerEnabled(req: NormalizedChatRequest): boolean {
    const container = req.container;
    if (container === undefined) return false;
    return container.codeExecution || (container.skills?.length ?? 0) > 0;
  }

  private codeExecutionToolType(provider: ProviderRuntimeConfig): string {
    const configured = provider.config['codeExecutionToolType'];
    return typeof configured === 'string' && configured.length > 0
      ? configured
      : DEFAULT_CODE_EXECUTION_TOOL_TYPE;
  }

  /** Builds outgoing message turns, mounting container files on the final user turn. */
  private buildMessages(
    req: NormalizedChatRequest,
    media: readonly (readonly OutgoingBlock[])[] = [],
  ): OutgoingMessage[] {
    const messages: OutgoingMessage[] = [];
    const lastUserIndex = req.messages.reduce(
      (acc, message, index) => (message.role === 'user' ? index : acc),
      -1,
    );

    req.messages.forEach((message, index) => {
      const text = message.parts
        .filter((part) => part.type === 'text')
        .map((part) => (part as { text: string }).text)
        .join('');

      const mounts =
        index === lastUserIndex && message.role === 'user' && (req.inputFiles?.length ?? 0) > 0
          ? (req.inputFiles ?? [])
          : [];
      const inline = media[index] ?? [];

      let content: string | OutgoingBlock[];
      if (inline.length > 0 || mounts.length > 0) {
        // Inline media first (the docs' recommended order for vision), then the prompt, then the
        // container mounts.
        content = [
          ...inline,
          ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
          ...mounts.map((file) => ({
            type: 'container_upload' as const,
            file_id: file.providerFileId,
          })),
        ];
      } else {
        content = text.length > 0 ? text : ' ';
      }

      const last = messages[messages.length - 1];
      if (last !== undefined && last.role === message.role) {
        last.content = mergeContent(last.content, content);
      } else {
        messages.push({ role: message.role, content });
      }
    });

    if (messages.length === 0) {
      messages.push({ role: 'user', content: ' ' });
    } else if (messages[0]?.role === 'assistant') {
      messages.unshift({ role: 'user', content: ' ' });
    }

    return messages;
  }

  /** Resolves media blocks (base64 images and PDFs) for outbound messages. */
  private async resolveMediaBlocks(req: NormalizedChatRequest): Promise<OutgoingBlock[][]> {
    const perMessage: OutgoingBlock[][] = [];

    for (const message of req.messages) {
      const blocks: OutgoingBlock[] = [];
      for (const part of message.parts) {
        if (part.type === 'image') {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.file.mimeType,
              data: Buffer.from(await part.file.read()).toString('base64'),
            },
          });
          continue;
        }
        if (part.type !== 'document') continue;

        if (part.preferNative && part.file.mimeType === 'application/pdf') {
          blocks.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: Buffer.from(await part.file.read()).toString('base64'),
            },
          });
          continue;
        }

        if (part.extractedText !== undefined && part.extractedText.length > 0) {
          blocks.push({
            type: 'text',
            text: `<attached_document name="${part.file.name}" untrusted="true">\n${part.extractedText}\n</attached_document>`,
          });
        }
      }
      perMessage.push(blocks);
    }

    return perMessage;
  }

  async estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult> {
    return estimateClaudeInputTokens({
      ...(req.system !== undefined ? { system: req.system } : {}),
      messages: req.messages.map((message) => ({
        parts: message.parts.map((part) =>
          part.type === 'text' ? { type: 'text', text: part.text } : { type: part.type },
        ),
      })),
    });
  }

  async *execute(req: NormalizedChatRequest, ctx: ExecuteContext): AsyncIterable<GenerationEvent> {
    const apiKey = req.provider.secrets['apiKey'];
    if (!apiKey) {
      yield {
        type: 'error',
        error: providerError('provider_unavailable', 'Anthropic API key is not configured.', {
          retryable: false,
        }),
      };
      return;
    }

    const client = this.buildClient(req.provider, apiKey);
    // Bytes are read before the first request so a storage failure surfaces as an error event
    // rather than a half-started stream.
    let baseMessages: OutgoingMessage[];
    try {
      baseMessages = this.buildMessages(req, await this.resolveMediaBlocks(req));
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
      return;
    }
    const baseParams = this.toProviderRequest(req, baseMessages) as Record<string, unknown>;
    const runState = this.createRunState();

    // Multi-turn continuation: `pause_turn` means Claude paused a long container step and wants
    // another turn with the same assistant content appended (hard cap 8).
    let turn = 0;
    let messages = baseMessages;
    let providerStarted = false;

    while (turn <= MAX_PAUSE_TURNS) {
      // Each turn reports block indices from 0 again; keep only the request-wide counters.
      this.resetTurn(runState);

      let stream: AsyncIterable<unknown>;
      try {
        stream = await client.messages.create({ ...baseParams, messages }, { signal: ctx.signal });
      } catch (err) {
        yield { type: 'error', error: this.translateError(err) };
        return;
      }

      let paused = false;

      try {
        for await (const rawEvent of stream) {
          const ev = rawEvent as RawAnthropicStreamEvent;

          if (ev.type === 'error') {
            yield { type: 'error', error: this.translateError(ev.error ?? ev) };
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
            this.accumulateInputUsage(runState, ev);
          } else if (ev.type === 'content_block_start') {
            if (!providerStarted) {
              providerStarted = true;
              yield { type: 'started' };
            }
            yield* this.handleBlockStart(ev, runState);
          } else if (ev.type === 'content_block_delta') {
            if (!providerStarted) {
              providerStarted = true;
              yield { type: 'started' };
            }
            yield* this.handleBlockDelta(ev, runState);
          } else if (ev.type === 'content_block_stop') {
            yield* this.handleBlockStop(ev, runState);
          } else if (ev.type === 'message_delta') {
            if (ev.delta?.stop_reason !== undefined && ev.delta.stop_reason !== null) {
              runState.stopReason = ev.delta.stop_reason;
              if (ev.delta.stop_reason === 'pause_turn') paused = true;
            }
            if (ev.usage?.output_tokens !== undefined) {
              runState.outputTokens = runState.priorTurnsOutputTokens + ev.usage.output_tokens;
            }
          }
        }

        // Close any blocks the stream left open before the turn ended.
        for (const index of [...runState.openBlocks]) {
          yield { type: 'part_done', index };
          runState.openBlocks.delete(index);
        }
      } catch (err) {
        yield { type: 'error', error: this.translateError(err) };
        return;
      }

      if (!paused) break;
      turn += 1;
      if (turn > MAX_PAUSE_TURNS) {
        // Cap reached: surface the partial work rather than looping forever.
        runState.stopReason = 'pause_turn_exceeded';
        break;
      }
      messages = [
        ...messages,
        {
          role: 'assistant',
          content: replayContent(runState),
        },
      ];
      // A second pause would append a second assistant turn; fold it into the previous one
      // instead of sending two consecutive assistant messages.
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

    yield { type: 'finished', reason: this.mapFinishReason(runState.stopReason) };
  }

  private createRunState(): RunState {
    return {
      openBlocks: new Set<number>(),
      toolBlocks: new Map<number, { toolCallId: string; name: string }>(),
      blockTypes: new Map<number, string>(),
      blockText: new Map<number, string>(),
      toolInputJson: new Map<number, string>(),
      turnBlockOrder: [],
      turnBlocks: new Map<number, ReplayBlock>(),
      inputTokens: 0,
      outputTokens: 0,
      priorTurnsOutputTokens: 0,
      cachedInputTokens: undefined,
      stopReason: 'end_turn',
    };
  }

  /** Clears per-turn state. Block indices restart at 0 for every request in the pause loop. */
  private resetTurn(runState: RunState): void {
    runState.priorTurnsOutputTokens = runState.outputTokens;
    runState.openBlocks.clear();
    runState.toolBlocks.clear();
    runState.blockTypes.clear();
    runState.blockText.clear();
    runState.toolInputJson.clear();
    runState.turnBlockOrder.length = 0;
    runState.turnBlocks.clear();
  }

  private accumulateInputUsage(runState: RunState, ev: RawAnthropicStreamEvent): void {
    const uncached = ev.message?.usage?.input_tokens ?? 0;
    const cacheRead = ev.message?.usage?.cache_read_input_tokens ?? 0;
    const cacheCreation = ev.message?.usage?.cache_creation_input_tokens ?? 0;
    runState.inputTokens += uncached + cacheRead + cacheCreation;
    if (cacheRead > 0) runState.cachedInputTokens = cacheRead;
  }

  /** `content_block_start`: text blocks open a part; tool blocks announce tool activity. */
  private *handleBlockStart(
    ev: RawAnthropicStreamEvent,
    runState: RunState,
  ): Iterable<GenerationEvent> {
    const index = ev.index ?? 0;
    const blockType = ev.content_block?.type ?? 'text';
    runState.openBlocks.add(index);
    runState.blockTypes.set(index, blockType);

    // Keep the raw block so a `pause_turn` continuation can replay it verbatim.
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

    // A server tool result arrives whole (no deltas) — mine it for generated files.
    if (blockType.endsWith('_tool_result')) {
      yield* this.handleToolResult(ev, blockType);
      return;
    }

    // Anything else with a tool-ish type is a tool invocation.
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

  /** `content_block_delta`: text deltas stream to the client; tool stdout becomes tool_delta. */
  private *handleBlockDelta(
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

    if (ev.delta?.type === 'input_json_delta' && ev.delta.partial_json !== undefined) {
      runState.toolInputJson.set(
        index,
        (runState.toolInputJson.get(index) ?? '') + ev.delta.partial_json,
      );
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
        // Non-text blocks (e.g. thinking) never become message text.
        yield {
          type: 'tool_delta',
          toolCallId: this.toolCallIdFor(runState, index),
          delta: ev.delta.text,
        };
      }
    }
  }

  /** `content_block_stop`: finalize the part or the tool invocation. */
  private *handleBlockStop(
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

    const tool = runState.toolBlocks.get(index);
    if (tool !== undefined) {
      const rawJson = runState.toolInputJson.get(index) ?? '';
      const parsed = this.parseToolInput(rawJson);
      const block = runState.turnBlocks.get(index);
      if (block !== undefined && parsed !== undefined) block['input'] = parsed;
      yield { type: 'tool_completed', toolCallId: tool.toolCallId, status: 'success' };
    }
  }

  /** Processes tool-result events, extracting output chunks and generated file references. */
  private *handleToolResult(
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

  private toolCallIdFor(runState: RunState, index: number): string {
    return runState.toolBlocks.get(index)?.toolCallId ?? `tool-${index}`;
  }

  private parseToolInput(rawJson: string): unknown {
    if (rawJson.length === 0) return undefined;
    try {
      return JSON.parse(rawJson) as unknown;
    } catch {
      return undefined;
    }
  }

  private mapFinishReason(reason: string): FinishReason {
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
        // `pause_turn` (and our `pause_turn_exceeded` cap marker) surface as `other`; the
        // orchestrator's own finish-reason vocabulary has no dedicated pause state.
        return 'other';
    }
  }

  translateError(err: unknown): ProviderError {
    if (err instanceof Anthropic.APIError) {
      const status = err.status;
      const rawMsg = err.message ?? '';
      const sanitized = scrubSecrets(rawMsg);

      let retryAfterMs: number | undefined;
      const headers = err.headers;
      if (headers) {
        const headerVal =
          typeof (headers as { get?: (k: string) => string | null }).get === 'function'
            ? (headers as { get: (k: string) => string | null }).get('retry-after')
            : (headers as Record<string, string>)['retry-after'];
        retryAfterMs = parseRetryAfter(headerVal);
      }

      const errType = (err as { error?: { type?: string } }).error?.type;

      if (status === 400) {
        const isContext =
          rawMsg.includes('prompt is too long') ||
          rawMsg.includes('max_tokens') ||
          rawMsg.includes('context window');
        return providerError(
          isContext ? 'context_too_large' : 'invalid_request',
          isContext
            ? 'The conversation exceeds the model context window.'
            : 'The model provider rejected the request.',
          {
            retryable: false,
            internalMessage: sanitized,
            providerStatus: status,
            ...(errType ? { providerCode: errType } : {}),
          },
        );
      }

      if (status === 401 || status === 403) {
        return providerError(
          'provider_unavailable',
          'The model provider rejected authentication.',
          {
            retryable: false,
            internalMessage: sanitized,
            providerStatus: status,
            ...(errType ? { providerCode: errType } : {}),
          },
        );
      }

      if (status === 404) {
        return providerError(
          'model_unavailable',
          'The requested model is not available from the provider.',
          {
            retryable: false,
            internalMessage: sanitized,
            providerStatus: status,
            ...(errType ? { providerCode: errType } : {}),
          },
        );
      }

      if (status === 413) {
        return providerError('context_too_large', 'The request exceeds the provider size limits.', {
          retryable: false,
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        });
      }

      if (status === 402) {
        // Billing problems never fix themselves within a retry window.
        return providerError(
          'provider_unavailable',
          'The model provider rejected the request for billing reasons.',
          {
            retryable: false,
            internalMessage: sanitized,
            providerStatus: status,
            ...(errType ? { providerCode: errType } : {}),
          },
        );
      }

      if (status === 408 || status === 504) {
        return providerError('generation_timeout', 'The model provider timed out.', {
          retryable: true,
          internalMessage: sanitized,
          providerStatus: status,
          ...(errType ? { providerCode: errType } : {}),
        });
      }

      if (status === 429) {
        return providerError(
          'provider_rate_limited',
          'The model provider is rate limiting requests.',
          {
            retryable: true,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            internalMessage: sanitized,
            providerStatus: status,
            ...(errType ? { providerCode: errType } : {}),
          },
        );
      }

      if (status === 529 || errType === 'overloaded_error') {
        return providerError('service_busy', 'The model provider is temporarily overloaded.', {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          internalMessage: sanitized,
          providerStatus: status,
          providerCode: errType ?? 'overloaded_error',
        });
      }

      if (status >= 500) {
        return providerError(
          'provider_unavailable',
          'The model provider is temporarily unavailable.',
          {
            retryable: true,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            internalMessage: sanitized,
            providerStatus: status,
            ...(errType ? { providerCode: errType } : {}),
          },
        );
      }
    }

    if (typeof err === 'object' && err !== null) {
      const maybeErr = err as {
        type?: string;
        message?: string;
        error?: { type?: string; message?: string };
        status?: number;
      };
      const errType = maybeErr.error?.type ?? maybeErr.type;
      const rawMsg = maybeErr.error?.message ?? maybeErr.message ?? '';
      const sanitized = scrubSecrets(rawMsg);

      if (errType === 'overloaded_error' || maybeErr.status === 529) {
        return providerError('service_busy', 'The model provider is temporarily overloaded.', {
          retryable: true,
          internalMessage: sanitized,
          providerCode: 'overloaded_error',
          ...(maybeErr.status ? { providerStatus: maybeErr.status } : {}),
        });
      }

      if (errType === 'rate_limit_error') {
        return providerError(
          'provider_rate_limited',
          'The model provider is rate limiting requests.',
          {
            retryable: true,
            internalMessage: sanitized,
            providerCode: errType,
            ...(maybeErr.status ? { providerStatus: maybeErr.status } : {}),
          },
        );
      }

      if (errType === 'invalid_request_error') {
        return providerError('invalid_request', 'The model provider rejected the request.', {
          retryable: false,
          internalMessage: sanitized,
          providerCode: errType,
          ...(maybeErr.status ? { providerStatus: maybeErr.status } : {}),
        });
      }
    }

    const errMsg = err instanceof Error ? scrubSecrets(err.message) : 'unknown_error';

    if (isAbortLikeError(err, [Anthropic.APIUserAbortError])) {
      return providerError('generation_cancelled', 'The generation was cancelled.', {
        retryable: false,
      });
    }

    if (isTimeoutLikeError(err, [Anthropic.APIConnectionTimeoutError])) {
      return providerError('generation_timeout', 'The model provider timed out.', {
        retryable: true,
        internalMessage: errMsg,
      });
    }

    return providerError('provider_unavailable', 'The model provider is unavailable.', {
      retryable: true,
      internalMessage: errMsg,
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
      const client = this.buildClient(provider, apiKey);
      const result = await client.models.list(undefined, { signal });
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        detail: `models.list ok (${result.data.length})`,
      };
    } catch (error) {
      return healthFailed(error, Date.now() - startedAt);
    }
  }

  private buildClient(provider: ProviderRuntimeConfig, apiKey: string): AnthropicClientLike {
    return this.clientFactory({
      apiKey,
      ...(provider.baseUrl !== undefined ? { baseURL: provider.baseUrl } : {}),
      timeout: numberFromConfig(provider.config, 'timeoutMs', 60_000),
      maxRetries: numberFromConfig(provider.config, 'maxRetries', 1),
    });
  }

  /** Downloads a provider-generated file via the Files API for storage hydration. */
  async fetchArtifactStream(
    providerFileId: string,
    ctx: FilesApiContext,
  ): Promise<ProviderArtifact> {
    const apiKey = ctx.provider.secrets['apiKey'];
    if (apiKey === undefined || apiKey === '') {
      throw providerError('provider_unavailable', 'Anthropic API key is not configured.', {
        retryable: false,
      });
    }

    const response = await fetch(
      `${this.apiBase(ctx.provider)}/v1/files/${encodeURIComponent(providerFileId)}/content`,
      { headers: this.filesHeaders(ctx.provider, apiKey), signal: ctx.signal },
    );

    if (!response.ok || response.body === null) {
      throw providerError('provider_unavailable', 'Could not download the generated file.', {
        retryable: response.status >= 500 || response.status === 429,
        providerStatus: response.status,
      });
    }

    const contentType = response.headers.get('content-type');
    const contentLength = response.headers.get('content-length');
    const sizeBytes =
      contentLength !== null && Number.isFinite(Number(contentLength))
        ? Number(contentLength)
        : undefined;

    return {
      stream: response.body as ReadableStream<Uint8Array>,
      ...(contentType !== null ? { mimeType: contentType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    };
  }

  /** Uploads an input binary to the Files API for container mounting. */
  async uploadInputFile(file: InputFileUpload, ctx: FilesApiContext): Promise<UploadedInputFile> {
    const apiKey = ctx.provider.secrets['apiKey'];
    if (apiKey === undefined || apiKey === '') {
      throw providerError('provider_unavailable', 'Anthropic API key is not configured.', {
        retryable: false,
      });
    }

    const form = new FormData();
    form.append('file', new Blob([file.bytes], { type: file.mimeType }), file.filename);

    const response = await fetch(`${this.apiBase(ctx.provider)}/v1/files`, {
      method: 'POST',
      headers: this.filesHeaders(ctx.provider, apiKey),
      body: form,
      signal: ctx.signal,
    });

    if (!response.ok) {
      throw providerError('provider_unavailable', 'Could not upload the input file.', {
        retryable: response.status >= 500 || response.status === 429,
        providerStatus: response.status,
      });
    }

    const payload = (await response.json()) as { id?: unknown };
    if (typeof payload.id !== 'string' || payload.id.length === 0) {
      throw providerError('provider_unavailable', 'The provider did not return a file id.', {
        retryable: true,
      });
    }

    return { providerFileId: payload.id };
  }

  private apiBase(provider: ProviderRuntimeConfig): string {
    return provider.baseUrl !== undefined && provider.baseUrl !== ''
      ? provider.baseUrl.replace(/\/$/, '')
      : 'https://api.anthropic.com';
  }

  private filesHeaders(provider: ProviderRuntimeConfig, apiKey: string): Record<string, string> {
    const version = provider.config['anthropicVersion'];
    const beta = provider.config['anthropicBeta'];
    const betaHeader = Array.isArray(beta)
      ? beta.filter((v): v is string => typeof v === 'string').join(',')
      : typeof beta === 'string'
        ? beta
        : '';
    return {
      'x-api-key': apiKey,
      'anthropic-version': typeof version === 'string' && version !== '' ? version : '2023-06-01',
      ...(betaHeader !== '' ? { 'anthropic-beta': betaHeader } : {}),
    };
  }
}
