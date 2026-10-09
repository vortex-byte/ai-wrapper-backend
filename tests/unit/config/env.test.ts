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
    expect(config.PASSWORD_MIN_LENGTH).toBe(12);
    expect(config.LOGIN_MAX_FAILURES).toBe(8);
    expect(config.ALLOWED_ORIGINS).toEqual([]);
  });

  it('coerces booleans from every documented spelling', () => {
    expect(loadConfig({ ...validEnv, RETAIN_EXTRACTIONS: 'false' }).RETAIN_EXTRACTIONS).toBe(false);
    expect(loadConfig({ ...validEnv, RETAIN_EXTRACTIONS: '0' }).RETAIN_EXTRACTIONS).toBe(false);
    expect(loadConfig({ ...validEnv, LOG_CONTENT: 'true' }).LOG_CONTENT).toBe(true);
    expect(loadConfig({ ...validEnv, LOG_CONTENT: 'off' }).LOG_CONTENT).toBe(false);
  });

  it('parses comma-separated origins', () => {
    const config = loadConfig({ ...validEnv, ALLOWED_ORIGINS: 'https://a.example, https://b.example' });
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

  it('rejects the dev session secret in production', () => {
    expect(() =>
      loadConfig({
        ...validEnv,
        NODE_ENV: 'production',
        SESSION_SECRET: 'dev-only-insecure-secret-change-me-32chars',
      }),
    ).toThrowError(ConfigError);
  });

  it('rejects LOG_CONTENT=true in production', () => {
    expect(() => loadConfig({ ...validEnv, NODE_ENV: 'production', LOG_CONTENT: 'true' })).toThrowError(
      ConfigError,
    );
  });

  it('rejects an absolute session timeout shorter than the idle timeout', () => {
    expect(() =>
      loadConfig({ ...validEnv, SESSION_IDLE_MINUTES: '600', SESSION_ABSOLUTE_MINUTES: '60' }),
    ).toThrowError(ConfigError);
  });
});
