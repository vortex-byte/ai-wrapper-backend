import { describe, expect, it } from 'vitest';
import { EnvSecretResolver } from '@/providers/ports/secret-resolver.ts';
import { CreateProviderBodySchema } from '@/providers/http/schemas.ts';

describe('EnvSecretResolver & SecretRef validation', () => {
  it('resolves valid secret variable names from environment', () => {
    const resolver = new EnvSecretResolver({
      OPENAI_API_KEY: 'sk-test-12345',
      EMPTY_KEY: '   ',
    });

    expect(resolver.resolve('OPENAI_API_KEY')).toBe('sk-test-12345');
    expect(resolver.resolve('EMPTY_KEY')).toBeNull();
    expect(resolver.resolve('NONEXISTENT_KEY')).toBeNull();
  });

  it('blocks resolution of sensitive platform secrets as defense-in-depth', () => {
    const resolver = new EnvSecretResolver({
      SESSION_SECRET: 'super-secret-session-value',
      DATABASE_URL: 'postgres://app:pwd@localhost:5432/db',
      TEST_DATABASE_URL: 'postgres://app:pwd@localhost:5432/test_db',
      MIGRATION_DATABASE_URL: 'postgres://app:pwd@localhost:5432/mig_db',
      ANTHROPIC_API_KEY: 'anthropic-secret',
    });

    expect(resolver.resolve('SESSION_SECRET')).toBeNull();
    expect(resolver.resolve('session_secret')).toBeNull();
    expect(resolver.resolve('DATABASE_URL')).toBeNull();
    expect(resolver.resolve('TEST_DATABASE_URL')).toBeNull();
    expect(resolver.resolve('MIGRATION_DATABASE_URL')).toBeNull();
    expect(resolver.resolve('ANTHROPIC_API_KEY')).toBe('anthropic-secret');
  });

  it('rejects forbidden secretRefs and invalid schemes in HTTP schema', () => {
    const valid = CreateProviderBodySchema.safeParse({
      key: 'openai',
      displayName: 'OpenAI',
      adapter: 'openai',
      secretRef: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(valid.success).toBe(true);

    const forbiddenSecret = CreateProviderBodySchema.safeParse({
      key: 'openai',
      displayName: 'OpenAI',
      adapter: 'openai',
      secretRef: 'SESSION_SECRET',
    });
    expect(forbiddenSecret.success).toBe(false);

    const nonKeySecret = CreateProviderBodySchema.safeParse({
      key: 'openai',
      displayName: 'OpenAI',
      adapter: 'openai',
      secretRef: 'MY_RANDOM_ENV',
    });
    expect(nonKeySecret.success).toBe(false);

    const invalidScheme = CreateProviderBodySchema.safeParse({
      key: 'openai',
      displayName: 'OpenAI',
      adapter: 'openai',
      secretRef: 'OPENAI_API_KEY',
      baseUrl: 'ftp://api.openai.com',
    });
    expect(invalidScheme.success).toBe(false);
  });
});
