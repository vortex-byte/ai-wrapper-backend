import { describe, expect, it } from 'vitest';
import { EXAMPLE_MODELS, EXAMPLE_PROVIDERS } from '@/db/seed.ts';

describe('example registry seed data', () => {
  it('references providers only by env var name, never a secret value', () => {
    for (const provider of EXAMPLE_PROVIDERS) {
      expect(provider.secretRef).toMatch(/_API_KEY$/);
      expect(provider.secretRef).not.toMatch(/sk-|key-|secret-/i);
    }
  });

  it('every example model points at a declared provider', () => {
    const providerKeys = new Set(EXAMPLE_PROVIDERS.map((p) => p.key));
    for (const model of EXAMPLE_MODELS) {
      expect(providerKeys.has(model.providerKey)).toBe(true);
    }
  });

  it('has unique provider and model keys', () => {
    const providerKeys = EXAMPLE_PROVIDERS.map((p) => p.key);
    const modelKeys = EXAMPLE_MODELS.map((m) => m.key);
    expect(new Set(providerKeys).size).toBe(providerKeys.length);
    expect(new Set(modelKeys).size).toBe(modelKeys.length);
  });
});
