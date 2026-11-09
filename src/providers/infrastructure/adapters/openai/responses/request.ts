import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import { imageToolSupported } from '@/providers/domain/capabilities.ts';
import {
  CURATED_SKILL_IDS,
  IMAGE_GENERATION_OPTION_KEYS,
  IMAGE_GENERATION_OPTION_VALUES,
  MAX_OUTPUT_COMPRESSION,
  MAX_PARTIAL_IMAGES,
  MIN_OUTPUT_COMPRESSION,
  OPENAI_OUTPUT_DIR,
} from '../config.ts';
import { getLogger } from '@/observability/logger.ts';
import { supportsSamplingParams } from '../chat/request.ts';

export function containerEnabled(req: NormalizedChatRequest): boolean {
  const container = req.container;
  if (container === undefined) return false;
  if (req.provider.config['useChatCompletions'] === true) return false;
  return container.codeExecution || (container.skills?.length ?? 0) > 0;
}

export function imageGenerationEnabled(req: NormalizedChatRequest): boolean {
  if (!imageToolSupported(req.model.capabilities)) return false;
  if (!req.responseModalities.includes('image')) return false;
  if (req.provider.config['useChatCompletions'] === true) return false;
  return req.model.config['imageGeneration'] !== false;
}

export function responsesEnabled(req: NormalizedChatRequest): boolean {
  return (
    containerEnabled(req) ||
    imageGenerationEnabled(req) ||
    req.model.capabilities.compaction !== undefined ||
    req.messages.some((message) => message.parts.some((part) => part.type === 'compaction'))
  );
}

export function compactionConfig(req: NormalizedChatRequest): readonly unknown[] | undefined {
  const capability = req.model.capabilities.compaction;
  if (capability === undefined) return undefined;
  const window = req.model.capabilities.contextWindow;
  const threshold = Math.min(
    window - 1,
    capability.triggerTokens ?? Math.max(1000, Math.floor(window * 0.8)),
  );
  return [{ type: 'compaction', compact_threshold: threshold }];
}

function outputDirAddendum(): string {
  return (
    `\n\nCRITICAL: Always save or copy every generated file (PDF, DOCX, XLSX, PPTX, images) ` +
    `directly under ${OPENAI_OUTPUT_DIR} so it can be downloaded by the user.`
  );
}

async function buildResponsesInput(req: NormalizedChatRequest): Promise<unknown[]> {
  const items: unknown[] = [];
  const lastUserIndex = req.messages.reduce(
    (acc, message, index) => (message.role === 'user' ? index : acc),
    -1,
  );

  for (const [index, message] of req.messages.entries()) {
    for (const part of message.parts) {
      if (part.type === 'compaction') items.push(part.payload);
    }

    const text = message.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('');

    if (message.role === 'assistant') {
      if (text.length > 0) items.push({ role: 'assistant', content: text });
      continue;
    }

    const content: unknown[] = [];
    for (const part of message.parts) {
      if (part.type === 'image') {
        const base64 = Buffer.from(await part.file.read()).toString('base64');
        content.push({
          type: 'input_image',
          image_url: `data:${part.file.mimeType};base64,${base64}`,
          detail: 'auto',
        });
        continue;
      }
      if (part.type === 'document') {
        if (part.preferNative) {
          const base64 = Buffer.from(await part.file.read()).toString('base64');
          content.push({
            type: 'input_file',
            filename: part.file.name,
            file_data: `data:${part.file.mimeType};base64,${base64}`,
          });
          continue;
        }
        if (part.extractedText !== undefined && part.extractedText.length > 0) {
          content.push({
            type: 'input_text',
            text: `<attached_document name="${part.file.name}" untrusted="true">\n${part.extractedText}\n</attached_document>`,
          });
          continue;
        }
      }
      if (part.type === 'text' && part.text.length > 0) {
        content.push({ type: 'input_text', text: part.text });
      }
    }

    if (index === lastUserIndex) {
      for (const file of req.inputFiles ?? []) {
        content.push({
          type: 'input_file',
          file_id: file.providerFileId,
          filename: file.filename,
        });
      }
    }

    items.push({
      role: 'user',
      content: content.length > 0 ? content : [{ type: 'input_text', text: ' ' }],
    });
  }

  if (items.length === 0) {
    items.push({ role: 'user', content: [{ type: 'input_text', text: ' ' }] });
  }
  return items;
}

function resolveSkills(req: NormalizedChatRequest): Array<Record<string, unknown>> {
  const configured = req.model.config['openaiSkills'];
  if (Array.isArray(configured)) {
    const skills: Array<Record<string, unknown>> = [];
    for (const entry of configured) {
      if (typeof entry === 'string' && entry.length > 0) {
        skills.push({ type: 'skill_reference', skill_id: entry, version: 'latest' });
        continue;
      }
      if (typeof entry === 'object' && entry !== null) {
        const id = (entry as { id?: unknown }).id;
        const version = (entry as { version?: unknown }).version;
        if (typeof id === 'string' && id.length > 0) {
          skills.push({
            type: 'skill_reference',
            skill_id: id,
            version: typeof version === 'string' && version.length > 0 ? version : 'latest',
          });
        }
      }
    }
    return skills;
  }

  const skills: Array<Record<string, unknown>> = [];
  for (const skillId of req.container?.skills ?? []) {
    const curated = CURATED_SKILL_IDS[skillId];
    if (curated !== undefined) {
      skills.push({ type: 'skill_reference', skill_id: curated, version: 'latest' });
    }
  }
  return skills;
}

function clampPartialImages(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return Math.min(MAX_PARTIAL_IMAGES, Math.max(0, value));
}

function clampOutputCompression(value: unknown, format: unknown): number | null {
  if (format !== 'jpeg' && format !== 'webp') return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return Math.min(MAX_OUTPUT_COMPRESSION, Math.max(MIN_OUTPUT_COMPRESSION, value));
}

function warnDroppedImageOption(req: NormalizedChatRequest, key: string, value: unknown): void {
  getLogger().warn(
    {
      component: 'provider.openai',
      providerId: req.provider.providerId,
      modelId: req.model.modelId,
      option: key,
      value,
    },
    'dropped an image generation option the provider would reject',
  );
}

export function resolvedImageGenerationOptions(req: NormalizedChatRequest): Record<string, unknown> {
  const modelConfigured = req.model.config['imageGenerationOptions'];
  if (typeof modelConfigured === 'object' && modelConfigured !== null && !Array.isArray(modelConfigured)) {
    return modelConfigured as Record<string, unknown>;
  }
  const providerConfigured = req.provider.config['imageGenerationOptions'];
  if (typeof providerConfigured === 'object' && providerConfigured !== null && !Array.isArray(providerConfigured)) {
    return providerConfigured as Record<string, unknown>;
  }
  return {};
}

export function resolvedImageModel(req: NormalizedChatRequest): string | undefined {
  const capability = req.model.capabilities.imageGeneration;
  if (capability?.model !== undefined && capability.model.trim().length > 0) {
    return capability.model.trim();
  }
  const providerModel = req.provider.config['imageModel'];
  if (typeof providerModel === 'string' && providerModel.trim().length > 0) {
    return providerModel.trim();
  }
  return undefined;
}

function imageGenerationTool(req: NormalizedChatRequest): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: 'image_generation' };
  const targetModel = resolvedImageModel(req);
  if (targetModel !== undefined) {
    tool['model'] = targetModel;
  }

  const options = resolvedImageGenerationOptions(req);

  for (const key of IMAGE_GENERATION_OPTION_KEYS) {
    const value = options[key];
    if (typeof value !== 'string') continue;
    if (!IMAGE_GENERATION_OPTION_VALUES[key](value)) {
      warnDroppedImageOption(req, key, value);
      continue;
    }
    tool[key] = value;
  }

  const partialImages = options['partial_images'];
  if (partialImages !== undefined) {
    const resolved = clampPartialImages(partialImages);
    if (resolved === null) warnDroppedImageOption(req, 'partial_images', partialImages);
    else tool['partial_images'] = resolved;
  }

  const compression = options['output_compression'];
  if (compression !== undefined) {
    const resolved = clampOutputCompression(compression, tool['output_format']);
    if (resolved === null) warnDroppedImageOption(req, 'output_compression', compression);
    else tool['output_compression'] = resolved;
  }

  return tool;
}

function buildResponsesTools(req: NormalizedChatRequest): unknown[] {
  const tools: unknown[] = [];
  if (imageGenerationEnabled(req)) tools.push(imageGenerationTool(req));

  const container = req.container;
  if (container === undefined) return tools;

  const fileIds = (req.inputFiles ?? []).map((file) => file.providerFileId);
  const wantsSkills = (container.skills?.length ?? 0) > 0;

  if (wantsSkills) {
    const skills = resolveSkills(req);
    const environment =
      container.containerId !== undefined
        ? { type: 'container_reference', container_id: container.containerId }
        : {
            type: 'container_auto',
            ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
            ...(skills.length > 0 ? { skills } : {}),
          };
    tools.push({ type: 'shell', environment });
    return tools;
  }

  const ciContainer =
    container.containerId !== undefined
      ? container.containerId
      : { type: 'auto', ...(fileIds.length > 0 ? { file_ids: fileIds } : {}) };
  tools.push({ type: 'code_interpreter', container: ciContainer });
  return tools;
}

export async function buildResponsesRequest(
  req: NormalizedChatRequest,
): Promise<Record<string, unknown>> {
  const reasoningEffort = req.reasoningEffort ?? req.model.config['reasoningEffort'];
  const sampling = supportsSamplingParams(req.model, reasoningEffort);
  const tools = buildResponsesTools(req);

  const base = req.system !== undefined && req.system.trim().length > 0 ? req.system : '';
  const instructions =
    `${base}${req.container !== undefined ? outputDirAddendum() : ''}`.trimStart();
  const contextManagement = compactionConfig(req);

  return {
    model: req.model.apiModelId,
    instructions,
    input: await buildResponsesInput(req),
    max_output_tokens: req.maxOutputTokens,
    stream: true,
    store: req.model.config['storeResponses'] === true,
    safety_identifier: req.metadata.userIdHash,
    ...(sampling && typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
    ...(sampling && typeof req.topP === 'number' ? { top_p: req.topP } : {}),
    ...(typeof reasoningEffort === 'string' && reasoningEffort.length > 0
      ? { reasoning: { effort: reasoningEffort } }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.some((tool) => (tool as { type?: string }).type === 'code_interpreter')
      ? { include: ['code_interpreter_call.outputs'] }
      : {}),
    ...(contextManagement !== undefined ? { context_management: contextManagement } : {}),
  };
}
