import { describe, expect, it } from 'vitest';
import type { Clock } from '@/clock/index.ts';
import type { ModelCapabilities } from '@/providers/domain/capabilities.ts';
import { parseCapabilities } from '@/providers/domain/capabilities-schema.ts';
import type { ModelRecord, ProviderRecord } from '@/providers/domain/registry.ts';
import { CachedModelRegistry } from '@/providers/infrastructure/cached-registry.ts';
import type { RegistryRepository } from '@/providers/ports/registry-repository.ts';
import type { SecretResolver } from '@/providers/ports/secret-resolver.ts';

class MutableClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: 'prov-1',
    key: 'openai',
    displayName: 'OpenAI',
    adapter: 'openai',
    baseUrl: null,
    secretRef: 'OPENAI_API_KEY',
    status: 'active',
    config: {},
    configVersion: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function model(overrides: Partial<ModelRecord> = {}): ModelRecord {
  const capabilities: ModelCapabilities = parseCapabilities({
    contextWindow: 8_192,
    maxOutputTokens: 1_024,
  });
  return {
    id: 'model-1',
    providerId: 'prov-1',
    providerKey: 'openai',
    providerDisplayName: 'OpenAI',
    providerStatus: 'active',
    key: 'gpt',
    apiModelId: 'gpt-4o-mini',
    displayName: 'GPT',
    description: null,
    status: 'active',
    capabilities,
    contextWindow: 8_192,
    maxOutputTokens: 1_024,
    defaultMaxOutputTokens: 1_024,
    quotaWeight: 1,
    config: {},
    sortOrder: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

/** Counts how many times the repository was actually read. */
class CountingRepository implements RegistryRepository {
  loads = 0;
  constructor(
    public providers: ProviderRecord[],
    public models: ModelRecord[],
  ) {}
  async findAllProviders(): Promise<ProviderRecord[]> {
    this.loads += 1;
    return this.providers;
  }
  async findAllModels(): Promise<ModelRecord[]> {
    return this.models;
  }
  async findProviderById(id: string): Promise<ProviderRecord | null> {
    return this.providers.find((p) => p.id === id) ?? null;
  }
  async findProviderByKey(key: string): Promise<ProviderRecord | null> {
    return this.providers.find((p) => p.key === key) ?? null;
  }
  async createProvider(): Promise<ProviderRecord> {
    throw new Error('not used');
  }
  async updateProvider(): Promise<ProviderRecord | null> {
    throw new Error('not used');
  }
  async findModelById(id: string): Promise<ModelRecord | null> {
    return this.models.find((m) => m.id === id) ?? null;
  }
  async findModelByKey(key: string): Promise<ModelRecord | null> {
    return this.models.find((m) => m.key === key) ?? null;
  }
  async createModel(): Promise<ModelRecord> {
    throw new Error('not used');
  }
  async updateModel(): Promise<ModelRecord | null> {
    throw new Error('not used');
  }
  async listPrices(): Promise<never[]> {
    return [];
  }
  async upsertPrice(): Promise<never> {
    throw new Error('not used');
  }
}

const secrets: SecretResolver = {
  resolve: (ref) => (ref === 'OPENAI_API_KEY' ? 'sk-test' : null),
};

describe('CachedModelRegistry', () => {
  it('serves the same snapshot within the TTL and reloads after it', async () => {
    const clock = new MutableClock(new Date('2026-01-01T00:00:00Z'));
    const repository = new CountingRepository([provider()], [model()]);
    const registry = new CachedModelRegistry({ repository, secrets, clock, ttlMs: 30_000 });

    await registry.listVisibleModels();
    await registry.listVisibleModels();
    expect(repository.loads).toBe(1);

    clock.advance(30_001);
    await registry.listVisibleModels();
    expect(repository.loads).toBe(2);
  });

  it('coalesces concurrent load calls onto a single repository round-trip', async () => {
    const clock = new MutableClock(new Date('2026-01-01T00:00:00Z'));
    const repository = new CountingRepository([provider()], [model()]);
    const registry = new CachedModelRegistry({ repository, secrets, clock, ttlMs: 30_000 });

    const [a, b, c] = await Promise.all([
      registry.listVisibleModels(),
      registry.listAllModels(),
      registry.listAllProviders(),
    ]);

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
    expect(repository.loads).toBe(1);
  });

  it('invalidate() forces an immediate reload', async () => {
    const clock = new MutableClock(new Date('2026-01-01T00:00:00Z'));
    const repository = new CountingRepository([provider()], [model()]);
    const registry = new CachedModelRegistry({ repository, secrets, clock, ttlMs: 30_000 });

    await registry.listVisibleModels();
    registry.invalidate();
    await registry.listVisibleModels();
    expect(repository.loads).toBe(2);
  });

  it('hides disabled providers and disabled models from the picker', async () => {
    const clock = new MutableClock(new Date('2026-01-01T00:00:00Z'));
    const repository = new CountingRepository(
      [provider({ id: 'prov-1' }), provider({ id: 'prov-2', status: 'disabled' })],
      [
        model({ id: 'active', providerId: 'prov-1', status: 'active' }),
        model({ id: 'disabled', providerId: 'prov-1', status: 'disabled' }),
        model({ id: 'on-disabled-provider', providerId: 'prov-2', status: 'active' }),
      ],
    );
    const registry = new CachedModelRegistry({ repository, secrets, clock });

    const visible = await registry.listVisibleModels();
    expect(visible.map((m) => m.id)).toEqual(['active']);
  });

  it('resolves secrets from the resolver and never leaks a missing key', async () => {
    const clock = new MutableClock(new Date('2026-01-01T00:00:00Z'));
    const repository = new CountingRepository(
      [provider({ secretRef: 'MISSING_KEY' })],
      [model()],
    );
    const registry = new CachedModelRegistry({ repository, secrets, clock });

    const resolved = await registry.getRuntimeConfig('model-1');
    expect(resolved).not.toBeNull();
    expect(resolved?.runtime.provider.secrets).toEqual({});

    const withKey = new CountingRepository([provider()], [model()]);
    const registryTwo = new CachedModelRegistry({ repository: withKey, secrets, clock });
    const resolvedTwo = await registryTwo.getRuntimeConfig('model-1');
    expect(resolvedTwo?.runtime.provider.secrets).toEqual({ apiKey: 'sk-test' });
    expect(JSON.stringify(resolvedTwo?.runtime.model)).not.toContain('sk-test');
  });
});
