import { describe, expect, it, vi } from 'vitest';
import { getTiktoken } from '@/providers/infrastructure/adapters/openai/estimate.ts';
import { responsesError } from '@/providers/infrastructure/adapters/openai/errors.ts';
import { detectImageMime, mimeFromFilename } from '@/providers/infrastructure/adapters/openai/media.ts';
import {
  containerFileHandle,
  emitContainerArtifacts,
  parseContainerFileHandle,
  partialImageArtifact,
} from '@/providers/infrastructure/adapters/openai/responses/artifacts.ts';
import { MAX_CONTAINER_ARTIFACTS } from '@/providers/infrastructure/adapters/openai/config.ts';
import { makeChatRequest } from '@/providers/infrastructure/fake/fake-provider.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { ExecutionState } from '@/providers/infrastructure/adapters/openai/types.ts';

describe('estimate', () => {
  it('uses o200k encodings for current model families', () => {
    expect(getTiktoken('gpt-5-mini')).not.toBeNull();
    expect(getTiktoken('gpt-4.1')).not.toBeNull();
    expect(getTiktoken('o4-mini')).not.toBeNull();
    expect(getTiktoken('chatgpt-4o-latest')).not.toBeNull();
  });
});

describe('media', () => {
  it('maps known filenames to MIME types, case-insensitively', () => {
    expect(mimeFromFilename('report.XLSX')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(mimeFromFilename('chart.png')).toBe('image/png');
    expect(mimeFromFilename('no-extension')).toBeUndefined();
  });

  it('detects png, jpeg and webp magic bytes', () => {
    expect(detectImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe('image/png');
    expect(detectImageMime(new Uint8Array([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(detectImageMime(webp)).toBe('image/webp');
  });

  it('detects gif and svg signatures', () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
    expect(detectImageMime(gif)).toBe('image/gif');

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(detectImageMime(svg)).toBe('image/svg+xml');

    const prolog = Buffer.from('<?xml version="1.0"?>\n<svg></svg>');
    expect(detectImageMime(prolog)).toBe('image/svg+xml');
  });

  it('returns null for unknown bytes', () => {
    expect(detectImageMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('container file handles', () => {
  it('round-trips container and file ids', () => {
    const handle = containerFileHandle('cntr_1', 'cfile_2');
    expect(parseContainerFileHandle(handle)).toEqual({ containerId: 'cntr_1', fileId: 'cfile_2' });
  });

  it('rejects malformed or foreign handles', () => {
    expect(parseContainerFileHandle('file-abc')).toBeNull();
    expect(parseContainerFileHandle('container:')).toBeNull();
    expect(parseContainerFileHandle('container:cntr_1')).toBeNull();
    expect(parseContainerFileHandle('container::cfile_1')).toBeNull();
  });
});

describe('container artifact budget', () => {
  const req = (): NormalizedChatRequest =>
    makeChatRequest({
      provider: {
        providerId: 'p-openai',
        key: 'openai',
        adapter: 'openai',
        config: {},
        secrets: { apiKey: 'sk-test-key-01234567890123456789' },
      },
    });

  const emptyState = (): ExecutionState => ({
    started: false,
    textPartStarted: false,
    containerIds: new Set<string>(['cntr_1']),
    emitted: new Set<string>(),
    emittedPartials: new Set<string>(),
    startedTools: new Set<string>(),
    completedTools: new Set<string>(),
    imageCount: 0,
    usage: undefined,
    finishReason: 'stop',
  });

  const files = Array.from({ length: MAX_CONTAINER_ARTIFACTS + 5 }, (_, index) => ({
    id: `cfile_${index}`,
    path: `/mnt/data/file-${index}.xlsx`,
    source: 'assistant',
  }));

  it('does not let partial previews consume the container-artifact budget', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: files }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    try {
      const request = req();
      const state = emptyState();
      const partials = [
        ...partialImageArtifact(
          { item_id: 'ig_1', partial_image_index: 0, partial_image_b64: 'aGVsbG8=' },
          state,
          request,
        ),
        ...partialImageArtifact(
          { item_id: 'ig_1', partial_image_index: 1, partial_image_b64: 'aGVsbG8=' },
          state,
          request,
        ),
        ...partialImageArtifact(
          { item_id: 'ig_1', partial_image_index: 2, partial_image_b64: 'aGVsbG8=' },
          state,
          request,
        ),
      ];
      expect(partials).toHaveLength(3);

      const container = [];
      for await (const event of emitContainerArtifacts(request, state, {
        signal: new AbortController().signal,
        deadline: 0,
      })) {
        container.push(event);
      }

      expect(container).toHaveLength(MAX_CONTAINER_ARTIFACTS);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('responsesError', () => {
  const failed = (code: string) => ({
    type: 'response.failed',
    response: { error: { code, message: 'boom' } },
  });

  it('maps moderation and policy rejections to content_filtered', () => {
    for (const code of [
      'moderation_blocked',
      'image_content_policy_violation',
      'bio_policy',
      'misalignment_policy_violation',
    ]) {
      const error = responsesError(failed(code));
      expect(error.category).toBe('content_filtered');
      expect(error.retryable).toBe(false);
      expect(error.providerCode).toBe(code);
    }
  });

  it('maps an image_generation_user_error type to non-retryable invalid_request', () => {
    const error = responsesError({
      type: 'response.failed',
      response: { error: { type: 'image_generation_user_error', code: 'some_new_code', message: 'nope' } },
    });
    expect(error.category).toBe('invalid_request');
    expect(error.retryable).toBe(false);
    expect(error.providerCode).toBe('some_new_code');
  });

  it('maps prompt and image-input rejections to non-retryable invalid_request', () => {
    for (const code of [
      'invalid_prompt',
      'invalid_request_error',
      'invalid_base64_image',
      'image_too_large',
    ]) {
      const error = responsesError(failed(code));
      expect(error.category).toBe('invalid_request');
      expect(error.retryable).toBe(false);
    }
  });

  it('maps rate_limit_exceeded to a retryable rate limit', () => {
    const error = responsesError(failed('rate_limit_exceeded'));
    expect(error.category).toBe('provider_rate_limited');
    expect(error.retryable).toBe(true);
  });

  it('falls back to the error type when no code is present', () => {
    const error = responsesError({
      type: 'response.failed',
      response: { error: { type: 'server_error', message: 'boom' } },
    });
    expect(error.providerCode).toBe('server_error');
  });

  it('keeps an unrecognised or absent code retryable', () => {
    const unknown = responsesError(failed('something_new'));
    expect(unknown.category).toBe('provider_unavailable');
    expect(unknown.retryable).toBe(true);
    expect(unknown.providerCode).toBe('something_new');

    const policyShaped = responsesError(failed('content_policy_violation'));
    expect(policyShaped.category).toBe('provider_unavailable');
    expect(policyShaped.retryable).toBe(true);

    const bare = responsesError({ type: 'response.failed', message: 'no code' });
    expect(bare.category).toBe('provider_unavailable');
    expect(bare.retryable).toBe(true);
    expect(bare.providerCode).toBeUndefined();
  });

  it('scrubs secrets out of the internal message', () => {
    const error = responsesError({
      type: 'response.failed',
      message: 'bad key sk-abcdefghijklmnopqrstuvwxyz012345',
    });
    expect(error.internalMessage).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });
});