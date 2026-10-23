import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadConfig,
  resetConfigForTests,
  setConfigForTests,
  type Config,
} from '@/config/env.ts';
import {
  closeLogger,
  createLogger,
  renderTextLine,
  scrubString,
  serializeLogPayload,
} from '@/observability/logger.ts';

/** Mirrors the level palette in `logger.ts` (`warn` yellow, `error` red). */
const LEVEL_COLOR = { warn: '\u001B[33m', error: '\u001B[31m' } as const;
const ANSI_RESET = '\u001B[0m';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  SESSION_SECRET: 'x'.repeat(32),
};

function configWith(overrides: Record<string, unknown>): Config {
  return loadConfig({ ...BASE_ENV, ...overrides });
}

afterEach(() => {
  closeLogger();
  resetConfigForTests();
});

describe('scrubString', () => {
  it('removes secret-shaped substrings from free text', () => {
    expect(scrubString('Authorization: Bearer abc123DEF456ghi')).not.toContain('abc123DEF456ghi');
    expect(scrubString('key=sk-ant-api03-abcdefghijklmnop')).not.toContain('sk-ant-api03');
    expect(scrubString('google AIzaSyA1234567890abcdefghijklmnop')).not.toContain('AIzaSy');
    expect(scrubString('password=hunter2 rest')).not.toContain('hunter2');
    expect(scrubString('postgresql://user:s3cret@db.internal:5432/app')).not.toContain('s3cret');
  });

  it('leaves ordinary text untouched', () => {
    expect(scrubString('generation finalized in 120ms')).toBe('generation finalized in 120ms');
  });
});

describe('serializeLogPayload', () => {
  it('redacts secret-bearing keys at any depth, in any casing', () => {
    const serialized = serializeLogPayload({
      requestId: 'req-1',
      password: 'hunter2',
      api_key: 'sk-live-1',
      nested: { authorization: 'Bearer abc', sessionToken: 'tok' },
      list: [{ newPassword: 'p' }],
    });

    expect(serialized).toMatchObject({
      requestId: 'req-1',
      password: '[redacted]',
      api_key: '[redacted]',
      nested: { authorization: '[redacted]', sessionToken: '[redacted]' },
      list: [{ newPassword: '[redacted]' }],
    });
  });

  it('keeps token counters that only look like secrets', () => {
    const serialized = serializeLogPayload({
      inputTokens: 12,
      outputTokens: 3,
      maxTokens: 100,
      tokenCount: 115,
      estimatedCostUsd: 0.5,
    });

    expect(serialized).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      maxTokens: 100,
      tokenCount: 115,
      estimatedCostUsd: 0.5,
    });
  });

  it('drops content-bearing keys instead of serializing them', () => {
    const serialized = serializeLogPayload({
      generationId: 'gen-1',
      prompt: 'tell me a secret',
      messages: [{ role: 'user', content: 'hello' }],
      body: '{"raw":true}',
    });

    expect(serialized).toEqual({ generationId: 'gen-1' });
    expect(JSON.stringify(serialized)).not.toContain('secret');
  });

  it('serializes an Error under any key, stack included and scrubbed', () => {
    const error = new TypeError('failed with token=abc123');
    const serialized = serializeLogPayload({ err: error }) as {
      err: { name: string; message: string; stack: string };
    };

    expect(serialized.err.name).toBe('TypeError');
    expect(serialized.err.message).toBe('failed with token=[redacted]');
    expect(serialized.err.stack).toContain('TypeError');
    expect(serialized.err.stack).not.toContain('abc123');
  });

  it('survives circular references', () => {
    const node: Record<string, unknown> = { id: 'a' };
    node['self'] = node;

    const serialized = serializeLogPayload({ node }) as { node: Record<string, unknown> };
    expect(serialized.node['id']).toBe('a');
    expect(serialized.node['self']).toBe('[circular]');
  });
});

describe('renderTextLine', () => {
  const base = { ts: '2026-10-22T08:41:44.183Z', level: 'info', msg: 'generation started' } as const;

  it('renders datetime __name__ - level - message - context', () => {
    const line = renderTextLine(
      { ...base, generationId: 'gen-1', provider: 'openai' },
      { name: 'orchestrator', colorize: false },
    );

    expect(line).toBe(
      '2026-10-22 08:41:44.183 orchestrator - info  - generation started - generationId=gen-1 provider=openai',
    );
  });

  it('omits the context segment when there is no metadata', () => {
    expect(renderTextLine(base, { name: 'api', colorize: false })).toBe(
      '2026-10-22 08:41:44.183 api - info  - generation started',
    );
  });

  it('sets request ids apart after a pipe and quotes values that need it', () => {
    const line = renderTextLine(
      { ...base, path: '/api/generations', note: 'two words', requestId: 'req-1' },
      { name: 'api', colorize: false },
    );

    expect(line.endsWith(' | requestId=req-1')).toBe(true);
    expect(line).toContain('path=/api/generations');
    expect(line).toContain('note="two words"');
  });

  it('renders an error after the context, with an indented stack', () => {
    const serialized = serializeLogPayload({ err: new TypeError('kaboom token=abc123') }) as {
      err: { stack: string };
    };
    const line = renderTextLine(
      { ...base, level: 'error', generationId: 'gen-2', err: serialized.err },
      { name: 'api', colorize: false },
    );
    const [head, ...rest] = line.split('\n');

    expect(head).toContain('generationId=gen-2');
    expect(rest[0]).toBe('err="TypeError: kaboom token=[redacted]"');
    expect(rest[1]).toMatch(/^ {4}TypeError: kaboom token=\[redacted\]$/);
  });

  it('colors the level per severity and leaves plain output free of ANSI codes', () => {
    const warn = renderTextLine({ ...base, level: 'warn' }, { name: 'api', colorize: true });
    const error = renderTextLine({ ...base, level: 'error' }, { name: 'api', colorize: true });

    expect(warn).toContain(`${LEVEL_COLOR.warn}warn${ANSI_RESET}  -`);
    expect(error).toContain(`${LEVEL_COLOR.error}error${ANSI_RESET} -`);
    expect(
      renderTextLine({ ...base, level: 'error' }, { name: 'api', colorize: false }),
    ).not.toContain('\u001B[');
  });
});

describe('createLogger console transport', () => {
  it('writes plain-text lines to stdout, not JSON, and keeps errors off stderr', async () => {
    setConfigForTests(configWith({ NODE_ENV: 'development', LOG_TO_FILES: 'false' }));
    // The console transport caches `console._stdout` at construction, ahead of `process.stdout`.
    // `_stdout` is not in the public `Console` type, hence the cast.
    const sink = (console as unknown as { _stdout: NodeJS.WriteStream })._stdout;
    const writes: string[] = [];
    const original = sink.write.bind(sink);
    sink.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof sink.write;

    try {
      const logger = createLogger({ fileLogging: false, name: 'test-logger' });
      logger.info({ generationId: 'gen-1', prompt: 'do not log me' }, 'generation started');
      logger.error({ err: new Error('kaboom') }, 'generation failed');
      // Console output is flushed asynchronously by the underlying stream.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      sink.write = original;
    }

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} test-logger - info {2}- generation started - /,
    );
    expect(writes[0]).toContain('generationId=gen-1');
    expect(writes[0]).not.toContain('do not log me');
    expect(writes[0]).not.toContain('"msg":');
    expect(writes[0]).not.toContain('timestamp=');

    expect(writes[1]).toContain(' - error - generation failed');
    expect(writes[1]).toContain('err="Error: kaboom"');
    expect(writes[1]).toMatch(/\n {4}Error: kaboom/);
  });
});

describe('createLogger file transports', () => {
  it('writes JSON lines to app-*.log and errors (with stacks) to error-*.log', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aichat-logs-'));
    setConfigForTests(configWith({ NODE_ENV: 'development', LOG_DIR: dir, LOG_TO_FILES: 'true' }));

    try {
      const logger = createLogger({ fileLogging: true });
      logger.info({ generationId: 'gen-1', prompt: 'do not log me' }, 'generation started');
      logger.error({ err: new Error('kaboom'), requestId: 'req-1' }, 'generation failed');

      const day = new Date().toISOString().slice(0, 10);
      const appFile = path.join(dir, `app-${day}.log`);
      const errorFile = path.join(dir, `error-${day}.log`);

      const appContents = await waitForFile(appFile, 'generation failed');
      const errorContents = await waitForFile(errorFile, 'generation failed');

      expect(appContents).toContain('"msg":"generation started"');
      expect(appContents).toContain('"generationId":"gen-1"');
      expect(appContents).not.toContain('do not log me');

      expect(errorContents).toContain('"msg":"generation failed"');
      expect(errorContents).toContain('"stack":"Error: kaboom');
      expect(errorContents).not.toContain('generation started');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function waitForFile(file: string, needle: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const contents = readFileSync(file, 'utf8');
      if (contents.includes(needle)) return contents;
    } catch {
      // Waiting for the file to be created.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for "${needle}" in ${file}`);
}
