import type {
  ModelCapabilities,
  ModelRuntimeConfig,
  NormalizedChatRequest,
  NormalizedMessage,
  NormalizedPart,
  ProviderRuntimeConfig,
  ReasoningEffort,
} from '@/providers/index.ts';
import { imageToolSupported } from '@/providers/index.ts';
import type { MessagePart, MessageWithParts } from '@/conversations/domain/conversation.ts';
import { estimateMediaTokens, estimateTextTokens } from '@/estimation.ts';
import { AppError } from '@/errors.ts';

/** Builds normalized chat request from history, truncating oldest turns when exceeding budget. */

export interface ContextBuilderInput {
  readonly requestId: string;
  readonly generationId: string;
  readonly model: ModelRuntimeConfig;
  readonly provider: ProviderRuntimeConfig;
  readonly platformSystemPrompt?: string;
  readonly newParts: readonly NormalizedPart[];
  readonly history: readonly MessageWithParts[];
  readonly maxOutputTokensOverride?: number;
  readonly userIdHash: string;
  /** Client opted into image output for this turn. */
  readonly imageGeneration?: boolean;
  /** Reasoning depth for this turn; the caller has already checked it against the model. */
  readonly reasoningEffort?: ReasoningEffort | undefined;
  /**
   * Raw model tokens the user can still afford this period. When it is smaller than the model
   * window, history is trimmed to fit it (sliding-window fallback).
   */
  readonly userRemainingQuota?: number | null | undefined;
}

export interface TruncationInfo {
  readonly truncated: boolean;
  readonly droppedMessageCount: number;
  readonly compactedMessageCount: number;
  readonly totalHistoryCount: number;
  /** Why history was dropped: the model window or the user's remaining quota. */
  readonly reason: TruncationReason;
}

export type TruncationReason = 'none' | 'context_window' | 'quota';

export interface BuildContextResult {
  readonly request: NormalizedChatRequest;
  readonly truncation: TruncationInfo;
  readonly estimatedTokens: number;
}

export function buildContext(input: ContextBuilderInput): BuildContextResult {
  const { model, provider, platformSystemPrompt, newParts, history } = input;
  const capabilities: ModelCapabilities = model.capabilities;

  const maxOutputTokens = input.maxOutputTokensOverride ?? model.defaultMaxOutputTokens;
  const safetyMargin = Math.max(1000, Math.floor(capabilities.contextWindow * 0.03));
  const modelInputBudget = capabilities.contextWindow - maxOutputTokens - safetyMargin;

  if (modelInputBudget <= 0) {
    throw new AppError(
      'context_too_large',
      'Context window too small for requested output and safety margin.',
    );
  }

  // Sliding-window fallback: when the user cannot afford the full transcript, history is trimmed
  // to the affordable size instead of failing the request outright.
  const quotaInputBudget =
    input.userRemainingQuota === undefined || input.userRemainingQuota === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, input.userRemainingQuota - maxOutputTokens);
  const historyBudget = Math.min(modelInputBudget, quotaInputBudget);

  const systemAddendum =
    typeof model.config['systemAddendum'] === 'string' ? model.config['systemAddendum'] : undefined;
  const systemParts: string[] = [];
  if (platformSystemPrompt && platformSystemPrompt.trim().length > 0) {
    systemParts.push(platformSystemPrompt.trim());
  }
  if (systemAddendum && systemAddendum.trim().length > 0) {
    systemParts.push(systemAddendum.trim());
  }
  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

  const systemTokens = systemPrompt ? estimateTextTokens(systemPrompt) : 0;

  let newUserTokens = 8;
  for (const part of newParts) {
    if (part.type === 'text') {
      newUserTokens += estimateTextTokens(part.text);
    } else {
      newUserTokens += estimateMediaTokens(part);
    }
  }

  if (systemTokens + newUserTokens > modelInputBudget) {
    throw new AppError('context_too_large', 'Prompt and new message exceed model context window.');
  }

  let budgetRemaining = historyBudget - systemTokens - newUserTokens;
  const compactionEnabled = capabilities.compaction !== undefined;

  const selectedHistory: NormalizedMessage[] = [];
  let droppedMessageCount = 0;
  let compactedMessageCount = 0;
  const totalHistoryCount = history.length;
  let expectedRole: 'user' | 'assistant' = 'assistant';

  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (!item) continue;

    if (item.message.role === 'assistant' && item.message.status !== 'complete') {
      droppedMessageCount++;
      if (expectedRole === 'assistant') {
        expectedRole = 'user';
      }
      continue;
    }

    if (item.message.role !== expectedRole) {
      droppedMessageCount++;
      continue;
    }

    const compactionPart = compactionEnabled
      ? item.parts.find((part) => part.type === 'compaction')
      : undefined;
    const isCompactionAnchor = compactionPart !== undefined;

    const historyParts: NormalizedPart[] = [];
    for (const p of item.parts) {
      if (p.type === 'text') {
        historyParts.push({ type: 'text', text: p.textContent ?? '' });
      } else if (p.type === 'document') {
        const text =
          p.textContent ??
          (typeof p.data['extractedText'] === 'string' ? p.data['extractedText'] : null);
        if (text) {
          const fileName = typeof p.data['filename'] === 'string' ? p.data['filename'] : 'document';
          historyParts.push({
            type: 'document',
            file: {
              fileId: p.fileId ?? p.id,
              name: fileName,
              mimeType: 'text/plain',
              sizeBytes: Buffer.byteLength(text, 'utf-8'),
              read: () => Promise.resolve(Buffer.from(text, 'utf-8')),
              stream: () =>
                Promise.resolve(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(Buffer.from(text, 'utf-8'));
                      controller.close();
                    },
                  }),
                ),
            },
            extractedText: text,
            preferNative: false,
          });
        }
      }
    }
    const messageText = extractPartsText(historyParts);
    const compactionTokens = isCompactionAnchor ? estimateCompactionTokens(compactionPart) : 0;
    const msgTokens = estimateTextTokens(messageText) + 8 + compactionTokens;

    // The compaction block anchors the transcript: everything older is already summarized, so
    // the walk stops here.
    // If the compaction anchor cannot fit in the model's context window, fail cleanly with context_too_large.
    // When quota is the binding limit, keeping it could make the request unaffordable, so the
    // sliding window wins and the block is dropped like any other turn.
    const anchorRequired = isCompactionAnchor && quotaInputBudget >= modelInputBudget;
    if (anchorRequired && budgetRemaining < msgTokens) {
      throw new AppError(
        'context_too_large',
        'Prompt, new message, and compacted history exceed model context window.',
      );
    }
    if (budgetRemaining >= msgTokens) {
      budgetRemaining -= msgTokens;
      const normalizedParts: NormalizedPart[] = [];
      if (isCompactionAnchor) {
        const partProvider = String(compactionPart.data['provider'] ?? provider.key);
        if (partProvider === provider.key) {
          normalizedParts.push({
            type: 'compaction',
            provider: partProvider,
            payload: compactionPart.data['payload'],
          });
        } else {
          // Cross-provider conversion: if the summary is readable text (Anthropic), provide it as text;
          // if it is an opaque provider token (OpenAI), it cannot be replayed on a different provider.
          const payload = compactionPart.data['payload'];
          const summary =
            typeof payload === 'object' && payload !== null && 'content' in payload
              ? String((payload as { content: unknown }).content)
              : '';
          if (summary.length > 0) {
            normalizedParts.push({
              type: 'text',
              text: `[Previous conversation summary]:\n${summary}`,
            });
          }
        }
      }
      if (messageText.length > 0) {
        normalizedParts.push({ type: 'text', text: messageText });
      }
      selectedHistory.unshift({
        role: item.message.role,
        parts: normalizedParts.length > 0 ? normalizedParts : [{ type: 'text', text: ' ' }],
      });
      if (isCompactionAnchor) {
        compactedMessageCount += i;
        break;
      }
      expectedRole = expectedRole === 'assistant' ? 'user' : 'assistant';
    } else {
      droppedMessageCount += i + 1;
      break;
    }
  }

  const firstSelected = selectedHistory[0];
  const isCompactionFirst =
    firstSelected?.parts[0]?.type === 'compaction' ||
    (firstSelected?.parts[0]?.type === 'text' &&
      firstSelected.parts[0].text.startsWith('[Previous conversation summary]'));
  if (
    firstSelected !== undefined &&
    firstSelected.role === 'assistant' &&
    !isCompactionFirst
  ) {
    selectedHistory.shift();
    droppedMessageCount++;
  }

  const normalizedMessages: NormalizedMessage[] = [
    ...selectedHistory,
    { role: 'user', parts: newParts },
  ];

  const estimatedTokens = historyBudget - budgetRemaining;

  const request: NormalizedChatRequest = {
    requestId: input.requestId,
    generationId: input.generationId,
    model,
    provider,
    ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
    messages: normalizedMessages,
    maxOutputTokens,
    responseModalities:
      input.imageGeneration === true && imageToolSupported(capabilities)
        ? ['text', 'image']
        : ['text'],
    ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
    metadata: { userIdHash: input.userIdHash },
  };

  return {
    request,
    truncation: {
      truncated: droppedMessageCount > 0,
      droppedMessageCount,
      compactedMessageCount,
      totalHistoryCount,
      reason: truncationReason(droppedMessageCount, quotaInputBudget, modelInputBudget),
    },
    estimatedTokens,
  };
}

function truncationReason(
  droppedMessageCount: number,
  quotaInputBudget: number,
  modelInputBudget: number,
): TruncationReason {
  if (droppedMessageCount === 0) return 'none';
  return quotaInputBudget < modelInputBudget ? 'quota' : 'context_window';
}

/** Compaction payloads are opaque; their length is the only portable signal available. */
function estimateCompactionTokens(part: MessagePart): number {
  try {
    return estimateTextTokens(JSON.stringify(part.data['payload'] ?? ''));
  } catch {
    return 2000;
  }
}

function extractPartsText(parts: readonly NormalizedPart[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      texts.push(part.text);
    } else if (part.type === 'document' && part.extractedText) {
      texts.push(
        `<attached_document name="${part.file.name}" untrusted="true">\n${part.extractedText}\n</attached_document>`,
      );
    }
  }
  return texts.join('\n\n');
}
