import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@/config/env.ts';

const validEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const config = loadConfig(validEnv);
    expect(config.PORT).toBe(8080);
    expect(config.HOST).toBe('127.0.0.1');
    expect(config.ROLE).toBe('all');
    expect(config.QUOTA_TIMEZONE).toBe('Asia/Jakarta');
    expect(config.SESSION_IDLE_MINUTES).toBe(480);
    expect(config.SESSION_ABSOLUTE_MINUTES).toBe(1440);
    expect(config.PASSWORD_MIN_LENGTH).toBe(8);
    expect(config.LOGIN_MAX_FAILURES).toBe(8);
    expect(config.ALLOWED_ORIGINS).toEqual([]);
    expect(config.SHUTDOWN_DRAIN_SECONDS).toBe(120);
    expect(config.TOKENIZER_CACHE_DIR).toBe('./.cache/tokenizer');
    expect(config.MIGRATION_DATABASE_URL).toBeUndefined();
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('treats an empty optional value as unset, not as an invalid string', () => {
    const config = loadConfig({
      ...validEnv,
      MIGRATION_DATABASE_URL: '',
      TEST_DATABASE_URL: '',
      REDIS_URL: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    });
    expect(config.MIGRATION_DATABASE_URL).toBeUndefined();
    expect(config.TEST_DATABASE_URL).toBeUndefined();
    expect(config.REDIS_URL).toBeUndefined();
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
  });

  it('accepts a valid OTLP endpoint and rejects a malformed one', () => {
    expect(
      loadConfig({ ...validEnv, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' })
        .OTEL_EXPORTER_OTLP_ENDPOINT,
    ).toBe('http://127.0.0.1:4318');
    expect(() =>
      loadConfig({ ...validEnv, OTEL_EXPORTER_OTLP_ENDPOINT: 'not-a-url' }),
    ).toThrowError(ConfigError);
  });

  it('coerces booleans from every documented spelling', () => {
    expect(loadConfig({ ...validEnv, RETAIN_EXTRACTIONS: 'false' }).RETAIN_EXTRACTIONS).toBe(false);
    expect(loadConfig({ ...validEnv, RETAIN_EXTRACTIONS: '0' }).RETAIN_EXTRACTIONS).toBe(false);
    expect(loadConfig({ ...validEnv, LOG_CONTENT: 'true' }).LOG_CONTENT).toBe(true);
    expect(loadConfig({ ...validEnv, LOG_CONTENT: 'off' }).LOG_CONTENT).toBe(false);
  });

  it('parses comma-separated origins', () => {
    const config = loadConfig({
      ...validEnv,
      ALLOWED_ORIGINS: 'https://a.example, https://b.example',
    });
    expect(config.ALLOWED_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('throws with an actionable message when DATABASE_URL is missing', () => {
    let error: unknown;
    try {
      loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(32) });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.join('\n')).toContain('DATABASE_URL');
  });

  it('requires SESSION_SECRET (no default)', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: validEnv.DATABASE_URL }),
    ).toThrowError(ConfigError);
  });

  it('rejects a SESSION_SECRET shorter than 32 chars', () => {
    expect(() => loadConfig({ ...validEnv, SESSION_SECRET: 'too-short' })).toThrowError(
      ConfigError,
    );
  });

  it('rejects LOG_CONTENT=true in production', () => {
    expect(() =>
      loadConfig({ ...validEnv, NODE_ENV: 'production', LOG_CONTENT: 'true' }),
    ).toThrowError(ConfigError);
  });

  it('rejects an absolute session timeout shorter than the idle timeout', () => {
    expect(() =>
      loadConfig({ ...validEnv, SESSION_IDLE_MINUTES: '600', SESSION_ABSOLUTE_MINUTES: '60' }),
    ).toThrowError(ConfigError);
  });

  it('bounds the shutdown drain window', () => {
    expect(loadConfig({ ...validEnv, SHUTDOWN_DRAIN_SECONDS: '0' }).SHUTDOWN_DRAIN_SECONDS).toBe(0);
    expect(() => loadConfig({ ...validEnv, SHUTDOWN_DRAIN_SECONDS: '601' })).toThrowError(
      ConfigError,
    );
  });

  it('applies the generation defaults and bounds the detach timeout', () => {
    const config = loadConfig(validEnv);
    expect(config.MAX_ACTIVE_GENERATIONS).toBe(200);
    expect(config.GENERATION_DETACH_TIMEOUT_SECONDS).toBe(60);
    // Bounded 10–900 so an operator cannot disable the guard or set an absurd grace.
    expect(
      loadConfig({ ...validEnv, GENERATION_DETACH_TIMEOUT_SECONDS: '10' })
        .GENERATION_DETACH_TIMEOUT_SECONDS,
    ).toBe(10);
    expect(() =>
      loadConfig({ ...validEnv, GENERATION_DETACH_TIMEOUT_SECONDS: '9' }),
    ).toThrowError(ConfigError);
    expect(() =>
      loadConfig({ ...validEnv, GENERATION_DETACH_TIMEOUT_SECONDS: '901' }),
    ).toThrowError(ConfigError);
    expect(() => loadConfig({ ...validEnv, MAX_ACTIVE_GENERATIONS: '0' })).toThrowError(ConfigError);
  });
});
