import OpenAI from 'openai';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type {
  ModelRuntimeConfig,
  NormalizedChatRequest,
  ProviderRuntimeConfig,
} from '@/providers/domain/capabilities.ts';
import { providerError, type ProviderError } from '@/providers/domain/errors.ts';
import type { GenerationEvent, TokenUsage } from '@/providers/domain/pal.ts';
import type {
  EstimateResult,
  ExecuteContext,
  FilesApiContext,
  HealthCheckContext,
  HealthCheckResult,
  InputFileUpload,
  ProviderAdapter,
  ProviderArtifact,
  ProviderModelInfo,
  UploadedInputFile,
} from '@/providers/ports/provider-adapter.ts';
import {
  approximateEstimate,
  healthFailed,
  healthNotConfigured,
  isAbortLikeError,
  isChatCapableModelId,
  isTimeoutLikeError,
  numberFromConfig,
  parseRetryAfter,
  requireApiKey,
  scrubSecrets,
} from '../shared.ts';

type FinishReason = 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other';

let o200kEncoding: Tiktoken | null = null;
let cl100kEncoding: Tiktoken | null = null;

/** o200k_base covers current OpenAI model families; cl100k_base is legacy (gpt-3.5/gpt-4). */
export function getTiktoken(modelId: string): Tiktoken | null {
  try {
    const lower = modelId.toLowerCase();
    const o200kPrefixes = [
      'gpt-4o',
      'gpt-4.1',
      'gpt-5',
      'gpt-6',
      'o1',
      'o2',
      'o3',
      'o4',
      'chatgpt-4o',
    ];
    if (o200kPrefixes.some((prefix) => lower.startsWith(prefix))) {
      if (!o200kEncoding) o200kEncoding = getEncoding('o200k_base');
      return o200kEncoding;
    }
    if (!cl100kEncoding) cl100kEncoding = getEncoding('cl100k_base');
    return cl100kEncoding;
  } catch {
    return null;
  }
}

export interface OpenAIClientLike {
  models: {
    list(
      params?: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<{ data: readonly { id: string }[] }>;
  };
  chat: {
    completions: {
      create(params: unknown, options?: { signal?: AbortSignal }): Promise<AsyncIterable<unknown>>;
    };
  };
  /** Responses API used for cloud-container document generation. */
  responses?: {
    create(params: unknown, options?: { signal?: AbortSignal }): Promise<AsyncIterable<unknown>>;
  };
}

export type OpenAIClientFactory = (options: {
  apiKey: string;
  baseURL?: string;
  timeout: number;
  maxRetries: number;
}) => OpenAIClientLike;

const defaultFactory: OpenAIClientFactory = (options) =>
  new OpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    timeout: options.timeout,
    maxRetries: options.maxRetries,
  });

interface RawOpenAIChunk {
  readonly id?: string;
  readonly choices?: readonly {
    readonly delta?: {
      readonly content?: string | null;
      readonly refusal?: string | null;
      readonly role?: string;
    };
    readonly finish_reason?: string | null;
    readonly index?: number;
  }[];
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens?: number;
    readonly prompt_tokens_details?: {
      readonly cached_tokens?: number;
    };
    readonly completion_tokens_details?: {
      readonly reasoning_tokens?: number;
    };
  } | null;
}

/** Cloud containers (Responses API): packs container and file IDs into an opaque handle. */
const CONTAINER_FILE_PREFIX = 'container:';

/** Builds the opaque handle stored as `providerFileId` for a container file. */
export function containerFileHandle(containerId: string, fileId: string): string {
  return `${CONTAINER_FILE_PREFIX}${containerId}:${fileId}`;
}

/** Splits a container-file handle back into its ids; `null` for a plain (non-container) file id. */
export function parseContainerFileHandle(
  handle: string,
): { readonly containerId: string; readonly fileId: string } | null {
  if (!handle.startsWith(CONTAINER_FILE_PREFIX)) return null;
  const rest = handle.slice(CONTAINER_FILE_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { containerId: rest.slice(0, separator), fileId: rest.slice(separator + 1) };
}

/** Provider sandbox directory for user-downloadable output artifacts. */
const OPENAI_OUTPUT_DIR = '/mnt/data';

/** Mapping from PAL skill identifiers to OpenAI curated skill identifiers. */
const CURATED_SKILL_IDS: Readonly<Record<string, string>> = {
  xlsx: 'openai-spreadsheets',
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  zip: 'application/zip',
};

/** Maximum artifacts captured from a single container sweep. */
const MAX_CONTAINER_ARTIFACTS = 20;

/** Hard cap for one inline image, matching the sink's per-artifact storage limit. */
const MAX_IMAGE_ARTIFACT_BYTES = 50 * 1024 * 1024;
/** Base64 inflates by 4/3; a payload above this cannot decode under the cap. */
const MAX_IMAGE_BASE64_LENGTH = Math.ceil((MAX_IMAGE_ARTIFACT_BYTES * 4) / 3);

/** Prefix for inline generated image file identifiers. */
const IMAGE_FILE_PREFIX = 'image:';

/** Provider-owned image knobs a registry may pin; anything else is dropped, not forwarded. */
const IMAGE_GENERATION_OPTION_KEYS = [
  'size',
  'quality',
  'background',
  'output_format',
  'moderation',
] as const;

/** Magic-byte signatures of the image formats the tool can emit. */
function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** Filename extension per detected/configured image MIME. */
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Best-effort MIME from a filename; the artifact sink re-measures the stored bytes anyway. */
export function mimeFromFilename(filename: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(filename);
  if (match?.[1] === undefined) return undefined;
  return MIME_BY_EXTENSION[match[1].toLowerCase()];
}

/** The output-directory instruction: only meaningful while a container is active. */
function outputDirAddendum(): string {
  return (
    `\n\nCRITICAL: Always save or copy every generated file (PDF, DOCX, XLSX, PPTX, images) ` +
    `directly under ${OPENAI_OUTPUT_DIR} so it can be downloaded by the user.`
  );
}

/** A code-interpreter/shell item emitted by the Responses API. Only the fields we read. */
interface RawResponsesItem {
  readonly id?: string;
  readonly type?: string;
  readonly status?: string;
  readonly call_id?: string;
  readonly container_id?: string;
  readonly code?: string | null;
  readonly action?: { readonly commands?: readonly string[] };
  readonly environment?: { readonly type?: string; readonly container_id?: string } | null;
  readonly outputs?:
    readonly { readonly type?: string; readonly logs?: string; readonly url?: string }[] | null;
  /** `image_generation_call` only: the generated image as base64 (no file id exists). */
  readonly result?: string | null;
  readonly revised_prompt?: string | null;
}

interface RawResponsesUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly input_tokens_details?: { readonly cached_tokens?: number };
  readonly output_tokens_details?: { readonly reasoning_tokens?: number };
}

/** A file inside a provider container, as returned by the container files API. */
interface ContainerFileEntry {
  readonly id: string;
  readonly filename: string;
  readonly bytes?: number;
  /** `user` for mounted inputs, `assistant` for generated artifacts. */
  readonly source?: string;
}

/** One Responses API streaming event. Typed structurally: the vocabulary is provider-owned. */
interface RawResponsesEvent {
  readonly type: string;
  readonly delta?: string;
  readonly item?: RawResponsesItem;
  readonly item_id?: string;
  readonly output_index?: number;
  readonly annotation?: {
    readonly type?: string;
    readonly container_id?: string;
    readonly file_id?: string;
    readonly filename?: string;
  } | null;
  readonly response?: {
    readonly id?: string;
    readonly status?: string;
    readonly incomplete_details?: { readonly reason?: string } | null;
    readonly error?: { readonly code?: string; readonly message?: string } | null;
    readonly output?: readonly RawResponsesItem[];
    readonly usage?: RawResponsesUsage | null;
  };
  readonly message?: string;
  readonly code?: string | null;
}

/** Per-execution state for the Responses stream. */
interface ResponsesRunState {
  started: boolean;
  textPartStarted: boolean;
  /** Container ids seen on tool items — used to list generated files when the turn ends. */
  readonly containerIds: Set<string>;
  /** Handles already emitted, so an annotation and the completion sweep never double-emit. */
  readonly emitted: Set<string>;
  /** Tool calls already announced/finished — the API reports both per-call and item events. */
  readonly startedTools: Set<string>;
  readonly completedTools: Set<string>;
  /** Generated images seen so far — used to name files deterministically. */
  imageCount: number;
  usage: TokenUsage | undefined;
  finishReason: FinishReason;
}

/** Shared metadata attached to every translated OpenAI error. */
interface TranslatedMeta {
  readonly internalMessage?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly providerStatus?: number;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
}

/** Codes that mean "billing/quota action required" — never retried. */
const BILLING_429_CODES: ReadonlySet<string> = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'project_spend_limit_exceeded',
]);

/** Minimal structural view of an SDK APIError body for code/type reads. */
interface ApiErrorShape {
  readonly code?: unknown;
  readonly type?: unknown;
  readonly error?: unknown;
}

/** Extracts code or type fields from SDK APIError responses. */
function readBodyField(err: ApiErrorShape, field: 'code' | 'type'): string | undefined {
  const direct = err[field];
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const body = err.error;
  const nested =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  for (const candidate of [body, nested]) {
    if (typeof candidate === 'object' && candidate !== null) {
      const value = (candidate as Record<string, unknown>)[field];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return undefined;
}

/** Checks whether model configuration supports sampling parameters (temperature, top_p). */
function supportsSamplingParams(model: ModelRuntimeConfig): boolean {
  const override = model.config['supportsSamplingParams'];
  if (typeof override === 'boolean') return override;
  const effort = model.config['reasoningEffort'];
  if (typeof effort === 'string' && effort !== 'none') return false;
  return !/^(o[0-9]|gpt-[56])/.test(model.apiModelId);
}

/** A Chat Completions content part: text, an inline image, or an inline (PDF) file. */
type OpenAIContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } }
  | {
      readonly type: 'file';
      readonly file: { readonly file_data: string; readonly filename?: string };
    };

interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[];
}

/** Merges consecutive same-role messages into a single message content. */
function mergeOpenAIContent(
  left: OpenAIMessage['content'],
  right: OpenAIMessage['content'],
): OpenAIMessage['content'] {
  if (typeof left === 'string' && typeof right === 'string') return `${left}\n\n${right}`;
  const asParts = (content: OpenAIMessage['content']): OpenAIContentPart[] =>
    typeof content === 'string' ? [{ type: 'text', text: content }] : [...content];
  return [...asParts(left), ...asParts(right)];
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly adapterKey = 'openai';

  constructor(private readonly clientFactory: OpenAIClientFactory = defaultFactory) {}

  toProviderRequest(req: NormalizedChatRequest, messages?: OpenAIMessage[]): unknown {
    return this.buildRequest(req, messages ?? this.buildMessages(req));
  }

  /** Builds Chat Completions request payload. */
  private buildRequest(
    req: NormalizedChatRequest,
    messages: OpenAIMessage[],
  ): Record<string, unknown> {
    const sampling = supportsSamplingParams(req.model);
    const reasoningEffort = req.model.config['reasoningEffort'];

    return {
      model: req.model.apiModelId,
      messages,
      max_completion_tokens: req.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(sampling && typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(sampling && typeof req.topP === 'number' ? { top_p: req.topP } : {}),
      ...(typeof reasoningEffort === 'string' && reasoningEffort.length > 0
        ? { reasoning_effort: reasoningEffort }
        : {}),
    };
  }

  /** Text-only turns; inline media is added by `buildMessages` when the caller resolved it. */
  private buildMessages(
    req: NormalizedChatRequest,
    media: readonly (readonly OpenAIContentPart[])[] = [],
  ): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];

    if (req.system && req.system.trim().length > 0) {
      messages.push({ role: 'system', content: req.system });
    }

    req.messages.forEach((msg, index) => {
      const text = msg.parts
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('');
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

  /** Resolves media blocks (inline images and PDFs) for Chat Completions. */
  private async resolveMediaBlocks(req: NormalizedChatRequest): Promise<OpenAIContentPart[][]> {
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

        if (part.preferNative && part.file.mimeType === 'application/pdf') {
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

  /** Builds payload for OpenAI Responses API when container execution is requested. */
  private async buildResponsesRequest(
    req: NormalizedChatRequest,
  ): Promise<Record<string, unknown>> {
    const sampling = supportsSamplingParams(req.model);
    const reasoningEffort = req.model.config['reasoningEffort'];
    const tools = this.buildResponsesTools(req);

    const base = req.system !== undefined && req.system.trim().length > 0 ? req.system : '';
    // The `/mnt/data` instruction only makes sense while a sandbox container is mounted; a
    // plain image-generation turn returns its bytes over the tool response instead.
    const instructions =
      `${base}${req.container !== undefined ? outputDirAddendum() : ''}`.trimStart();

    return {
      model: req.model.apiModelId,
      instructions,
      input: await this.buildResponsesInput(req),
      max_output_tokens: req.maxOutputTokens,
      stream: true,
      // Generated files may contain user content: keep the response out of provider-side
      // storage unless the registry explicitly opts in.
      store: req.model.config['storeResponses'] === true,
      ...(sampling && typeof req.temperature === 'number' ? { temperature: req.temperature } : {}),
      ...(sampling && typeof req.topP === 'number' ? { top_p: req.topP } : {}),
      ...(typeof reasoningEffort === 'string' && reasoningEffort.length > 0
        ? { reasoning: { effort: reasoningEffort } }
        : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(tools.some((tool) => (tool as { type?: string }).type === 'code_interpreter')
        ? { include: ['code_interpreter_call.outputs'] }
        : {}),
    };
  }

  /** Converts normalized chat conversation into Responses input items. */
  private async buildResponsesInput(req: NormalizedChatRequest): Promise<unknown[]> {
    const items: unknown[] = [];
    const lastUserIndex = req.messages.reduce(
      (acc, message, index) => (message.role === 'user' ? index : acc),
      -1,
    );

    for (const [index, message] of req.messages.entries()) {
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
          // `input_file` accepts PDF *and* Office formats (unlike Chat Completions).
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

  /** Declares hosted tools: image_generation and sandbox container (shell for skills, code_interpreter otherwise). */
  private buildResponsesTools(req: NormalizedChatRequest): unknown[] {
    const tools: unknown[] = [];
    if (this.imageGenerationEnabled(req)) tools.push(this.imageGenerationTool(req));

    const container = req.container;
    if (container === undefined) return tools;

    const fileIds = (req.inputFiles ?? []).map((file) => file.providerFileId);
    const wantsSkills = (container.skills?.length ?? 0) > 0;

    if (wantsSkills) {
      const skills = this.resolveSkills(req);
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

  /** Builds image_generation tool declaration from validated model config options. */
  private imageGenerationTool(req: NormalizedChatRequest): Record<string, unknown> {
    const tool: Record<string, unknown> = { type: 'image_generation' };
    const configured = req.model.config['imageGenerationOptions'];
    if (typeof configured !== 'object' || configured === null) return tool;
    const options = configured as Record<string, unknown>;
    for (const key of IMAGE_GENERATION_OPTION_KEYS) {
      const value = options[key];
      if (typeof value === 'string' || typeof value === 'number') tool[key] = value;
    }
    return tool;
  }

  /** Resolves skill references from model configuration. */
  private resolveSkills(req: NormalizedChatRequest): Array<Record<string, unknown>> {
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

  async estimateInputTokens(req: NormalizedChatRequest): Promise<EstimateResult> {
    const enc = getTiktoken(req.model.apiModelId);
    if (!enc) {
      const textLength = req.messages.reduce(
        (total, message) =>
          total +
          message.parts.reduce(
            (partTotal, part) =>
              part.type === 'text' ? partTotal + part.text.length : partTotal + 256,
            0,
          ),
        req.system ? req.system.length : 0,
      );
      return approximateEstimate(textLength);
    }

    let tokens = 0;
    if (req.system) {
      tokens += enc.encode(req.system).length + 4;
    }
    for (const msg of req.messages) {
      tokens += 3;
      for (const part of msg.parts) {
        if (part.type === 'text') {
          tokens += enc.encode(part.text).length;
        } else {
          tokens += 256;
        }
      }
    }
    tokens += 3;

    return { tokens, confidence: 'exact' };
  }

  async *execute(req: NormalizedChatRequest, ctx: ExecuteContext): AsyncIterable<GenerationEvent> {
    const apiKey = req.provider.secrets['apiKey'];
    if (!apiKey) {
      yield {
        type: 'error',
        error: providerError('provider_unavailable', 'OpenAI API key is not configured.', {
          retryable: false,
        }),
      };
      return;
    }

    const client = this.buildClient(req.provider, apiKey);

    // Cloud containers and the hosted image tool need the Responses API (tools, containers,
    // files); everything else stays on Chat Completions.
    if (this.responsesEnabled(req)) {
      if (client.responses === undefined) {
        yield {
          type: 'error',
          error: providerError(
            'provider_unavailable',
            'This provider client does not support cloud tools.',
            { retryable: false },
          ),
        };
        return;
      }
      yield* this.executeResponses(req, ctx, client.responses);
      return;
    }

    let params: unknown;
    try {
      params = this.buildRequest(req, this.buildMessages(req, await this.resolveMediaBlocks(req)));
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
      return;
    }

    let stream: AsyncIterable<unknown>;
    try {
      stream = await client.chat.completions.create(params, { signal: ctx.signal });
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
      return;
    }

    let started = false;
    let partStarted = false;
    let pendingUsage: TokenUsage | undefined;
    let terminalReason: FinishReason = 'stop';

    try {
      for await (const rawChunk of stream) {
        const chunk = rawChunk as RawOpenAIChunk;

        if (!started) {
          started = true;
          yield {
            type: 'started',
            ...(chunk.id ? { providerRequestId: chunk.id } : {}),
          };
        }

        const choice = chunk.choices?.[0];
        const refusalText = choice?.delta?.refusal;
        const contentText = choice?.delta?.content;
        if (refusalText || contentText) {
          if (!partStarted) {
            partStarted = true;
            yield { type: 'part_started', index: 0, partType: 'text' };
          }
          if (refusalText) {
            yield { type: 'text_delta', index: 0, text: refusalText };
          }
          if (contentText) {
            yield { type: 'text_delta', index: 0, text: contentText };
          }
        }

        if (choice?.finish_reason) {
          terminalReason = this.mapFinishReason(choice.finish_reason);
        }

        if (chunk.usage) {
          pendingUsage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0,
            source: 'provider',
          };
        }
      }

      if (!started) {
        yield { type: 'started' };
      }
      if (partStarted) {
        yield { type: 'part_done', index: 0 };
      }
      if (pendingUsage) {
        yield { type: 'usage', usage: pendingUsage, final: true };
      }
      yield { type: 'finished', reason: terminalReason };
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
    }
  }

  /** Whether containerized code execution/skills are active and enabled for this request. */
  private containerEnabled(req: NormalizedChatRequest): boolean {
    const container = req.container;
    if (container === undefined) return false;
    if (req.provider.config['useChatCompletions'] === true) return false;
    return container.codeExecution || (container.skills?.length ?? 0) > 0;
  }

  /** Whether image generation is requested, capable, and allowed by provider/model config. */
  private imageGenerationEnabled(req: NormalizedChatRequest): boolean {
    if (!req.model.capabilities.imageGeneration) return false;
    if (!req.responseModalities.includes('image')) return false;
    if (req.provider.config['useChatCompletions'] === true) return false;
    return req.model.config['imageGeneration'] !== false;
  }

  /** The Responses API is required for cloud containers and for the hosted image tool. */
  private responsesEnabled(req: NormalizedChatRequest): boolean {
    return this.containerEnabled(req) || this.imageGenerationEnabled(req);
  }

  /** Runs a Responses API turn, mapping events and harvesting generated files before finish. */
  private async *executeResponses(
    req: NormalizedChatRequest,
    ctx: ExecuteContext,
    responses: NonNullable<OpenAIClientLike['responses']>,
  ): AsyncIterable<GenerationEvent> {
    let params: Record<string, unknown>;
    try {
      params = await this.buildResponsesRequest(req);
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
      return;
    }

    let stream: AsyncIterable<unknown>;
    try {
      stream = await responses.create(params, { signal: ctx.signal });
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
      return;
    }

    const state: ResponsesRunState = {
      started: false,
      textPartStarted: false,
      containerIds: new Set<string>(),
      emitted: new Set<string>(),
      startedTools: new Set<string>(),
      completedTools: new Set<string>(),
      imageCount: 0,
      usage: undefined,
      finishReason: 'stop',
    };

    try {
      for await (const rawEvent of stream) {
        const event = rawEvent as RawResponsesEvent;
        yield* this.handleResponsesEvent(event, state, req);
        if (event.type === 'response.failed' || event.type === 'error') {
          yield { type: 'error', error: this.responsesError(event) };
          return;
        }
      }
    } catch (err) {
      yield { type: 'error', error: this.translateError(err) };
      return;
    }

    if (!state.started) {
      state.started = true;
      yield { type: 'started' };
    }

    // Safety net: files the model wrote but never cited. Runs before `finished` so hydration
    // still happens inside the run rather than after it is terminal.
    yield* this.emitContainerArtifacts(req, state, ctx);

    if (state.textPartStarted) {
      yield { type: 'part_done', index: 0 };
    }
    if (state.usage !== undefined) {
      yield { type: 'usage', usage: state.usage, final: true };
    }
    yield { type: 'finished', reason: state.finishReason };
  }

  /** Folds one Responses streaming event into PAL events. */
  private *handleResponsesEvent(
    event: RawResponsesEvent,
    state: ResponsesRunState,
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
        yield* this.handleItemStarted(event.item, state);
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
          yield* this.ensureToolStarted(toolCallId, 'code_interpreter', state);
          yield { type: 'tool_delta', toolCallId, delta: event.delta };
        }
        return;
      }

      case 'response.shell_call_command.delta':
      case 'response.shell_call_output_content.delta': {
        if (event.delta !== undefined && event.delta.length > 0) {
          const toolCallId = event.item_id ?? 'shell';
          yield* this.ensureToolStarted(toolCallId, 'shell', state);
          yield { type: 'tool_delta', toolCallId, delta: event.delta };
        }
        return;
      }

      case 'response.code_interpreter_call.completed': {
        yield* this.completeTool(event.item_id ?? 'code_interpreter', 'success', state);
        return;
      }

      case 'response.image_generation_call.completed': {
        yield* this.completeTool(event.item_id ?? 'image_generation', 'success', state);
        return;
      }

      case 'response.output_text.annotation.added': {
        yield* this.annotationArtifact(event, state);
        return;
      }

      case 'response.output_item.done': {
        yield* this.handleItemDone(event.item, state, req);
        return;
      }

      case 'response.completed': {
        state.usage = this.responsesUsage(event.response?.usage);
        state.finishReason = 'stop';
        this.recordContainerIds(output, state);
        yield* this.sweepImages(output, state, req);
        return;
      }

      case 'response.incomplete': {
        state.usage = this.responsesUsage(event.response?.usage);
        state.finishReason =
          event.response?.incomplete_details?.reason === 'content_filter'
            ? 'content_filter'
            : 'length';
        this.recordContainerIds(output, state);
        yield* this.sweepImages(output, state, req);
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

  /** A new output item: text parts and tool calls announce themselves here. */
  private *handleItemStarted(
    item: RawResponsesItem | undefined,
    state: ResponsesRunState,
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
      yield* this.ensureToolStarted(
        item.id ?? item.call_id ?? 'code_interpreter',
        'code_interpreter',
        state,
      );
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
          ...(item.action?.commands !== undefined
            ? { input: { commands: item.action.commands } }
            : {}),
        };
      }
    }

    if (item.type === 'image_generation_call') {
      yield* this.ensureToolStarted(item.id ?? 'image_generation', 'image_generation', state);
    }
  }

  /** A finished output item: close tools, and mine container ids for the artifact sweep. */
  private *handleItemDone(
    item: RawResponsesItem | undefined,
    state: ResponsesRunState,
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
      yield* this.completeTool(toolCallId, item.status === 'failed' ? 'error' : 'success', state);
      return;
    }

    if (item.type === 'shell_call') {
      if (item.environment?.container_id !== undefined) {
        state.containerIds.add(item.environment.container_id);
      }
      yield* this.completeTool(
        item.id ?? item.call_id ?? 'shell',
        item.status === 'incomplete' ? 'error' : 'success',
        state,
      );
      return;
    }

    if (item.type === 'image_generation_call') {
      const failed = item.status === 'failed' || item.status === 'incomplete';
      if (!failed) yield* this.imageArtifact(item, state, req);
      yield* this.completeTool(item.id ?? 'image_generation', failed ? 'error' : 'success', state);
    }
  }

  /** Announces a tool call at most once, even when deltas arrive before its item event. */
  private *ensureToolStarted(
    toolCallId: string,
    name: string,
    state: ResponsesRunState,
  ): Iterable<GenerationEvent> {
    if (state.startedTools.has(toolCallId)) return;
    state.startedTools.add(toolCallId);
    yield { type: 'tool_started', toolCallId, name };
  }

  /** Finishes a tool call at most once: the API reports both per-call and per-item events. */
  private *completeTool(
    toolCallId: string,
    status: 'success' | 'error',
    state: ResponsesRunState,
  ): Iterable<GenerationEvent> {
    if (state.completedTools.has(toolCallId)) return;
    state.completedTools.add(toolCallId);
    yield { type: 'tool_completed', toolCallId, status };
  }

  /** Emits generated image bytes as an artifact event. */
  private *imageArtifact(
    item: RawResponsesItem,
    state: ResponsesRunState,
    req: NormalizedChatRequest,
  ): Iterable<GenerationEvent> {
    const payload = item.result;
    if (typeof payload !== 'string' || payload.length === 0) return;
    if (payload.length > MAX_IMAGE_BASE64_LENGTH) return;

    const sequence = state.imageCount + 1;
    const handle = `${IMAGE_FILE_PREFIX}${item.id ?? sequence}`;
    if (state.emitted.has(handle)) return;

    const bytes = Buffer.from(payload, 'base64');
    if (bytes.byteLength === 0) return;
    state.emitted.add(handle);
    state.imageCount = sequence;

    const mimeType = detectImageMime(bytes) ?? this.configuredImageMime(req);
    yield {
      type: 'artifact_emitted',
      providerFileId: handle,
      filename: `image-${sequence}.${IMAGE_EXTENSIONS[mimeType] ?? 'png'}`,
      mimeType,
      sizeBytes: bytes.byteLength,
      bytes,
    };
  }

  /** `imageGenerationOptions.output_format`, defaulting to the API's PNG output. */
  private configuredImageMime(req: NormalizedChatRequest): string {
    const configured = req.model.config['imageGenerationOptions'];
    const format =
      typeof configured === 'object' && configured !== null
        ? (configured as Record<string, unknown>)['output_format']
        : undefined;
    if (format === 'jpeg') return 'image/jpeg';
    if (format === 'webp') return 'image/webp';
    return 'image/png';
  }

  /** `container_file_citation` annotations point at a generated file. */
  private *annotationArtifact(
    event: RawResponsesEvent,
    state: ResponsesRunState,
  ): Iterable<GenerationEvent> {
    const annotation = event.annotation;
    if (annotation === null || annotation === undefined) return;
    if (annotation.type !== 'container_file_citation') return;
    if (annotation.container_id === undefined || annotation.file_id === undefined) return;

    state.containerIds.add(annotation.container_id);
    const filename = annotation.filename ?? annotation.file_id;
    yield* this.artifactEvent(state, annotation.container_id, annotation.file_id, filename);
  }

  /** Records container ids from a completed response so the artifact sweep can list its files. */
  private recordContainerIds(
    output: readonly RawResponsesItem[] | undefined,
    state: ResponsesRunState,
  ): void {
    for (const item of output ?? []) {
      if (item.type === 'code_interpreter_call' && item.container_id !== undefined) {
        state.containerIds.add(item.container_id);
      }
      if (item.type === 'shell_call' && item.environment?.container_id !== undefined) {
        state.containerIds.add(item.environment.container_id);
      }
    }
    // Generated-file citations live on message content, which this structural type does not
    // model; the container file sweep in `emitContainerArtifacts` covers those instead.
  }

  /** Emits one `artifact_emitted` per not-yet-emitted container file. */
  private *artifactEvent(
    state: ResponsesRunState,
    containerId: string,
    fileId: string,
    filename: string,
    sizeBytes?: number,
  ): Iterable<GenerationEvent> {
    const handle = containerFileHandle(containerId, fileId);
    if (state.emitted.has(handle)) return;
    state.emitted.add(handle);

    const mimeType = mimeFromFilename(filename);
    yield {
      type: 'artifact_emitted',
      providerFileId: handle,
      filename,
      ...(mimeType !== undefined ? { mimeType } : {}),
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    };
  }

  /** Emits images from terminal response output. */
  private *sweepImages(
    output: readonly RawResponsesItem[] | undefined,
    state: ResponsesRunState,
    req: NormalizedChatRequest,
  ): Iterable<GenerationEvent> {
    for (const item of output ?? []) {
      if (item.type !== 'image_generation_call') continue;
      if (item.status === 'failed' || item.status === 'incomplete') continue;
      yield* this.imageArtifact(item, state, req);
    }
  }

  /** Emits files produced by container execution as artifacts. */
  private async *emitContainerArtifacts(
    req: NormalizedChatRequest,
    state: ResponsesRunState,
    ctx: ExecuteContext,
  ): AsyncIterable<GenerationEvent> {
    for (const containerId of state.containerIds) {
      if (state.emitted.size >= MAX_CONTAINER_ARTIFACTS) return;
      let files: readonly ContainerFileEntry[];
      try {
        files = await this.listContainerFiles(req.provider, containerId, ctx.signal);
      } catch {
        // A listing failure must not fail the generation: annotations already delivered what
        // the provider cited, and the text/message itself is complete.
        continue;
      }
      for (const file of files) {
        if (state.emitted.size >= MAX_CONTAINER_ARTIFACTS) return;
        if (file.source !== undefined && file.source !== 'assistant') continue;
        yield* this.artifactEvent(state, containerId, file.id, file.filename, file.bytes);
      }
    }
  }

  /** `GET /v1/containers/{id}/files` — generated files with their sandbox paths. */
  private async listContainerFiles(
    provider: ProviderRuntimeConfig,
    containerId: string,
    signal: AbortSignal,
  ): Promise<readonly ContainerFileEntry[]> {
    const apiKey = provider.secrets['apiKey'];
    if (apiKey === undefined || apiKey === '') return [];

    const response = await fetch(
      `${this.apiBase(provider)}/containers/${encodeURIComponent(containerId)}/files?limit=100`,
      { headers: { authorization: `Bearer ${apiKey}` }, signal },
    );
    if (!response.ok) {
      throw providerError('provider_unavailable', 'Could not list the generated files.', {
        retryable: response.status >= 500 || response.status === 429,
        providerStatus: response.status,
      });
    }

    const payload = (await response.json()) as {
      readonly data?: readonly {
        readonly id?: unknown;
        readonly bytes?: unknown;
        readonly path?: unknown;
        readonly source?: unknown;
      }[];
    };

    const files: ContainerFileEntry[] = [];
    for (const entry of payload.data ?? []) {
      if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
      const path = typeof entry.path === 'string' ? entry.path : entry.id;
      files.push({
        id: entry.id,
        filename: path.split('/').pop() ?? entry.id,
        ...(typeof entry.bytes === 'number' && Number.isFinite(entry.bytes)
          ? { bytes: entry.bytes }
          : {}),
        ...(typeof entry.source === 'string' ? { source: entry.source } : {}),
      });
    }
    return files;
  }

  private responsesUsage(usage: RawResponsesUsage | null | undefined): TokenUsage | undefined {
    if (usage === null || usage === undefined) return undefined;
    return {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
      reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
      source: 'provider',
    };
  }

  /** Maps a `response.failed`/`error` event onto the shared provider error vocabulary. */
  private responsesError(event: RawResponsesEvent): ProviderError {
    const message = scrubSecrets(
      event.response?.error?.message ?? event.message ?? 'unknown_error',
    );
    const code = event.response?.error?.code ?? event.code ?? undefined;
    return providerError(
      'provider_unavailable',
      'The model provider could not complete the request.',
      {
        retryable: true,
        internalMessage: message,
        ...(typeof code === 'string' && code.length > 0 ? { providerCode: code } : {}),
      },
    );
  }

  private mapFinishReason(reason: string): FinishReason {
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

  translateError(err: unknown): ProviderError {
    if (isAbortLikeError(err, [OpenAI.APIUserAbortError])) {
      return providerError('generation_cancelled', 'The generation was cancelled.', {
        retryable: false,
      });
    }

    if (isTimeoutLikeError(err, [OpenAI.APIConnectionTimeoutError])) {
      const errMsg = err instanceof Error ? scrubSecrets(err.message) : 'unknown_error';
      return providerError('generation_timeout', 'The model provider timed out.', {
        retryable: true,
        internalMessage: errMsg,
      });
    }

    if (err instanceof OpenAI.APIError) {
      const status = err.status;
      const rawMsg = err.message ?? '';
      const sanitized = scrubSecrets(rawMsg);
      const errCode = readBodyField(err, 'code');
      const errType = readBodyField(err, 'type');

      let retryAfterMs: number | undefined;
      const headers = err.headers;
      if (headers) {
        const headerVal =
          typeof (headers as { get?: (k: string) => string | null }).get === 'function'
            ? (headers as { get: (k: string) => string | null }).get('retry-after')
            : (headers as Record<string, string>)['retry-after'];
        retryAfterMs = parseRetryAfter(headerVal);
      }

      const withMeta = (extra: Omit<TranslatedMeta, 'internalMessage'> = {}): TranslatedMeta => ({
        internalMessage: sanitized,
        ...(status !== undefined ? { providerStatus: status } : {}),
        ...(errCode !== undefined ? { providerCode: errCode } : {}),
        ...(err.requestID ? { providerRequestId: err.requestID } : {}),
        ...extra,
      });

      if (status === 400) {
        const isContext =
          errCode === 'context_length_exceeded' ||
          rawMsg.includes('context_length_exceeded') ||
          rawMsg.includes('maximum context length');
        return providerError(
          isContext ? 'context_too_large' : 'invalid_request',
          isContext
            ? 'The conversation exceeds the model context window.'
            : 'The model provider rejected the request.',
          { retryable: false, ...withMeta() },
        );
      }

      if (status === 401 || status === 403) {
        return providerError(
          'provider_unavailable',
          'The model provider rejected authentication.',
          {
            retryable: false,
            ...withMeta(),
          },
        );
      }

      if (status === 404) {
        return providerError(
          'model_unavailable',
          'The requested model is not available from the provider.',
          {
            retryable: false,
            ...withMeta(),
          },
        );
      }

      if (status === 408 || status === 504) {
        return providerError('generation_timeout', 'The model provider timed out.', {
          retryable: true,
          ...withMeta(),
        });
      }

      if (status === 410) {
        return providerError(
          'model_unavailable',
          'The requested model is no longer available from the provider.',
          {
            retryable: false,
            ...withMeta(),
          },
        );
      }

      if (status === 413) {
        return providerError('context_too_large', 'The request exceeds the provider size limits.', {
          retryable: false,
          ...withMeta(),
        });
      }

      if (status === 422 || status === 451) {
        return providerError(
          'content_filtered',
          'The request was rejected by the provider content policy.',
          {
            retryable: false,
            ...withMeta(),
          },
        );
      }

      if (status === 429) {
        if (
          (errCode !== undefined && BILLING_429_CODES.has(errCode)) ||
          errType === 'insufficient_quota'
        ) {
          return providerError(
            'provider_unavailable',
            'The model provider reported a billing or usage limit; add credits or raise the limit.',
            { retryable: false, ...withMeta() },
          );
        }
        return providerError(
          'provider_rate_limited',
          'The model provider is rate limiting requests.',
          {
            retryable: true,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            ...withMeta(),
          },
        );
      }

      if (
        status === 503 &&
        (errCode === 'server_is_overloaded' || errType === 'service_unavailable_error')
      ) {
        return providerError('service_busy', 'The model provider is temporarily overloaded.', {
          retryable: true,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          ...withMeta(),
        });
      }

      if (status !== undefined && status >= 500) {
        return providerError(
          'provider_unavailable',
          'The model provider is temporarily unavailable.',
          {
            retryable: true,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            ...withMeta(),
          },
        );
      }

      // Any other 4xx is a client-side rejection: never retry blindly.
      if (status !== undefined && status >= 400 && status < 500) {
        return providerError('provider_unavailable', 'The model provider rejected the request.', {
          retryable: false,
          ...withMeta(),
        });
      }

      // APIError without an HTTP status: mid-stream throws, connection failures.
      // Branch on the structured type/code the SDK extracted from the error body.
      if (status === undefined) {
        const retryOpts = retryAfterMs !== undefined ? { retryAfterMs } : {};
        if (errType === 'rate_limit_error') {
          return providerError(
            'provider_rate_limited',
            'The model provider is rate limiting requests.',
            {
              retryable: true,
              ...retryOpts,
              ...withMeta(),
            },
          );
        }
        if (
          errType === 'service_unavailable_error' ||
          errCode === 'server_is_overloaded' ||
          errType === 'overloaded_error' ||
          errCode === 'overloaded_error'
        ) {
          return providerError('service_busy', 'The model provider is temporarily overloaded.', {
            retryable: true,
            ...retryOpts,
            ...withMeta({ providerCode: errCode ?? errType ?? 'overloaded_error' }),
          });
        }
        if (errType === 'invalid_request_error') {
          return providerError('invalid_request', 'The model provider rejected the request.', {
            retryable: false,
            ...withMeta(),
          });
        }
        if (errCode === 'context_length_exceeded') {
          return providerError(
            'context_too_large',
            'The conversation exceeds the model context window.',
            {
              retryable: false,
              ...withMeta(),
            },
          );
        }
      }
    }

    if (err instanceof OpenAI.APIConnectionError) {
      const errMsg = scrubSecrets(err.message);
      return providerError('provider_unavailable', 'The model provider is unavailable.', {
        retryable: true,
        internalMessage: errMsg,
      });
    }

    if (!(err instanceof OpenAI.APIError) && typeof err === 'object' && err !== null) {
      const maybeErr = err as {
        type?: string;
        code?: string;
        message?: string;
        status?: number;
        error?: { type?: string; code?: string; message?: string };
      };
      const errType = maybeErr.error?.type ?? maybeErr.type;
      const errCode = maybeErr.error?.code ?? maybeErr.code;
      const rawMsg = maybeErr.error?.message ?? maybeErr.message ?? '';
      const sanitized = scrubSecrets(rawMsg);
      const meta = {
        internalMessage: sanitized,
        ...(maybeErr.status !== undefined ? { providerStatus: maybeErr.status } : {}),
        ...(errCode !== undefined
          ? { providerCode: errCode }
          : errType !== undefined
            ? { providerCode: errType }
            : {}),
      };

      if (
        errType === 'overloaded_error' ||
        errType === 'service_unavailable_error' ||
        errCode === 'server_is_overloaded' ||
        errCode === 'overloaded_error' ||
        maybeErr.status === 503
      ) {
        return providerError('service_busy', 'The model provider is temporarily overloaded.', {
          retryable: true,
          ...meta,
        });
      }

      if (errType === 'rate_limit_error' || errCode === 'rate_limit_exceeded') {
        return providerError(
          'provider_rate_limited',
          'The model provider is rate limiting requests.',
          {
            retryable: true,
            ...meta,
          },
        );
      }

      if (errType === 'invalid_request_error') {
        return providerError('invalid_request', 'The model provider rejected the request.', {
          retryable: false,
          ...meta,
        });
      }

      if (errCode === 'context_length_exceeded') {
        return providerError(
          'context_too_large',
          'The conversation exceeds the model context window.',
          {
            retryable: false,
            ...meta,
          },
        );
      }
    }

    const errMsg = err instanceof Error ? scrubSecrets(err.message) : 'unknown_error';
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

  async listModels(ctx: HealthCheckContext): Promise<readonly ProviderModelInfo[]> {
    const { provider, signal } = ctx;
    const client = this.buildClient(provider, requireApiKey(provider.secrets));
    const result = await client.models.list(undefined, { signal });
    return result.data
      .map((model) => ({ id: model.id }))
      .filter((model) => isChatCapableModelId(model.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private buildClient(provider: ProviderRuntimeConfig, apiKey: string): OpenAIClientLike {
    return this.clientFactory({
      apiKey,
      ...(provider.baseUrl !== undefined ? { baseURL: provider.baseUrl } : {}),
      timeout: numberFromConfig(provider.config, 'timeoutMs', 60_000),
      maxRetries: numberFromConfig(provider.config, 'maxRetries', 1),
    });
  }

  /** Downloads a provider-generated artifact file stream. */
  async fetchArtifactStream(
    providerFileId: string,
    ctx: FilesApiContext,
  ): Promise<ProviderArtifact> {
    const apiKey = ctx.provider.secrets['apiKey'];
    if (apiKey === undefined || apiKey === '') {
      throw providerError('provider_unavailable', 'OpenAI API key is not configured.', {
        retryable: false,
      });
    }

    const containerFile = parseContainerFileHandle(providerFileId);
    const url =
      containerFile !== null
        ? `${this.apiBase(ctx.provider)}/containers/${encodeURIComponent(containerFile.containerId)}/files/${encodeURIComponent(containerFile.fileId)}/content`
        : `${this.apiBase(ctx.provider)}/files/${encodeURIComponent(providerFileId)}/content`;

    const response = await fetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: ctx.signal,
    });

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
      throw providerError('provider_unavailable', 'OpenAI API key is not configured.', {
        retryable: false,
      });
    }

    const form = new FormData();
    form.append('purpose', 'user_data');
    form.append('file', new Blob([file.bytes], { type: file.mimeType }), file.filename);

    const response = await fetch(`${this.apiBase(ctx.provider)}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
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

  /** OpenAI's base URL already includes `/v1` (SDK default), so paths append directly. */
  private apiBase(provider: ProviderRuntimeConfig): string {
    return provider.baseUrl !== undefined && provider.baseUrl !== ''
      ? provider.baseUrl.replace(/\/$/, '')
      : 'https://api.openai.com/v1';
  }
}
