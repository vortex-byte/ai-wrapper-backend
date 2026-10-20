import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAIAdapter,
  containerFileHandle,
  mimeFromFilename,
  parseContainerFileHandle,
  type OpenAIClientLike,
} from '@/providers/infrastructure/adapters/openai/adapter.ts';
import { makeChatRequest } from '@/providers/infrastructure/fake/fake-provider.ts';
import type { NormalizedChatRequest } from '@/providers/domain/capabilities.ts';
import type { GenerationEvent } from '@/providers/domain/pal.ts';

const API_KEY = 'sk-test-key-01234567890123456789';

function makeRequest(overrides: Partial<NormalizedChatRequest> = {}): NormalizedChatRequest {
  const base = makeChatRequest({
    provider: {
      providerId: 'p-openai',
      key: 'openai',
      adapter: 'openai',
      config: {},
      secrets: { apiKey: API_KEY },
    },
    model: {
      modelId: 'm-openai',
      providerId: 'p-openai',
      apiModelId: 'gpt-5.1',
      displayName: 'GPT-5.1',
      capabilities: {
        streaming: true,
        vision: true,
        documents: { pdf: true },
        imageGeneration: false,
        documentGeneration: true,
        systemPrompt: true,
        tools: true,
        contextWindow: 200_000,
        maxOutputTokens: 8_192,
      },
      maxOutputTokens: 8_192,
      defaultMaxOutputTokens: 4_096,
      quotaWeight: 1,
      config: {},
    },
  });
  return { ...base, ...overrides };
}

interface FakeResponsesClient {
  readonly client: OpenAIClientLike;
  readonly responsesCalls: Array<Record<string, unknown>>;
  readonly chatCalls: Array<Record<string, unknown>>;
}

function fakeClient(events: unknown[]): FakeResponsesClient {
  const responsesCalls: Array<Record<string, unknown>> = [];
  const chatCalls: Array<Record<string, unknown>> = [];
  return {
    responsesCalls,
    chatCalls,
    client: {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: async (params: unknown) => {
            chatCalls.push(params as Record<string, unknown>);
            return (async function* () {
              yield { id: 'chatcmpl-1', choices: [{ index: 0, delta: { content: 'ok' } }] };
            })();
          },
        },
      },
      responses: {
        create: async (params: unknown) => {
          responsesCalls.push(params as Record<string, unknown>);
          return (async function* () {
            for (const event of events) yield event;
          })();
        },
      },
    },
  };
}

async function collect(adapter: OpenAIAdapter, req: NormalizedChatRequest): Promise<GenerationEvent[]> {
  const out: GenerationEvent[] = [];
  for await (const event of adapter.execute(req, {
    signal: new AbortController().signal,
    deadline: Date.now() + 5_000,
  })) {
    out.push(event);
  }
  return out;
}

/** Minimal Responses text-only turn. */
const textTurn = [
  { type: 'response.created', response: { id: 'resp_123' } },
  {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: 'msg_1', type: 'message', status: 'in_progress' },
  },
  { type: 'response.output_text.delta', output_index: 0, delta: 'Here ' },
  { type: 'response.output_text.delta', output_index: 0, delta: 'you go' },
  { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message' } },
  {
    type: 'response.completed',
    response: {
      id: 'resp_123',
      status: 'completed',
      usage: {
        input_tokens: 120,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
      output: [],
    },
  },
];

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  stubFetch(() => jsonResponse({ data: [] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAIAdapter — document generation (Unit)', () => {
  it('runs container turns on the Responses API instead of Chat Completions', async () => {
    const fake = fakeClient(textTurn);
    const adapter = new OpenAIAdapter(() => fake.client);

    const events = await collect(
      adapter,
      makeRequest({ container: { codeExecution: true } }),
    );

    expect(fake.chatCalls).toHaveLength(0);
    expect(fake.responsesCalls).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'stop' });
  });

  it('declares code_interpreter with an auto container and requests its outputs', async () => {
    const fake = fakeClient(textTurn);
    const adapter = new OpenAIAdapter(() => fake.client);

    await collect(adapter, makeRequest({ container: { codeExecution: true } }));

    const params = fake.responsesCalls[0] ?? {};
    expect(params['tools']).toEqual([{ type: 'code_interpreter', container: { type: 'auto' } }]);
    expect(params['include']).toEqual(['code_interpreter_call.outputs']);
    expect(params['store']).toBe(false);
    expect(params['stream']).toBe(true);
  });

  it('declares the hosted shell with skills for document generation', async () => {
    const fake = fakeClient(textTurn);
    const adapter = new OpenAIAdapter(() => fake.client);

    await collect(
      adapter,
      makeRequest({ container: { codeExecution: true, skills: ['xlsx', 'docx'] } }),
    );

    const params = fake.responsesCalls[0] ?? {};
    // Only `openai-spreadsheets` is documented by id; unmapped skills run on the shell toolchain.
    expect(params['tools']).toEqual([
      {
        type: 'shell',
        environment: {
          type: 'container_auto',
          skills: [{ type: 'skill_reference', skill_id: 'openai-spreadsheets', version: 'latest' }],
        },
      },
    ]);
    expect(params['include']).toBeUndefined();
  });

  it('lets the registry pin exact OpenAI skill ids', async () => {
    const fake = fakeClient(textTurn);
    const adapter = new OpenAIAdapter(() => fake.client);
    const req = makeRequest({ container: { codeExecution: true, skills: ['pptx'] } });

    await collect(adapter, {
      ...req,
      model: {
        ...req.model,
        config: { openaiSkills: [{ id: 'skill_abc', version: '2' }, 'openai-spreadsheets'] },
      },
    });

    const tools = (fake.responsesCalls[0] ?? {})['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]?.['environment']).toEqual({
      type: 'container_auto',
      skills: [
        { type: 'skill_reference', skill_id: 'skill_abc', version: '2' },
        { type: 'skill_reference', skill_id: 'openai-spreadsheets', version: 'latest' },
      ],
    });
  });

  it('reuses a pinned container and tells the model where to write files', async () => {
    const fake = fakeClient(textTurn);
    const adapter = new OpenAIAdapter(() => fake.client);

    await collect(
      adapter,
      makeRequest({
        container: { codeExecution: true, containerId: 'cntr_abc', skills: ['xlsx'] },
      }),
    );

    const params = fake.responsesCalls[0] ?? {};
    const tools = params['tools'] as Array<Record<string, unknown>>;
    expect(tools[0]?.['environment']).toEqual({
      type: 'container_reference',
      container_id: 'cntr_abc',
    });
    expect(String(params['instructions'])).toContain('/mnt/data');
  });

  it('translates text, tool and annotation events into PAL events', async () => {
    const fake = fakeClient([
      { type: 'response.created', response: { id: 'resp_1' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'ci_1', type: 'code_interpreter_call', container_id: 'cntr_1', status: 'in_progress' },
      },
      { type: 'response.code_interpreter_call_code.delta', item_id: 'ci_1', delta: 'print(1)' },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'ci_1',
          type: 'code_interpreter_call',
          container_id: 'cntr_1',
          status: 'completed',
          outputs: [{ type: 'logs', logs: '1\n' }],
        },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { id: 'msg_1', type: 'message' },
      },
      { type: 'response.output_text.delta', output_index: 1, delta: 'Done' },
      {
        type: 'response.output_text.annotation.added',
        item_id: 'msg_1',
        output_index: 1,
        annotation: {
          type: 'container_file_citation',
          container_id: 'cntr_1',
          file_id: 'cfile_1',
          filename: 'report.xlsx',
        },
      },
      {
        type: 'response.completed',
        response: { id: 'resp_1', usage: { input_tokens: 5, output_tokens: 2 }, output: [] },
      },
    ]);
    const adapter = new OpenAIAdapter(() => fake.client);

    const events = await collect(adapter, makeRequest({ container: { codeExecution: true } }));

    expect(events[0]).toEqual({ type: 'started', providerRequestId: 'resp_1' });
    expect(events).toContainEqual({
      type: 'tool_started',
      toolCallId: 'ci_1',
      name: 'code_interpreter',
    });
    expect(events).toContainEqual({ type: 'tool_delta', toolCallId: 'ci_1', delta: 'print(1)' });
    expect(events).toContainEqual({ type: 'tool_delta', toolCallId: 'ci_1', delta: '1\n' });
    expect(events).toContainEqual({
      type: 'tool_completed',
      toolCallId: 'ci_1',
      status: 'success',
    });
    // Both `code_interpreter_call.completed` and `output_item.done` report the same call.
    expect(events.filter((e) => e.type === 'tool_completed')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool_started')).toHaveLength(1);
    expect(events).toContainEqual({
      type: 'artifact_emitted',
      providerFileId: containerFileHandle('cntr_1', 'cfile_1'),
      filename: 'report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(events).toContainEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0, source: 'provider' },
      final: true,
    });
    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'stop' });
  });

  it('translates hosted shell events and captures its container id', async () => {
    const fake = fakeClient([
      { type: 'response.created', response: { id: 'resp_shell' } },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'sh_1',
          type: 'shell_call',
          status: 'in_progress',
          action: { commands: ['python make_docx.py'] },
          environment: { type: 'container_reference', container_id: 'cntr_shell' },
        },
      },
      { type: 'response.shell_call_command.delta', item_id: 'sh_1', delta: ' && ls' },
      {
        type: 'response.shell_call_output_content.delta',
        item_id: 'sh_1',
        delta: 'wrote report.docx',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'sh_1',
          type: 'shell_call',
          status: 'completed',
          environment: { type: 'container_reference', container_id: 'cntr_shell' },
        },
      },
      { type: 'response.completed', response: { id: 'resp_shell' } },
    ]);
    const adapter = new OpenAIAdapter(() => fake.client);

    const events = await collect(
      adapter,
      makeRequest({ container: { codeExecution: true, skills: ['docx'] } }),
    );

    expect(events).toContainEqual({
      type: 'tool_started',
      toolCallId: 'sh_1',
      name: 'shell',
      input: { commands: ['python make_docx.py'] },
    });
    expect(events).toContainEqual({
      type: 'tool_delta',
      toolCallId: 'sh_1',
      delta: ' && ls',
    });
    expect(events).toContainEqual({
      type: 'tool_delta',
      toolCallId: 'sh_1',
      delta: 'wrote report.docx',
    });
    expect(events.filter((e) => e.type === 'tool_completed')).toEqual([
      { type: 'tool_completed', toolCallId: 'sh_1', status: 'success' },
    ]);
  });

  it('sweeps generated container files and de-duplicates cited ones', async () => {
    stubFetch((url) => {
      expect(url).toContain('/containers/cntr_1/files');
      return jsonResponse({
        data: [
          { id: 'cfile_in', path: '/mnt/data/input.csv', source: 'user', bytes: 10 },
          { id: 'cfile_1', path: '/mnt/data/report.xlsx', source: 'assistant', bytes: 2048 },
          { id: 'cfile_2', path: '/mnt/data/summary.docx', source: 'assistant', bytes: 512 },
        ],
      });
    });

    const fake = fakeClient([
      { type: 'response.created', response: { id: 'resp_2' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'ci_1', type: 'code_interpreter_call', container_id: 'cntr_1', status: 'completed' },
      },
      {
        type: 'response.output_text.annotation.added',
        annotation: {
          type: 'container_file_citation',
          container_id: 'cntr_1',
          file_id: 'cfile_1',
          filename: 'report.xlsx',
        },
      },
      { type: 'response.completed', response: { id: 'resp_2', output: [] } },
    ]);
    const adapter = new OpenAIAdapter(() => fake.client);

    const events = await collect(adapter, makeRequest({ container: { codeExecution: true } }));
    const artifacts = events.filter((e) => e.type === 'artifact_emitted');

    expect(artifacts).toEqual([
      {
        type: 'artifact_emitted',
        providerFileId: containerFileHandle('cntr_1', 'cfile_1'),
        filename: 'report.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      {
        type: 'artifact_emitted',
        providerFileId: containerFileHandle('cntr_1', 'cfile_2'),
        filename: 'summary.docx',
        sizeBytes: 512,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ]);
  });

  it('bounds how many container files one turn can hydrate', async () => {
    stubFetch(() =>
      jsonResponse({
        data: Array.from({ length: 30 }, (_, index) => ({
          id: `cfile_${index}`,
          path: `/mnt/data/file-${index}.csv`,
          source: 'assistant',
        })),
      }),
    );

    const fake = fakeClient([
      { type: 'response.created', response: { id: 'resp_cap' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'ci_1', type: 'code_interpreter_call', container_id: 'cntr_1', status: 'completed' },
      },
      { type: 'response.completed', response: { id: 'resp_cap' } },
    ]);
    const adapter = new OpenAIAdapter(() => fake.client);

    const events = await collect(adapter, makeRequest({ container: { codeExecution: true } }));

    expect(events.filter((e) => e.type === 'artifact_emitted')).toHaveLength(20);
  });

  it('does not fail the turn when listing container files fails', async () => {
    stubFetch(() => jsonResponse({ error: 'boom' }, 500));
    const fake = fakeClient([
      { type: 'response.created', response: { id: 'resp_3' } },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: { id: 'ci_1', type: 'code_interpreter_call', container_id: 'cntr_1', status: 'completed' },
      },
      { type: 'response.completed', response: { id: 'resp_3' } },
    ]);
    const adapter = new OpenAIAdapter(() => fake.client);

    const events = await collect(adapter, makeRequest({ container: { codeExecution: true } }));

    expect(events.at(-1)).toEqual({ type: 'finished', reason: 'stop' });
  });

  it('keeps Chat Completions when the provider opts out', async () => {
    const fake = fakeClient(textTurn);
    const adapter = new OpenAIAdapter(() => fake.client);
    const req = makeRequest({ container: { codeExecution: true } });

    await collect(adapter, {
      ...req,
      provider: { ...req.provider, config: { useChatCompletions: true } },
    });

    expect(fake.chatCalls).toHaveLength(1);
    expect(fake.responsesCalls).toHaveLength(0);
  });

  it('errors instead of silently ignoring the container when the client has no Responses API', async () => {
    const client: OpenAIClientLike = {
      models: { list: async () => ({ data: [] }) },
      chat: {
        completions: {
          create: async () => (async function* () {})(),
        },
      },
    };
    const adapter = new OpenAIAdapter(() => client);

    const events = await collect(adapter, makeRequest({ container: { codeExecution: true } }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
  });

  it('maps response.failed and error events onto provider errors', async () => {
    const fake = fakeClient([
      { type: 'response.created', response: { id: 'resp_4' } },
      { type: 'response.failed', response: { id: 'resp_4', error: { code: 'server_error', message: 'nope' } } },
    ]);
    const adapter = new OpenAIAdapter(() => fake.client);

    const events = await collect(adapter, makeRequest({ container: { codeExecution: true } }));

    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { category: 'provider_unavailable', retryable: true },
    });
  });

  it('downloads container files through the container files API', async () => {
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '3' },
      });
    });

    const adapter = new OpenAIAdapter();
    const artifact = await adapter.fetchArtifactStream(
      containerFileHandle('cntr_1', 'cfile_1'),
      {
        provider: makeRequest().provider,
        signal: new AbortController().signal,
      },
    );

    expect(urls[0]).toBe(
      'https://api.openai.com/v1/containers/cntr_1/files/cfile_1/content',
    );
    expect(artifact.sizeBytes).toBe(3);
    expect(artifact.mimeType).toBe('application/pdf');
  });

  it('uploads input files with purpose user_data', async () => {
    let body: unknown;
    stubFetch((url, init) => {
      expect(url).toBe('https://api.openai.com/v1/files');
      body = init?.body;
      return jsonResponse({ id: 'file-abc' });
    });

    const adapter = new OpenAIAdapter();
    const uploaded = await adapter.uploadInputFile(
      { filename: 'data.csv', mimeType: 'text/csv', bytes: new Uint8Array([1, 2]) },
      { provider: makeRequest().provider, signal: new AbortController().signal },
    );

    expect(uploaded).toEqual({ providerFileId: 'file-abc' });
    expect(body).toBeInstanceOf(FormData);
    expect((body as FormData).get('purpose')).toBe('user_data');
  });
});

describe('container file handles', () => {
  it('round-trips a handle', () => {
    const handle = containerFileHandle('cntr_1', 'cfile_2');
    expect(handle).toBe('container:cntr_1:cfile_2');
    expect(parseContainerFileHandle(handle)).toEqual({ containerId: 'cntr_1', fileId: 'cfile_2' });
  });

  it('ignores plain file ids and malformed handles', () => {
    expect(parseContainerFileHandle('file-abc')).toBeNull();
    expect(parseContainerFileHandle('container:')).toBeNull();
    expect(parseContainerFileHandle('container:cntr_1')).toBeNull();
    expect(parseContainerFileHandle('container::cfile_1')).toBeNull();
  });

  it('maps common artifact extensions to MIME types', () => {
    expect(mimeFromFilename('report.XLSX')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(mimeFromFilename('chart.png')).toBe('image/png');
    expect(mimeFromFilename('no-extension')).toBeUndefined();
  });
});
