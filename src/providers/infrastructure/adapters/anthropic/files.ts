import { providerError } from '@/providers/domain/errors.ts';
import type {
  FilesApiContext,
  InputFileUpload,
  ProviderArtifact,
  UploadedInputFile,
} from '@/providers/ports/provider-adapter.ts';
import { apiBase, filesHeaders } from './client.ts';
import type { RawAnthropicStreamEvent } from './types.ts';

export function parseFilenameFromContentDisposition(header: string | null): string | undefined {
  if (header === null) return undefined;
  const matchUtf8 = header.match(/filename\*=UTF-8''([^;\r\n]+)/i);
  if (matchUtf8?.[1] !== undefined) {
    try {
      return decodeURIComponent(matchUtf8[1]);
    } catch {
      return matchUtf8[1];
    }
  }
  const matchPlain = header.match(/filename=(?:"([^"]+)"|([^;\r\n]+))/i);
  const raw = matchPlain?.[1] ?? matchPlain?.[2]?.trim();
  return raw !== undefined && raw !== '' ? raw : undefined;
}

export function extractGeneratedFiles(
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

export function toolResultOutput(block: RawAnthropicStreamEvent['content_block']): {
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

export async function fetchArtifactStream(
  providerFileId: string,
  ctx: FilesApiContext,
): Promise<ProviderArtifact> {
  const apiKey = ctx.provider.secrets['apiKey'];
  if (apiKey === undefined || apiKey === '') {
    throw providerError('provider_unavailable', 'Anthropic API key is not configured.', {
      retryable: false,
    });
  }

  const headers = filesHeaders(ctx.provider, apiKey);
  const baseUrl = apiBase(ctx.provider);
  const encodedId = encodeURIComponent(providerFileId);

  let metaFilename: string | undefined;
  let metaMimeType: string | undefined;
  let metaSizeBytes: number | undefined;

  try {
    const metaRes = await fetch(`${baseUrl}/v1/files/${encodedId}`, {
      method: 'GET',
      headers,
      signal: ctx.signal,
    });
    if (metaRes.ok) {
      const meta = (await metaRes.json()) as Record<string, unknown>;
      if (typeof meta['filename'] === 'string' && meta['filename'] !== '') {
        metaFilename = meta['filename'];
      }
      if (typeof meta['mime_type'] === 'string' && meta['mime_type'] !== '') {
        metaMimeType = meta['mime_type'];
      }
      if (typeof meta['size_bytes'] === 'number' && Number.isFinite(meta['size_bytes'])) {
        metaSizeBytes = meta['size_bytes'];
      }
    }
  } catch {
    // Non-fatal if metadata call fails; continue to content endpoint
  }

  const response = await fetch(`${baseUrl}/v1/files/${encodedId}/content`, {
    method: 'GET',
    headers,
    signal: ctx.signal,
  });

  if (!response.ok || response.body === null) {
    throw providerError('provider_unavailable', 'Could not download the generated file.', {
      retryable: response.status >= 500 || response.status === 429,
      providerStatus: response.status,
    });
  }

  const contentDisposition = response.headers.get('content-disposition');
  const headerFilename = parseFilenameFromContentDisposition(contentDisposition);
  const contentType = response.headers.get('content-type');
  const contentLength = response.headers.get('content-length');
  const headerSizeBytes =
    contentLength !== null && Number.isFinite(Number(contentLength))
      ? Number(contentLength)
      : undefined;

  const filename = metaFilename ?? headerFilename;
  const mimeType = metaMimeType ?? (contentType !== null ? contentType : undefined);
  const sizeBytes = metaSizeBytes ?? headerSizeBytes;

  return {
    stream: response.body as ReadableStream<Uint8Array>,
    ...(filename !== undefined ? { filename } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

export async function uploadInputFile(
  file: InputFileUpload,
  ctx: FilesApiContext,
): Promise<UploadedInputFile> {
  const apiKey = ctx.provider.secrets['apiKey'];
  if (apiKey === undefined || apiKey === '') {
    throw providerError('provider_unavailable', 'Anthropic API key is not configured.', {
      retryable: false,
    });
  }

  const form = new FormData();
  form.append('file', new Blob([file.bytes], { type: file.mimeType }), file.filename);
  if (ctx.fileRetentionDays !== undefined && ctx.fileRetentionDays > 0) {
    form.append('expires_in_seconds', String(ctx.fileRetentionDays * 86_400));
  }

  const response = await fetch(`${apiBase(ctx.provider)}/v1/files`, {
    method: 'POST',
    headers: filesHeaders(ctx.provider, apiKey),
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

export async function deleteProviderFile(
  providerFileId: string,
  ctx: FilesApiContext,
): Promise<void> {
  const apiKey = ctx.provider.secrets['apiKey'];
  if (apiKey === undefined || apiKey === '') {
    throw providerError('provider_unavailable', 'Anthropic API key is not configured.', {
      retryable: false,
    });
  }

  const response = await fetch(
    `${apiBase(ctx.provider)}/v1/files/${encodeURIComponent(providerFileId)}`,
    {
      method: 'DELETE',
      headers: filesHeaders(ctx.provider, apiKey),
      signal: ctx.signal,
    },
  );

  // Already gone is a success: deletion is idempotent.
  if (!response.ok && response.status !== 404) {
    throw providerError('provider_unavailable', 'Could not delete the provider file.', {
      retryable: response.status >= 500 || response.status === 429,
      providerStatus: response.status,
    });
  }
}
