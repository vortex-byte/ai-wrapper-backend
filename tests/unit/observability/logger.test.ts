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
  scrubString,
  serializeLogPayload,
} from '@/observability/logger.ts';

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
