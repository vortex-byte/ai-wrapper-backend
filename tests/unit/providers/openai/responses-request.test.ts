import { describe, expect, it } from 'vitest';
import {
  buildResponsesRequest,
  compactionConfig,
  responsesEnabled,
} from '@/providers/infrastructure/adapters/openai/responses/request.ts';
import { makeOpenAIRequest, openAIModel } from './fixtures.ts';

describe('responses/request — routing', () => {
  it('stays off Chat Completions for a plain text turn', () => {
    expect(responsesEnabled(makeOpenAIRequest())).toBe(false);
  });

  it('routes to Responses when a compaction block is replayed', () => {
    const req = makeOpenAIRequest({
      messages: [
        {
          role: 'assistant',
          parts: [
            {
              type: 'compaction',
              provider: 'openai',
              payload: { type: 'compaction', id: 'cmp-2', encrypted_content: 'opaque-2' },
            },
          ],
        },
        { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      ],
    });
    expect(responsesEnabled(req)).toBe(true);
  });

  it('routes to Responses for an image request with the capability on', () => {
    const req = makeOpenAIRequest({
      model: openAIModel({
        capabilities: { ...openAIModel().capabilities, imageGeneration: { mode: 'tool' } },
      }),
      responseModalities: ['image'],
    });
    expect(responsesEnabled(req)).toBe(true);
  });
});

describe('responses/request — compaction config', () => {
  it('defaults the threshold to 80% of the context window', () => {
    const req = makeOpenAIRequest({
      model: openAIModel({
        capabilities: { ...openAIModel().capabilities, compaction: {} },
      }),
    });
    expect(compactionConfig(req)).toEqual([{ type: 'compaction', compact_threshold: 102_400 }]);
  });

  it('is absent without the capability', () => {
    expect(compactionConfig(makeOpenAIRequest())).toBeUndefined();
  });
});

describe('responses/request — payload', () => {
  it('replays a stored compaction item verbatim ahead of its message', async () => {
    const params = await buildResponsesRequest(
      makeOpenAIRequest({
        messages: [
          {
            role: 'assistant',
            parts: [
              {
                type: 'compaction',
                provider: 'openai',
                payload: { type: 'compaction', id: 'cmp-2', encrypted_content: 'opaque-2' },
              },
            ],
          },
          { role: 'user', parts: [{ type: 'text', text: 'hello' }] },
        ],
      }),
    );

    expect(params['input']).toEqual([
      { type: 'compaction', id: 'cmp-2', encrypted_content: 'opaque-2' },
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ]);
  });

  it('keeps responses out of provider storage unless opted in', async () => {
    const off = await buildResponsesRequest(makeOpenAIRequest());
    expect(off['store']).toBe(false);

    const on = await buildResponsesRequest(
      makeOpenAIRequest({ model: openAIModel({ config: { storeResponses: true } }) }),
    );
    expect(on['store']).toBe(true);
  });
});
