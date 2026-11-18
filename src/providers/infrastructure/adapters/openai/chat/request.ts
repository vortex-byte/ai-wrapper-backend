import type { ModelRuntimeConfig, NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import { resolveDialect, type ProviderDialect } from '@/providers/domain/dialect.ts';
import { isAllowedReasoningEffort, resolveReasoningEffort } from '../config.ts';
import type { FinishReason, OpenAIContentPart, OpenAIMessage } from '../types.ts';

export function supportsSamplingParams(model: ModelRuntimeConfig, effort?: unknown): boolean {
  const override = model.config['supportsSamplingParams'];
  if (typeof override === 'boolean') return override;
  const effectiveEffort = effort === undefined ? model.config['reasoningEffort'] : effort;
  if (isAllowedReasoningEffort(effectiveEffort) && effectiveEffort !== 'none') return false;
  return !/^(o[0-9]|gpt-[56])/.test(model.apiModelId);
}

export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'other';
  }
}

function mergeOpenAIContent(
  left: OpenAIMessage['content'],
  right: OpenAIMessage['content'],
): OpenAIMessage['content'] {
  if (typeof left === 'string' && typeof right === 'string') return `${left}\n\n${right}`;
  const asParts = (content: OpenAIMessage['content']): OpenAIContentPart[] =>
    typeof content === 'string' ? [{ type: 'text', text: content }] : [...content];
  return [...asParts(left), ...asParts(right)];
}

export function buildRequest(
  req: NormalizedChatRequest,
  messages: OpenAIMessage[],
  dialect: ProviderDialect = resolveDialect(req.provider),
  strict = false,
): Record<string, unknown> {
  const reasoningEffort = resolveReasoningEffort(req);
  const sampling = supportsSamplingParams(req.model, reasoningEffort);

  return {
    model: req.model.apiModelId,
    messages,
    [dialect.chatPayload.maxTokens]: req.maxOutputTokens,
    stream: true,
    ...(!strict && dialect.chatPayload.sendStreamUsageOption
      ? { stream_options: { include_usage: true } }
      : {}),
    ...(!strict && dialect.chatPayload.sendSafetyIdentifier
      ? { safety_identifier: req.metadata.userIdHash }
      : {}),
    ...(!strict && sampling && typeof req.temperature === 'number'
      ? { temperature: req.temperature }
      : {}),
    ...(!strict && sampling && typeof req.topP === 'number' ? { top_p: req.topP } : {}),
    ...(!strict && typeof reasoningEffort === 'string' && reasoningEffort.length > 0
      ? { reasoning_effort: reasoningEffort }
      : {}),
  };
}

export function buildMessages(
  req: NormalizedChatRequest,
  media: readonly (readonly OpenAIContentPart[])[] = [],
): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  if (req.system && req.system.trim().length > 0) {
    messages.push({ role: 'system', content: req.system });
  }

  req.messages.forEach((msg, index) => {
    const textPieces = msg.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text);
    for (const p of msg.parts) {
      if (p.type === 'compaction') {
        const payload = p.payload;
        const summary =
          typeof payload === 'object' && payload !== null && 'content' in payload
            ? String((payload as { content: unknown }).content)
            : '';
        if (summary.length > 0) {
          textPieces.unshift(`[Previous conversation summary]: ${summary}`);
        }
      }
    }
    const text = textPieces.join('\n\n');
    const inline = media[index] ?? [];

    let content: OpenAIMessage['content'];
    if (inline.length > 0) {
      content = [...inline, ...(text.length > 0 ? [{ type: 'text' as const, text }] : [])];
    } else {
      content = text.length > 0 ? text : ' ';
    }

    const last = messages[messages.length - 1];
    if (last !== undefined && last.role === msg.role) {
      last.content = mergeOpenAIContent(last.content, content);
    } else {
      messages.push({ role: msg.role, content });
    }
  });

  if (messages.length === 0) {
    messages.push({ role: 'user', content: ' ' });
  }

  return messages;
}

export async function resolveMediaBlocks(
  req: NormalizedChatRequest,
  dialect: ProviderDialect = resolveDialect(req.provider),
): Promise<OpenAIContentPart[][]> {
  const perMessage: OpenAIContentPart[][] = [];

  for (const message of req.messages) {
    const parts: OpenAIContentPart[] = [];
    for (const part of message.parts) {
      if (part.type === 'image') {
        const base64 = Buffer.from(await part.file.read()).toString('base64');
        parts.push({
          type: 'image_url',
          image_url: { url: `data:${part.file.mimeType};base64,${base64}` },
        });
        continue;
      }
      if (part.type !== 'document') continue;

      if (
        part.preferNative &&
        part.file.mimeType === 'application/pdf' &&
        dialect.documentInput.pdf === 'native'
      ) {
        const base64 = Buffer.from(await part.file.read()).toString('base64');
        parts.push({
          type: 'file',
          file: {
            file_data: `data:application/pdf;base64,${base64}`,
            filename: part.file.name,
          },
        });
        continue;
      }

      if (part.extractedText !== undefined && part.extractedText.length > 0) {
        parts.push({
          type: 'text',
          text: `<attached_document name="${part.file.name}" untrusted="true">\n${part.extractedText}\n</attached_document>`,
        });
      }
    }
    perMessage.push(parts);
  }

  return perMessage;
}
