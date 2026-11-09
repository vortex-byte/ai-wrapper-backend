import { providerError } from '@/providers/domain/errors.ts';
import type {
  FilesApiContext,
  InputFileUpload,
  ProviderArtifact,
  UploadedInputFile,
} from '@/providers/ports/provider-adapter.ts';
import {
  authHeaders,
  buildTransport,
  fileDownloadUrl,
  filesUploadUrl,
} from './client.ts';
import { INLINE_ARTIFACT_PREFIX } from './config.ts';
import { bytesToStream, parseInlineHandle } from './media.ts';
import type { GeminiClientFactory } from './types.ts';

export async function fetchArtifactStream(
  providerFileId: string,
  ctx: FilesApiContext,
  clientFactory: GeminiClientFactory,
): Promise<ProviderArtifact> {
  const inline = parseInlineHandle(providerFileId);
  if (inline !== null) {
    return {
      stream: bytesToStream(inline.bytes),
      sizeBytes: inline.bytes.byteLength,
      ...(inline.mimeType !== undefined ? { mimeType: inline.mimeType } : {}),
    };
  }

  if (providerFileId.startsWith(INLINE_ARTIFACT_PREFIX)) {
    throw providerError(
      'provider_unavailable',
      'The generated file was not retained by the provider.',
      {
        retryable: false,
      },
    );
  }

  const apiKey = ctx.provider.secrets['apiKey'];
  if (apiKey === undefined || apiKey === '') {
    throw providerError('provider_unavailable', 'Google Gemini API key is not configured.', {
      retryable: false,
    });
  }

  const transport = buildTransport(clientFactory, ctx.provider, apiKey);
  const response = await transport({
    url: fileDownloadUrl(ctx.provider, providerFileId),
    method: 'GET',
    headers: authHeaders(apiKey),
    signal: ctx.signal,
  });

  if (!response.ok || response.body === null) {
    throw providerError('provider_unavailable', 'Could not download the generated file.', {
      retryable: response.status >= 500 || response.status === 429,
      providerStatus: response.status,
    });
  }

  const contentType = response.headers.get('content-type');
  const lengthHeader = response.headers.get('content-length');
  const sizeBytes =
    lengthHeader !== null && Number.isFinite(Number(lengthHeader))
      ? Number(lengthHeader)
      : undefined;

  return {
    stream: response.body,
    ...(contentType !== null ? { mimeType: contentType } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
  };
}

export async function uploadInputFile(
  file: InputFileUpload,
  ctx: FilesApiContext,
  clientFactory: GeminiClientFactory,
): Promise<UploadedInputFile> {
  const apiKey = ctx.provider.secrets['apiKey'];
  if (apiKey === undefined || apiKey === '') {
    throw providerError('provider_unavailable', 'Google Gemini API key is not configured.', {
      retryable: false,
    });
  }

  const form = new FormData();
  form.append('file', new Blob([file.bytes], { type: file.mimeType }), file.filename);

  const transport = buildTransport(clientFactory, ctx.provider, apiKey);
  const response = await transport({
    url: filesUploadUrl(ctx.provider),
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
    signal: ctx.signal,
  });

  if (!response.ok) {
    throw providerError('provider_unavailable', 'Could not upload the input file.', {
      retryable: response.status >= 500 || response.status === 429,
      providerStatus: response.status,
    });
  }

  const payload = (await response.json()) as { name?: unknown; file?: { name?: unknown } };
  const nestedName = payload.file?.name;
  const name =
    typeof payload.name === 'string' && payload.name.length > 0
      ? payload.name
      : typeof nestedName === 'string' && nestedName.length > 0
        ? nestedName
        : undefined;
  if (name === undefined) {
    throw providerError('provider_unavailable', 'The provider did not return a file id.', {
      retryable: true,
    });
  }

  return { providerFileId: name };
}
