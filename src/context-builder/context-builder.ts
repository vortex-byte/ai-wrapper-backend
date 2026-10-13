import type {
  ModelCapabilities,
  ModelRuntimeConfig,
  NormalizedChatRequest,
  NormalizedMessage,
  NormalizedPart,
  ProviderRuntimeConfig,
} from '@/providers/index.ts';
import type { MessageWithParts } from '@/conversations/domain/conversation.ts';
import { estimateTextTokens } from '@/estimation.ts';
import { AppError } from '@/errors.ts';

/**
 * Context Builder.
 * Transforms conversation history and system instructions into a `NormalizedChatRequest`.
 *
 * Algorithm:
 * 1. Calculate available input budget:
 *    available = contextWindow - maxOutputTokens - max(1000, 0.03 * contextWindow)
 * 2. System prompt concatenation:
 *    Platform policy prompt (system_settings) + model addendum (model.config.systemAddendum)
 * 3. Include system prompt and new user message. If this exceeds available budget -> throw context_too_large.
 * 4. Walk history newest -> oldest in pairs/messages, adding to context while within budget.
 * 5. Drop older messages in blocks (~20% of budget) if necessary to preserve prompt cache efficiency.
 * 6. Record truncation details if any history was dropped.
 */

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
}

export interface TruncationInfo {
  readonly truncated: boolean;
  readonly droppedMessageCount: number;
  readonly totalHistoryCount: number;
}

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
  const availableInputTokens = capabilities.contextWindow - maxOutputTokens - safetyMargin;

  if (availableInputTokens <= 0) {
    throw new AppError('context_too_large', 'Context window too small for requested output and safety margin.');
  }

  const systemAddendum = typeof model.config['systemAddendum'] === 'string' ? model.config['systemAddendum'] : undefined;
  const systemParts: string[] = [];
  if (platformSystemPrompt && platformSystemPrompt.trim().length > 0) {
    systemParts.push(platformSystemPrompt.trim());
  }
  if (systemAddendum && systemAddendum.trim().length > 0) {
    systemParts.push(systemAddendum.trim());
  }
  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;

  const systemTokens = systemPrompt ? estimateTextTokens(systemPrompt) : 0;

  const newUserText = extractPartsText(newParts);
  const newUserTokens = estimateTextTokens(newUserText) + 8;

  if (systemTokens + newUserTokens > availableInputTokens) {
    throw new AppError('context_too_large', 'Prompt and new message exceed model context window.');
  }

  let budgetRemaining = availableInputTokens - systemTokens - newUserTokens;

  const selectedHistory: NormalizedMessage[] = [];
  let droppedMessageCount = 0;
  const totalHistoryCount = history.length;
  let expectedRole: 'user' | 'assistant' = 'assistant';

  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (!item) continue;

    // Skip incomplete or failed assistant messages. Since this assistant turn is skipped,
    // the preceding message in history is a user message (PRD §10.3).
    if (item.message.role === 'assistant' && item.message.status !== 'complete') {
      droppedMessageCount++;
      if (expectedRole === 'assistant') {
        expectedRole = 'user';
      }
      continue;
    }

    // Role must alternate (ending with assistant before the new user message)
    if (item.message.role !== expectedRole) {
      droppedMessageCount++;
      continue;
    }

    const messageText = extractPartsText(
      item.parts.map((p) => {
        if (p.type === 'text') {
          return { type: 'text', text: p.textContent ?? '' };
        }
        return { type: 'text', text: '' };
      }),
    );
    const msgTokens = estimateTextTokens(messageText) + 8;

    if (budgetRemaining >= msgTokens) {
      budgetRemaining -= msgTokens;
      selectedHistory.unshift({
        role: item.message.role,
        parts: [{ type: 'text', text: messageText }],
      });
      expectedRole = expectedRole === 'assistant' ? 'user' : 'assistant';
    } else {
      droppedMessageCount += i + 1;
      break;
    }
  }

  // Conversation history must start with a user message
  if (selectedHistory.length > 0 && selectedHistory[0]?.role === 'assistant') {
    selectedHistory.shift();
    droppedMessageCount++;
  }

  const normalizedMessages: NormalizedMessage[] = [
    ...selectedHistory,
    { role: 'user', parts: newParts },
  ];

  const estimatedTokens = availableInputTokens - budgetRemaining;

  const request: NormalizedChatRequest = {
    requestId: input.requestId,
    generationId: input.generationId,
    model,
    provider,
    ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
    messages: normalizedMessages,
    maxOutputTokens,
    responseModalities: ['text'],
    metadata: { userIdHash: input.userIdHash },
  };

  return {
    request,
    truncation: {
      truncated: droppedMessageCount > 0,
      droppedMessageCount,
      totalHistoryCount,
    },
    estimatedTokens,
  };
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
