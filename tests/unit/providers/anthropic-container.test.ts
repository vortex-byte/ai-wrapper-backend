import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicAdapter,
  type AnthropicClientLike,
} from '@/providers/infrastructure/adapters/anthropic/adapter.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';

/** A client whose `messages.create` returns one scripted event stream per call. */
function scriptedClient(turns: readonly (readonly unknown[])[]): {
  client: AnthropicClientLike;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  let call = 0;
  const client: AnthropicClientLike = {
    models: { list: async () => ({ data: [] }) },
    messages: {
      create: async (params: unknown) => {
        calls.push(params as Record<string, unknown>);
        const events = turns[Math.min(call, turns.length - 1)] ?? [];
        call += 1;
        return (async function* () {
          for (const event of events) yield event;
        })();
      },
    },
  };
  return { client, calls };
}

function request(overrides: Partial<NormalizedChatRequest> = {}): NormalizedChatRequest {
  return {
    requestId: 'req-1',
    generationId: 'gen-1',
    model: {
      modelId: 'm-1',
      providerId: 'p-1',
      apiModelId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet',
      capabilities: {
        streaming: true,
        vision: true,
        documents: { pdf: true },
        imageGeneration: false,
        documentGeneration: true,
        systemPrompt: true,
        tools: true,
        contextWindow: 200000,
        maxOutputTokens: 8192,
      },
      maxOutputTokens: 8192,
      defaultMaxOutputTokens: 4096,
      quotaWeight: 1,
      config: {},
    },
    provider: {
      providerId: 'p-1',
      key: 'anthropic',
      adapter: 'anthropic',
      config: {},
      secrets: { apiKey: 'sk-test' },
    },
    system: 'You are helpful.',
    messages: [{ role: 'user', parts: [{ type: 'text', text: 'Make an xlsx' }] }],
    maxOutputTokens: 4096,
    responseModalities: ['text', 'file'],
    metadata: { userIdHash: 'hash' },
    ...overrides,
  };
}

const textStream = [
  { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done. ' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
];

async function collect(iterable: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe('AnthropicAdapter — container & skills request shaping', () => {
  it('leaves the request untouched when no container is requested', () => {
    const adapter = new AnthropicAdapter(() => scriptedClient([textStream]).client);
    const params = adapter.toProviderRequest(request()) as Record<string, unknown>;
    expect(params['tools']).toBeUndefined();
    expect(params['container']).toBeUndefined();
    expect(params['system']).toBe('You are helpful.');
  });

  it('attaches the code-execution tool, skills and the $OUTPUT_DIR addendum', () => {
    const adapter = new AnthropicAdapter(() => scriptedClient([textStream]).client);
    const params = adapter.toProviderRequest(
      request({ container: { codeExecution: true, skills: ['xlsx', 'docx'] } }),
    ) as Record<string, unknown>;

    expect(params['tools']).toEqual([{ type: 'code_execution_20250825', name: 'code_execution' }]);
    expect(params['container']).toEqual({
      skills: [
        { type: 'anthropic', skill_id: 'xlsx', version: 'latest' },
        { type: 'anthropic', skill_id: 'docx', version: 'latest' },
      ],
    });
    expect(String(params['system'])).toContain('$OUTPUT_DIR');
    expect(String(params['system'])).toContain('You are helpful.');
  });

  it('reuses a container id for multi-turn continuity', () => {
    const adapter = new AnthropicAdapter(() => scriptedClient([textStream]).client);
    const params = adapter.toProviderRequest(
      request({
        container: { codeExecution: true, containerId: 'cntr_01ABC', skills: ['xlsx'] },
      }),
    ) as Record<string, unknown>;

    expect(params['container']).toEqual({
      id: 'cntr_01ABC',
      skills: [{ type: 'anthropic', skill_id: 'xlsx', version: 'latest' }],
    });
  });

  it('honours a configured code-execution tool version', () => {
    const adapter = new AnthropicAdapter(() => scriptedClient([textStream]).client);
    const req = request({ container: { codeExecution: true } });
    const params = adapter.toProviderRequest({
      ...req,
      provider: { ...req.provider, config: { codeExecutionToolType: 'code_execution_20260120' } },
    }) as Record<string, unknown>;

    expect(params['tools']).toEqual([{ type: 'code_execution_20260120', name: 'code_execution' }]);
  });

  it('mounts input files as container_upload blocks on the final user turn', () => {
    const adapter = new AnthropicAdapter(() => scriptedClient([textStream]).client);
    const params = adapter.toProviderRequest(
      request({
        container: { codeExecution: true, skills: ['xlsx'] },
        messages: [
          { role: 'user', parts: [{ type: 'text', text: 'first' }] },
          { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] },
          { role: 'user', parts: [{ type: 'text', text: 'use the csv' }] },
        ],
        inputFiles: [{ providerFileId: 'file_011ABC', filename: 'data.csv', mimeType: 'text/csv' }],
      }),
    ) as { messages: Array<{ role: string; content: unknown }> };

    const last = params.messages[params.messages.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toEqual([
      { type: 'text', text: 'use the csv' },
      { type: 'container_upload', file_id: 'file_011ABC' },
    ]);
    // Earlier turns are never re-mounted.
    expect(JSON.stringify(params.messages[0])).not.toContain('container_upload');
  });
});

describe('AnthropicAdapter — tool & artifact stream mapping', () => {
  it('maps text, tool use and completed tool results to PAL events', async () => {
    const stream = [
      { type: 'message_start', message: { id: 'msg_2', usage: { input_tokens: 12 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Running code…' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'code_execution' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"command":"python x.py"}' },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } },
    ];
    const adapter = new AnthropicAdapter(() => scriptedClient([stream]).client);
    const events = await collect(adapter.execute(request(), { signal: new AbortController().signal, deadline: 0 }));

    expect(events.filter((e) => e.type === 'part_started')).toHaveLength(1);
    expect(events.find((e) => e.type === 'text_delta')).toMatchObject({ text: 'Running code…' });
    expect(events.find((e) => e.type === 'tool_started')).toMatchObject({
      toolCallId: 'srvtoolu_1',
      name: 'code_execution',
    });
    expect(events.find((e) => e.type === 'tool_completed')).toMatchObject({ status: 'success' });
    expect(events.filter((e) => e.type === 'finished')).toHaveLength(1);
  });

  it('mines bash_code_execution_tool_result for generated file ids', async () => {
    const stream = [
      { type: 'message_start', message: { id: 'msg_3', usage: { input_tokens: 8 } } },
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'bash_code_execution_tool_result',
          tool_use_id: 'srvtoolu_2',
          stdout: 'Report generated successfully.\n',
          content: { type: 'bash_code_execution_result', content: [{ file_id: 'file_018XYZ' }] },
        },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    ];
    const adapter = new AnthropicAdapter(() => scriptedClient([stream]).client);
    const events = await collect(adapter.execute(request(), { signal: new AbortController().signal, deadline: 0 }));

    const artifact = events.find((e) => e.type === 'artifact_emitted');
    expect(artifact).toMatchObject({ providerFileId: 'file_018XYZ' });
    expect(events.find((e) => e.type === 'tool_delta')).toMatchObject({
      delta: 'Report generated successfully.\n',
    });
  });
});

describe('AnthropicAdapter — pause_turn continuation', () => {
  const pauseTurn = [
    { type: 'message_start', message: { id: 'msg_p1', usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'working…' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 3 } },
  ];

  it('continues in the same container and finishes', async () => {
    const { client, calls } = scriptedClient([pauseTurn, textStream]);
    const adapter = new AnthropicAdapter(() => client);
    const events = await collect(adapter.execute(request({ container: { codeExecution: true } }), { signal: new AbortController().signal, deadline: 0 }));

    expect(calls).toHaveLength(2);
    // The continuation replays the assistant turn inside the same container params.
    const secondMessages = calls[1]?.['messages'] as Array<{ role: string }>;
    expect(secondMessages[secondMessages.length - 1]?.role).toBe('assistant');
    expect(calls[1]?.['container']).toEqual(calls[0]?.['container']);

    expect(events.filter((e) => e.type === 'started')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'finished')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(1);
  });

  it('caps runaway pause_turn loops at the hard limit', async () => {
    const { client, calls } = scriptedClient([pauseTurn]);
    const adapter = new AnthropicAdapter(() => client);
    const events = await collect(adapter.execute(request({ container: { codeExecution: true } }), { signal: new AbortController().signal, deadline: 0 }));

    // 1 initial turn + MAX_PAUSE_TURNS (8) continuations.
    expect(calls).toHaveLength(9);
    expect(events.filter((e) => e.type === 'finished')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(0);
  });
});

describe('AnthropicAdapter — Files API', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('downloads a generated file with the API key in the header', async () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn(async () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '4' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const adapter = new AnthropicAdapter(() => scriptedClient([textStream]).client);
    const artifact = await adapter.fetchArtifactStream('file_018XYZ', {
      provider: request().provider,
      signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain('/v1/files/file_018XYZ/content');
    expect(init.headers['x-api-key']).toBe('sk-test');
    expect(artifact.mimeType).toBe('application/pdf');
    expect(artifact.sizeBytes).toBe(4);
  });

  it('refuses to download without a configured key', async () => {
    const adapter = new AnthropicAdapter(() => scriptedClient([textStream]).client);
    await expect(
      adapter.fetchArtifactStream('file_x', {
        provider: { ...request().provider, secrets: {} },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ category: 'provider_unavailable' });
  });

  it('uploads an input file to the Files API and returns the provider id', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'file_uploaded' }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const adapter = new AnthropicAdapter(() => scriptedClient([textStream]).client);
    const result = await adapter.uploadInputFile(
      { filename: 'data.csv', mimeType: 'text/csv', bytes: new Uint8Array([1]) },
      { provider: request().provider, signal: new AbortController().signal },
    );

    expect(result.providerFileId).toBe('file_uploaded');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string }];
    expect(url).toContain('/v1/files');
    expect(init.method).toBe('POST');
  });
});

/** A lazy binary double matching `ResolvedFile` / `AttachmentFileRef`. */
function resolvedFile(bytes: number[], mimeType: string, name: string) {
  return {
    fileId: `f-${name}`,
    mimeType,
    name,
    sizeBytes: bytes.length,
    read: async () => new Uint8Array(bytes),
    stream: async () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      }),
  };
}

describe('AnthropicAdapter — pause_turn block replay', () => {
  /** A paused turn that used a server tool and produced a file (the real nested shape). */
  const pausedWithServerTool = [
    { type: 'message_start', message: { id: 'msg_p2', usage: { input_tokens: 5 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'code_execution', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"code":"print(1)"}' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'bash_code_execution_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: {
          type: 'bash_code_execution_result',
          stdout: '1\n',
          stderr: '',
          return_code: 0,
          content: [
            {
              type: 'bash_code_execution_output',
              file_id: 'file_abc',
              filename: 'out.csv',
              mime_type: 'text/csv',
            },
          ],
        },
      },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 3 } },
  ];

  it('replays the paused content verbatim, server tool blocks included', async () => {
    const { client, calls } = scriptedClient([pausedWithServerTool, textStream]);
    const adapter = new AnthropicAdapter(() => client);
    const events = await collect(
      adapter.execute(request({ container: { codeExecution: true } }), {
        signal: new AbortController().signal,
        deadline: 0,
      }),
    );

    const messages = calls[1]?.['messages'] as Array<{ role: string; content: unknown }>;
    const assistant = messages[messages.length - 1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.content).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'code_execution',
        input: { code: 'print(1)' },
      },
      {
        type: 'bash_code_execution_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: {
          type: 'bash_code_execution_result',
          stdout: '1\n',
          stderr: '',
          return_code: 0,
          content: [
            {
              type: 'bash_code_execution_output',
              file_id: 'file_abc',
              filename: 'out.csv',
              mime_type: 'text/csv',
            },
          ],
        },
      },
    ]);

    // Nested `content.stdout` and the generated file are mined from the result block.
    expect(events.filter((e) => e.type === 'tool_delta')).toContainEqual({
      type: 'tool_delta',
      toolCallId: 'srvtoolu_1',
      delta: '1\n',
    });
    expect(events.filter((e) => e.type === 'artifact_emitted')).toEqual([
      {
        type: 'artifact_emitted',
        providerFileId: 'file_abc',
        filename: 'out.csv',
        mimeType: 'text/csv',
      },
    ]);
  });

  it('never sends two consecutive assistant turns across repeated pauses', async () => {
    const { client, calls } = scriptedClient([pausedWithServerTool, pausedWithServerTool, textStream]);
    const adapter = new AnthropicAdapter(() => client);
    await collect(
      adapter.execute(request({ container: { codeExecution: true } }), {
        signal: new AbortController().signal,
        deadline: 0,
      }),
    );

    const messages = calls[2]?.['messages'] as Array<{ role: string }>;
    for (let index = 1; index < messages.length; index += 1) {
      expect(messages[index]?.role).not.toBe(messages[index - 1]?.role);
    }
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('declares the code-execution tool for a skills-only request', () => {
    const adapter = new AnthropicAdapter(() => scriptedClient([textStream]).client);
    const params = adapter.toProviderRequest(
      request({ container: { codeExecution: false, skills: ['xlsx'] } }),
    ) as Record<string, unknown>;

    expect(params['tools']).toEqual([{ type: 'code_execution_20250825', name: 'code_execution' }]);
    expect(params['container']).toEqual({
      skills: [{ type: 'anthropic', skill_id: 'xlsx', version: 'latest' }],
    });
  });
});

describe('AnthropicAdapter — multimodal input', () => {
  it('renders images and PDFs as base64 blocks and other documents as text', async () => {
    const { client, calls } = scriptedClient([textStream]);
    const adapter = new AnthropicAdapter(() => client);

    await collect(
      adapter.execute(
        request({
          messages: [
            {
              role: 'user',
              parts: [
                { type: 'image', file: resolvedFile([1, 2, 3, 4], 'image/png', 'shot.png') },
                {
                  type: 'document',
                  file: resolvedFile([9, 9], 'application/pdf', 'spec.pdf'),
                  preferNative: true,
                },
                {
                  type: 'document',
                  file: resolvedFile([7], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'memo.docx'),
                  extractedText: 'memo body',
                  preferNative: true,
                },
                { type: 'text', text: 'summarise' },
              ],
            },
          ],
        }),
        { signal: new AbortController().signal, deadline: 0 },
      ),
    );

    const messages = calls[0]?.['messages'] as Array<{ content: unknown }>;
    expect(messages[0]?.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQIDBA==' } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'CQk=' },
      },
      {
        type: 'text',
        text: '<attached_document name="memo.docx" untrusted="true">\nmemo body\n</attached_document>',
      },
      { type: 'text', text: 'summarise' },
    ]);
  });
});
