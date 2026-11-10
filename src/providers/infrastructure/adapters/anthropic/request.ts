import type {
  NormalizedChatRequest,
  ProviderRuntimeConfig,
} from '@/providers/domain/capabilities.ts';
import {
  COMPACTION_EDIT_TYPE,
  DEFAULT_CODE_EXECUTION_TOOL_TYPE,
  DEFAULT_OUTPUT_DIR_ENV,
  MIN_COMPACTION_TRIGGER,
  MIN_THINKING_BUDGET,
  THINKING_BUDGETS,
  isModernEffortModel,
  outputDirAddendum,
} from './config.ts';
import { resolveAnthropicVersion } from './client.ts';
import type {
  CompactionBlock,
  OutgoingBlock,
  OutgoingMessage,
  ReplayBlock,
  RunState,
} from './types.ts';

export function mergeContent(
  left: OutgoingMessage['content'],
  right: OutgoingMessage['content'],
): OutgoingMessage['content'] {
  if (typeof left === 'string' && typeof right === 'string') return `${left}\n\n${right}`;
  const asBlocks = (content: OutgoingMessage['content']): OutgoingBlock[] =>
    typeof content === 'string' ? [{ type: 'text', text: content }] : [...content];
  return [...asBlocks(left), ...asBlocks(right)];
}

export function compactionBlock(part: { readonly payload: unknown }): CompactionBlock {
  const payload =
    typeof part.payload === 'object' && part.payload !== null
      ? (part.payload as Record<string, unknown>)
      : {};
  return {
    type: 'compaction',
    content: typeof payload['content'] === 'string' ? payload['content'] : '',
    ...(typeof payload['signature'] === 'string' && payload['signature'] !== ''
      ? { signature: payload['signature'] }
      : {}),
  };
}

export function replayContent(runState: RunState): string | OutgoingBlock[] {
  const blocks = runState.turnBlockOrder
    .map((index) => runState.turnBlocks.get(index))
    .filter((block): block is ReplayBlock => block !== undefined);
  return blocks.length > 0 ? blocks : ' ';
}

export function compactionEdit(
  req: NormalizedChatRequest,
): { readonly edits: readonly unknown[] } | undefined {
  const hasCompactionMessage = req.messages.some((m) =>
    m.parts.some((p) => p.type === 'compaction'),
  );
  if (hasCompactionMessage) return undefined;
  if (req.model.capabilities.compaction === undefined) return undefined;
  const window = req.model.capabilities.contextWindow;
  if (window < MIN_COMPACTION_TRIGGER * 2) return undefined;
  const configured = req.model.capabilities.compaction.triggerTokens;
  const trigger = Math.min(
    window - 1,
    Math.max(MIN_COMPACTION_TRIGGER, configured ?? Math.floor(window * 0.8)),
  );
  return {
    edits: [{ type: COMPACTION_EDIT_TYPE, trigger: { type: 'input_tokens', value: trigger } }],
  };
}

export function buildThinking(
  req: NormalizedChatRequest,
): { readonly type: 'enabled'; readonly budget_tokens: number } | undefined {
  const effort = req.reasoningEffort;
  if (effort === undefined) return undefined;
  const budget = Math.min(THINKING_BUDGETS[effort], req.maxOutputTokens - MIN_THINKING_BUDGET);
  if (budget < MIN_THINKING_BUDGET) return undefined;
  return { type: 'enabled', budget_tokens: budget };
}

export function buildSystem(req: NormalizedChatRequest): string | undefined {
  const base = req.system !== undefined && req.system.trim().length > 0 ? req.system : undefined;
  if (!containerEnabled(req)) return base;
  const addendum = outputDirAddendum(req.container?.outputDirEnv ?? DEFAULT_OUTPUT_DIR_ENV);
  return base === undefined ? addendum.trimStart() : `${base}${addendum}`;
}

export function buildContainer(req: NormalizedChatRequest): {
  readonly tools?: readonly unknown[];
  readonly container?: unknown;
} {
  if (!containerEnabled(req)) return {};
  const containerRequest = req.container;
  if (containerRequest === undefined) return {};

  const tools = [{ type: codeExecutionToolType(req.provider), name: 'code_execution' }];

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

export function containerEnabled(req: NormalizedChatRequest): boolean {
  const container = req.container;
  if (container === undefined) return false;
  return container.codeExecution || (container.skills?.length ?? 0) > 0;
}

export function codeExecutionToolType(provider: ProviderRuntimeConfig): string {
  const configured = provider.config['codeExecutionToolType'];
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : DEFAULT_CODE_EXECUTION_TOOL_TYPE;
}

export function buildMessages(
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
    const compaction = message.parts.find((part) => part.type === 'compaction');

    let content: string | OutgoingBlock[];
    if (compaction !== undefined) {
      content = [
        compactionBlock(compaction),
        ...(text.length > 0 ? [{ type: 'text' as const, text }] : []),
      ];
    } else if (inline.length > 0 || mounts.length > 0) {
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
  } else {
    const first = messages[0];
    const startsWithCompaction =
      first !== undefined &&
      Array.isArray(first.content) &&
      first.content[0]?.type === 'compaction';
    if (first?.role === 'assistant' && !startsWithCompaction) {
      messages.unshift({ role: 'user', content: ' ' });
    }
  }

  return messages;
}

export function isPromptCachingEnabled(req: NormalizedChatRequest): boolean {
  if (req.model.config['promptCaching'] === false) return false;
  if (req.provider.config['promptCaching'] === false) return false;
  return req.model.capabilities.promptCaching?.supported === true;
}

export function toProviderRequest(
  req: NormalizedChatRequest,
  messages?: OutgoingMessage[],
): unknown {
  const turns = messages ?? buildMessages(req);
  const system = buildSystem(req);
  const container = buildContainer(req);
  const isModern = isModernEffortModel(req.model.apiModelId);
  const effort = req.reasoningEffort;
  const thinking = isModern
    ? effort !== undefined
      ? { type: 'adaptive' as const }
      : undefined
    : buildThinking(req);
  const outputConfig = isModern && effort !== undefined ? { effort } : undefined;
  const compaction = compactionEdit(req);
  const cachingEnabled = isPromptCachingEnabled(req);
  const version = resolveAnthropicVersion(req.provider);
  const isLegacyVersion = version !== '2026-10-21';
  const sampling = isLegacyVersion && !isModern && thinking === undefined;

  return {
    model: req.model.apiModelId,
    max_tokens: req.maxOutputTokens,
    ...(cachingEnabled ? { cache_control: { type: 'ephemeral' as const } } : {}),
    ...(system !== undefined ? { system } : {}),
    messages: turns,
    stream: true,
    ...(sampling && typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(sampling && typeof req.topP === 'number' ? { top_p: req.topP } : {}),
    ...(container.tools !== undefined ? { tools: container.tools } : {}),
    ...(container.container !== undefined ? { container: container.container } : {}),
    ...(outputConfig !== undefined ? { output_config: outputConfig } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(compaction !== undefined ? { context_management: compaction } : {}),
  };
}
