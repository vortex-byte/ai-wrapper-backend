import { describe, expect, it } from 'vitest';
import { OpenAIAdapter } from '@/providers/infrastructure/adapters/openai/adapter.ts';
import { buildMessages, buildRequest } from '@/providers/infrastructure/adapters/openai/chat/request.ts';
import type { ResolvedFile } from '@/providers/domain/pal.ts';
import { makeOpenAIRequest, mockChatClient, openAIModel } from './fixtures.ts';

describe('chat/request — request shape', () => {
  it('keeps the synchronous request text-only (media is resolved by execute)', () => {
    const unreadable: ResolvedFile = {
      fileId: 'f-unreadable',
      name: 's.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 4,
      read: () => {
        throw new Error('the synchronous request must not read attachment bytes');
      },
      stream: () => {
        throw new Error('the synchronous request must not read attachment bytes');
      },
    };
    const req = makeOpenAIRequest({
      system: '',
      messages: [
        {
          role: 'user',
          parts: [
            { type: 'image', file: unreadable },
            { type: 'text', text: 'summarise' },
          ],
        },
      ],
    });
    const params = buildRequest(req, buildMessages(req)) as {
      messages: Array<{ role: string; content: unknown }>;
    };

    expect(params.messages[0]).toEqual({ role: 'user', content: 'summarise' });
  });

  it('forwards reasoning_effort from the registry config', () => {
    const req = makeOpenAIRequest();
    const params = buildRequest(
      {
        ...req,
        model: { ...req.model, apiModelId: 'o4-mini', config: { reasoningEffort: 'high' } },
      },
      buildMessages(req),
    ) as Record<string, unknown>;

    expect(params['reasoning_effort']).toBe('high');
    expect(params['temperature']).toBeUndefined();
  });

  it('lets the per-request reasoning effort override the registry config', () => {
    const req = makeOpenAIRequest({ temperature: 0.4 });
    const params = buildRequest(
      { ...req, reasoningEffort: 'low', model: { ...req.model, config: { reasoningEffort: 'high' } } },
      buildMessages(req),
    ) as Record<string, unknown>;

    expect(params['reasoning_effort']).toBe('low');
    expect(params['temperature']).toBeUndefined();
  });

  it('exposes the same shape through the adapter port', () => {
    const adapter = new OpenAIAdapter(() => mockChatClient([]));
    const params = adapter.toProviderRequest(makeOpenAIRequest()) as Record<string, unknown>;
    expect(params['model']).toBe('gpt-4o');
    expect(params['stream']).toBe(true);
  });

  it('merges consecutive same-role messages', () => {
    const req = makeOpenAIRequest({
      system: '',
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'one' }] },
        { role: 'user', parts: [{ type: 'text', text: 'two' }] },
      ],
    });
    expect(buildMessages(req)).toEqual([{ role: 'user', content: 'one\n\ntwo' }]);
  });

  it('always emits at least one message', () => {
    const req = makeOpenAIRequest({ system: '', messages: [] });
    expect(buildMessages(req)).toEqual([{ role: 'user', content: ' ' }]);
  });

  it('honours an explicit supportsSamplingParams override', () => {
    const req = makeOpenAIRequest({ temperature: 0.7 });
    const params = buildRequest(
      { ...req, model: openAIModel({ apiModelId: 'o3-mini', config: { supportsSamplingParams: true } }) },
      buildMessages(req),
    ) as Record<string, unknown>;
    expect(params['temperature']).toBe(0.7);
  });
});
