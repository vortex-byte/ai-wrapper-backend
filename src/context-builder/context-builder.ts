import type {
  ModelCapabilities,
  ModelRuntimeConfig,
  NormalizedChatRequest,
  NormalizedMessage,
  NormalizedPart,
  ProviderRuntimeConfig,
} from '@/providers/index.ts';
import type { MessageWithParts } from '@/conversations/domain/conversation.ts';
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
    throw new AppError(
      'context_too_large',
      'Context window too small for requested output and safety margin.',
    );
  }

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
    responseModalities:
      input.imageGeneration === true && capabilities.imageGeneration ? ['text', 'image'] : ['text'],
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
