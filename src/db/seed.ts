import { getConfig } from '../config/index.ts';
import { getPool } from './pool.ts';
import { withTransaction } from './tx.ts';

export interface SeedResult {
  readonly seeded: boolean;
  readonly reason: string;
  readonly inserted: Readonly<Record<string, number>>;
}

export interface ExampleProvider {
  readonly key: string;
  readonly displayName: string;
  readonly adapter: string;
  readonly secretRef: string;
}

export interface ExampleModel {
  readonly providerKey: string;
  readonly key: string;
  readonly apiModelId: string;
  readonly displayName: string;
}

export const EXAMPLE_PROVIDERS: readonly ExampleProvider[] = [
  { key: 'openai', displayName: 'OpenAI', adapter: 'openai', secretRef: 'OPENAI_API_KEY' },
  { key: 'fake', displayName: 'Fake Provider', adapter: 'fake', secretRef: 'FAKE_API_KEY' },

  {
    key: 'anthropic',
    displayName: 'Anthropic',
    adapter: 'anthropic',
    secretRef: 'ANTHROPIC_API_KEY',
  },
];

export const EXAMPLE_MODELS: readonly ExampleModel[] = [
  {
    providerKey: 'fake',
    key: 'fake-model',
    apiModelId: 'fake-model',
    displayName: 'Fake Model (development)',
  },
  {
    providerKey: 'openai',
    key: 'gpt-4o-mini',
    apiModelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
  },
  {
    providerKey: 'openai',
    key: 'gpt-4o',
    apiModelId: 'gpt-4o',
    displayName: 'GPT-4o',
  },
  {
    providerKey: 'anthropic',
    key: 'claude-sonnet',
    apiModelId: 'claude-3-5-sonnet-latest',
    displayName: 'Claude 3.5 Sonnet',
  },
];

/** True when the provider registry table exists. */
async function registryTablesPresent(): Promise<boolean> {
  const { rows } = await getPool().query<{ present: string | null }>(
    `SELECT to_regclass('public.ai_providers')::text AS present`,
  );
  return rows[0]?.present !== null && rows[0]?.present !== undefined;
}

/**
 * Idempotent: re-running inserts nothing new. Refuses in production.
 */
export async function runExampleSeed(): Promise<SeedResult> {
  const config = getConfig();
  if (config.NODE_ENV === 'production') {
    throw new Error('db:seed:example must never run against production.');
  }

  if (!(await registryTablesPresent())) {
    return {
      seeded: false,
      reason: 'registry tables not present yet',
      inserted: {},
    };
  }

  const inserted: Record<string, number> = { providers: 0, models: 0 };

  await withTransaction(async (tx) => {
    for (const provider of EXAMPLE_PROVIDERS) {
      const res = await tx.client.query(
        `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)
         ON CONFLICT (key) DO NOTHING`,
        [provider.key, provider.displayName, provider.adapter, provider.secretRef],
      );
      inserted.providers = (inserted.providers ?? 0) + (res.rowCount ?? 0);
    }
    for (const model of EXAMPLE_MODELS) {
      const res = await tx.client.query(
        `INSERT INTO ai_models (id, provider_id, key, api_model_id, display_name, capabilities,
                                context_window, max_output_tokens, default_max_output_tokens)
         SELECT gen_random_uuid(), p.id, $2, $3, $4, '{"schemaVersion":1}'::jsonb, 128000, 4096, 4096
           FROM ai_providers p
          WHERE p.key = $1
         ON CONFLICT (key) DO NOTHING`,
        [model.providerKey, model.key, model.apiModelId, model.displayName],
      );
      inserted.models = (inserted.models ?? 0) + (res.rowCount ?? 0);
    }
  });

  return {
    seeded: true,
    reason: `seeded ${inserted.providers ?? 0} provider(s), ${inserted.models ?? 0} model(s)`,
    inserted,
  };
}
