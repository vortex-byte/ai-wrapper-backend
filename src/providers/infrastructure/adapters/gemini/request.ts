import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import { flag, gemini3OrLater, resolveThinkingBudget } from './config.ts';
import { mediaPart } from './media.ts';

export function buildTools(req: NormalizedChatRequest): unknown[] {
  if (!req.model.capabilities.tools) return [];
  const tools: unknown[] = [];
  if (flag(req, 'googleSearch', false)) tools.push({ googleSearch: {} });
  if (flag(req, 'codeExecution', true)) tools.push({ codeExecution: {} });
  return tools;
}

export function pushContent(
  contents: unknown[],
  role: 'user' | 'model',
  parts: unknown[],
): void {
  const safeParts = parts.length > 0 ? parts : [{ text: ' ' }];
  const previous = contents[contents.length - 1] as
    | { role: string; parts: unknown[] }
    | undefined;
  if (previous !== undefined && previous.role === role) {
    previous.parts.push(...safeParts);
    return;
  }
  contents.push({ role, parts: safeParts });
}

export function normalizeTurns(contents: unknown[]): void {
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: ' ' }] });
    return;
  }
  const first = contents[0] as { role: string };
  if (first.role !== 'user') contents.unshift({ role: 'user', parts: [{ text: ' ' }] });
}

export function textContents(req: NormalizedChatRequest): unknown[] {
  const contents: unknown[] = [];
  for (const message of req.messages) {
    const parts: unknown[] = [];
    for (const part of message.parts) {
      if (part.type === 'text' && part.text.length > 0) parts.push({ text: part.text });
    }
    pushContent(contents, message.role === 'assistant' ? 'model' : 'user', parts);
  }
  normalizeTurns(contents);
  return contents;
}

export async function buildContents(req: NormalizedChatRequest): Promise<unknown[]> {
  const contents: unknown[] = [];
  for (const message of req.messages) {
    const parts: unknown[] = [];
    for (const part of message.parts) {
      if (part.type === 'text') {
        if (part.text.length > 0) parts.push({ text: part.text });
        continue;
      }
      parts.push(await mediaPart(part));
    }
    pushContent(contents, message.role === 'assistant' ? 'model' : 'user', parts);
  }
  normalizeTurns(contents);
  return contents;
}

export function assembleRequest(
  req: NormalizedChatRequest,
  contents: unknown[],
): Record<string, unknown> {
  const imageRequested = req.responseModalities.includes('image');
  const tools = imageRequested ? [] : buildTools(req);
  const imageConfig = imageRequested ? buildImageConfig(req) : undefined;
  const omitSampling = gemini3OrLater(req.model.apiModelId);

  return {
    ...(req.system !== undefined && req.system.trim().length > 0
      ? { systemInstruction: { parts: [{ text: req.system }] } }
      : {}),
    contents,
    generationConfig: {
      maxOutputTokens: req.maxOutputTokens,
      ...(typeof req.temperature === 'number' && !omitSampling
        ? { temperature: req.temperature }
        : {}),
      ...(typeof req.topP === 'number' && !omitSampling ? { topP: req.topP } : {}),
      ...(imageRequested ? { responseModalities: ['TEXT', 'IMAGE'] } : {}),
      ...(imageConfig !== undefined ? { imageConfig } : {}),
      ...(req.reasoningEffort !== undefined && !imageRequested
        ? {
            thinkingConfig: {
              thinkingBudget: resolveThinkingBudget(
                req.reasoningEffort,
                req.maxOutputTokens,
              ),
            },
          }
        : {}),
    },
    ...(tools.length > 0 ? { tools } : {}),
  };
}

function buildImageConfig(
  req: NormalizedChatRequest,
): { aspectRatio?: string; imageSize?: string } | undefined {
  const override = req.model.config['imageConfig'];
  const configured =
    typeof override === 'object' && override !== null
      ? (override as Record<string, unknown>)
      : {};
  const aspectRatio =
    req.imageOutput?.aspectRatio ??
    (typeof configured['aspectRatio'] === 'string' ? configured['aspectRatio'] : undefined);
  const imageSize =
    req.imageOutput?.imageSize ??
    (typeof configured['imageSize'] === 'string' ? configured['imageSize'] : undefined);
  if (aspectRatio === undefined && imageSize === undefined) return undefined;
  return {
    ...(aspectRatio !== undefined ? { aspectRatio } : {}),
    ...(imageSize !== undefined ? { imageSize } : {}),
  };
}

export function toProviderRequest(req: NormalizedChatRequest): unknown {
  return assembleRequest(req, textContents(req));
}
