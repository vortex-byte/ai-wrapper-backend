import type { NormalizedChatRequest, ProviderRuntimeConfig } from '@/providers/domain/capabilities.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';
import { providerError } from '@/providers/domain/errors.ts';
import type { ExecuteContext } from '@/providers/ports/provider-adapter.ts';
import { apiBase } from '../client.ts';
import {
  CONTAINER_FILE_PREFIX,
  IMAGE_EXTENSIONS,
  IMAGE_FILE_PREFIX,
  MAX_CONTAINER_ARTIFACTS,
  MAX_IMAGE_BASE64_LENGTH,
  PARTIAL_IMAGE_FILE_PREFIX,
} from '../config.ts';
import { detectImageMime, mimeFromFilename } from '../media.ts';
import type { ContainerFileEntry, ExecutionState, RawResponsesItem } from '../types.ts';

export function containerFileHandle(containerId: string, fileId: string): string {
  return `${CONTAINER_FILE_PREFIX}${containerId}:${fileId}`;
}

export function parseContainerFileHandle(
  handle: string,
): { readonly containerId: string; readonly fileId: string } | null {
  if (!handle.startsWith(CONTAINER_FILE_PREFIX)) return null;
  const rest = handle.slice(CONTAINER_FILE_PREFIX.length);
  const separator = rest.indexOf(':');
  if (separator <= 0 || separator === rest.length - 1) return null;
  return { containerId: rest.slice(0, separator), fileId: rest.slice(separator + 1) };
}

function configuredImageMime(req: NormalizedChatRequest): string {
  const configured = req.model.config['imageGenerationOptions'];
  const format =
    typeof configured === 'object' && configured !== null
      ? (configured as Record<string, unknown>)['output_format']
      : undefined;
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  return 'image/png';
}

export function* imageArtifact(
  item: RawResponsesItem,
  state: ExecutionState,
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

  const revisedPrompt = item.revised_prompt;
  const mimeType = detectImageMime(bytes) ?? configuredImageMime(req);
  yield {
    type: 'artifact_emitted',
    providerFileId: handle,
    filename: `image-${sequence}.${IMAGE_EXTENSIONS[mimeType] ?? 'png'}`,
    mimeType,
    sizeBytes: bytes.byteLength,
    bytes,
    ...(typeof revisedPrompt === 'string' && revisedPrompt.length > 0
      ? { revisedPrompt }
      : {}),
  };
}

export function* artifactEvent(
  state: ExecutionState,
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

export function* sweepImages(
  output: readonly RawResponsesItem[] | undefined,
  state: ExecutionState,
  req: NormalizedChatRequest,
): Iterable<GenerationEvent> {
  for (const item of output ?? []) {
    if (item.type !== 'image_generation_call') continue;
    if (item.status === 'failed' || item.status === 'incomplete') continue;
    if (reachedImageCap(req, state)) return;
    yield* imageArtifact(item, state, req);
  }
}

/** Whether the request has already produced its allowed number of images. */
export function reachedImageCap(req: NormalizedChatRequest, state: ExecutionState): boolean {
  const cap = req.model.capabilities.maxImagesPerRequest;
  if (cap === undefined) return false;
  return state.imageCount >= cap;
}

/**
 * Streams a partial preview as its own artifact so the UI can render progressively. Partials
 * bypass both the image cap and the container-artifact budget: they are one per
 * `partial_image_index` of a given image call, not the final output.
 */
export function* partialImageArtifact(
  event: {
    readonly item_id?: string;
    readonly partial_image_index?: number;
    readonly partial_image_b64?: string;
  },
  state: ExecutionState,
  req: NormalizedChatRequest,
): Iterable<GenerationEvent> {
  const payload = event.partial_image_b64;
  if (typeof payload !== 'string' || payload.length === 0) return;
  if (payload.length > MAX_IMAGE_BASE64_LENGTH) return;

  const index = event.partial_image_index ?? 0;
  const handle = `${PARTIAL_IMAGE_FILE_PREFIX}${event.item_id ?? 'image_generation'}:${index}`;
  if (state.emittedPartials.has(handle)) return;

  const bytes = Buffer.from(payload, 'base64');
  if (bytes.byteLength === 0) return;
  state.emittedPartials.add(handle);

  const mimeType = detectImageMime(bytes) ?? configuredImageMime(req);
  yield {
    type: 'artifact_emitted',
    providerFileId: handle,
    filename: `image-partial-${index + 1}.${IMAGE_EXTENSIONS[mimeType] ?? 'png'}`,
    mimeType,
    sizeBytes: bytes.byteLength,
    bytes,
  };
}

async function listContainerFiles(
  provider: ProviderRuntimeConfig,
  containerId: string,
  signal: AbortSignal,
): Promise<readonly ContainerFileEntry[]> {
  const apiKey = provider.secrets['apiKey'];
  if (apiKey === undefined || apiKey === '') return [];

  const response = await fetch(
    `${apiBase(provider)}/containers/${encodeURIComponent(containerId)}/files?limit=100`,
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

export async function* emitContainerArtifacts(
  req: NormalizedChatRequest,
  state: ExecutionState,
  ctx: ExecuteContext,
): AsyncIterable<GenerationEvent> {
  for (const containerId of state.containerIds) {
    if (state.emitted.size >= MAX_CONTAINER_ARTIFACTS) return;
    let files: readonly ContainerFileEntry[];
    try {
      files = await listContainerFiles(req.provider, containerId, ctx.signal);
    } catch {
      continue;
    }
    for (const file of files) {
      if (state.emitted.size >= MAX_CONTAINER_ARTIFACTS) return;
      if (file.source !== undefined && file.source !== 'assistant') continue;
      yield* artifactEvent(state, containerId, file.id, file.filename, file.bytes);
    }
  }
}
