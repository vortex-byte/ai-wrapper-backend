import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '@/db/index.ts';
import { runMigrations } from '@/db/migrate.ts';
import { getMigrationState } from '@/db/migrations.ts';
import { resetDatabase } from './helpers/reset.ts';

/** Integration tests for migration baseline and triggers against real PostgreSQL. */
describe('migration baseline', () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it('is idempotent — a second run applies nothing', async () => {
    const second = await runMigrations();
    expect(second.applied).toHaveLength(0);
    expect(second.skipped.length).toBeGreaterThanOrEqual(5);
  });

  it('reports a clean, ready state', async () => {
    const state = await getMigrationState();
    expect(state.pending).toEqual([]);
    expect(state.drifted).toEqual([]);
    expect(state.ready).toBe(true);
  });

  it('creates the baseline tables', async () => {
    const { rows } = await getPool().query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const names = rows.map((row) => row.table_name);
    for (const expected of [
      'ai_model_prices',
      'ai_models',
      'ai_providers',
      'audit_logs',
      'conversations',
      'divisions',
      'error_events',
      'generation_jobs',
      'idempotency_keys',
      'jobs',
      'message_parts',
      'messages',
      'quota_accounts',
      'quota_ledger',
      'quota_policies',
      'quota_reservations',
      'schema_migrations',
      'sessions',
      'system_settings',
      'usage_daily',
      'usage_events',
      'users',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('installs the citext extension and case-insensitive email uniqueness', async () => {
    const { rows } = await getPool().query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'citext'`,
    );
    expect(rows.map((row) => row.extname)).toContain('citext');
  });

  it('seeds the quota.timezone system setting', async () => {
    const { rows } = await getPool().query<{ value: string }>(
      `SELECT value FROM system_settings WHERE key = 'quota.timezone'`,
    );
    expect(rows[0]?.value).toBe('Asia/Jakarta');
  });

  describe('conversation model lock', () => {
    /** Resets database state between tests to prevent fixture leakage. */
    afterEach(async () => {
      await resetDatabase();
    });

    /** Insert a user + provider + model and return the ids needed by the trigger. */
    async function seedConversationFixture(): Promise<{
      userId: string;
      modelA: string;
      modelB: string;
      conversationId: string;
    }> {
      const pool = getPool();
      const userId = crypto.randomUUID();
      const providerId = crypto.randomUUID();
      const modelA = crypto.randomUUID();
      const modelB = crypto.randomUUID();
      const conversationId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO users (id, email, display_name, password_hash, role)
         VALUES ($1, $2, 'Test User', 'x', 'user')`,
        [userId, `${userId}@example.test`],
      );
      await pool.query(
        `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref)
         VALUES ($1, $2, 'Test Provider', 'fake', 'TEST_KEY')`,
        [providerId, `p-${providerId}`],
      );
      for (const modelId of [modelA, modelB]) {
        await pool.query(
          `INSERT INTO ai_models (id, provider_id, key, api_model_id, display_name, status,
                                  capabilities, context_window, max_output_tokens, default_max_output_tokens)
           VALUES ($1, $2, $3, $4, 'Test Model', 'active', '{"schemaVersion":1}', 8192, 1024, 1024)`,
          [modelId, providerId, `m-${modelId}`, `api-${modelId}`],
        );
      }
      await pool.query(
        `INSERT INTO conversations (id, user_id, model_id) VALUES ($1, $2, $3)`,
        [conversationId, userId, modelA],
      );
      return { userId, modelA, modelB, conversationId };
    }

    it('allows changing the model while no messages exist', async () => {
      const { conversationId, modelB } = await seedConversationFixture();
      await expect(
        getPool().query(`UPDATE conversations SET model_id = $2 WHERE id = $1`, [
          conversationId,
          modelB,
        ]),
      ).resolves.toBeDefined();
    });

    it('rejects changing the model once message_count > 0', async () => {
      const { conversationId, modelB } = await seedConversationFixture();
      await getPool().query(`UPDATE conversations SET message_count = 2 WHERE id = $1`, [
        conversationId,
      ]);
      await expect(
        getPool().query(`UPDATE conversations SET model_id = $2 WHERE id = $1`, [
          conversationId,
          modelB,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('rejects a completed binary part without a file', async () => {
      const { conversationId } = await seedConversationFixture();
      const messageId = crypto.randomUUID();
      await getPool().query(
        `INSERT INTO messages (id, conversation_id, seq, role, status)
         VALUES ($1, $2, 1, 'user', 'complete')`,
        [messageId, conversationId],
      );
      await expect(
        getPool().query(
          `INSERT INTO message_parts (id, message_id, position, type)
           VALUES ($1, $2, 0, 'image')`,
          [crypto.randomUUID(), messageId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('generation_jobs invariants', () => {
    afterEach(async () => {
      await resetDatabase();
    });

    /** A minimal user → provider → model → conversation → assistant message chain. */
    async function seedGenerationFixture(): Promise<{
      userId: string;
      modelId: string;
      providerId: string;
      conversationId: string;
      messageId: string;
    }> {
      const pool = getPool();
      const userId = crypto.randomUUID();
      const providerId = crypto.randomUUID();
      const modelId = crypto.randomUUID();
      const conversationId = crypto.randomUUID();
      const messageId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO users (id, email, display_name, password_hash, role)
         VALUES ($1, $2, 'Gen User', 'x', 'user')`,
        [userId, `${userId}@example.test`],
      );
      await pool.query(
        `INSERT INTO ai_providers (id, key, display_name, adapter, secret_ref)
         VALUES ($1, $2, 'Gen Provider', 'fake', 'TEST_KEY')`,
        [providerId, `p-${providerId}`],
      );
      await pool.query(
        `INSERT INTO ai_models (id, provider_id, key, api_model_id, display_name, status,
                                capabilities, context_window, max_output_tokens, default_max_output_tokens)
         VALUES ($1, $2, $3, $4, 'Gen Model', 'active', '{"schemaVersion":1}', 8192, 1024, 1024)`,
        [modelId, providerId, `m-${modelId}`, `api-${modelId}`],
      );
      await pool.query(`INSERT INTO conversations (id, user_id, model_id) VALUES ($1, $2, $3)`, [
        conversationId,
        userId,
        modelId,
      ]);
      await pool.query(
        `INSERT INTO messages (id, conversation_id, seq, role, status)
         VALUES ($1, $2, 1, 'assistant', 'streaming')`,
        [messageId, conversationId],
      );
      return { userId, modelId, providerId, conversationId, messageId };
    }

    async function insertGeneration(
      fixture: { userId: string; modelId: string; providerId: string; conversationId: string; messageId: string },
      overrides: { status?: string; requestId?: string; finishedAt?: string | null } = {},
    ): Promise<string> {
      const id = crypto.randomUUID();
      await getPool().query(
        `INSERT INTO generation_jobs
           (id, request_id, user_id, conversation_id, assistant_message_id, model_id, provider_id,
            status, max_output_tokens, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1024, $9)`,
        [
          id,
          overrides.requestId ?? `req-${id}`,
          fixture.userId,
          fixture.conversationId,
          fixture.messageId,
          fixture.modelId,
          fixture.providerId,
          overrides.status ?? 'pending',
          overrides.finishedAt ?? null,
        ],
      );
      return id;
    }

    it('allows only one active generation per conversation (partial unique index)', async () => {
      const fixture = await seedGenerationFixture();
      await insertGeneration(fixture, { status: 'pending' });

      await expect(insertGeneration(fixture, { status: 'pending' })).rejects.toMatchObject({
        code: '23505',
      });
    });

    it('requires started_at once a generation is generating', async () => {
      const fixture = await seedGenerationFixture();
      await expect(insertGeneration(fixture, { status: 'generating' })).rejects.toMatchObject({
        code: '23514',
      });
    });

    it('frees the conversation slot once a generation reaches a terminal state', async () => {
      const fixture = await seedGenerationFixture();
      const first = await insertGeneration(fixture, { status: 'pending' });
      await getPool().query(
        `UPDATE generation_jobs SET status = 'completed', finished_at = now() WHERE id = $1`,
        [first],
      );
      await expect(insertGeneration(fixture, { status: 'pending' })).resolves.toBeDefined();
    });

    it('refuses a terminal state without finished_at', async () => {
      const fixture = await seedGenerationFixture();
      const id = await insertGeneration(fixture, { status: 'pending' });
      await expect(
        getPool().query(`UPDATE generation_jobs SET status = 'cancelled' WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('rejects a duplicate request_id', async () => {
      const fixture = await seedGenerationFixture();
      await insertGeneration(fixture, { requestId: 'req-duplicate' });
      await expect(insertGeneration(fixture, { requestId: 'req-duplicate' })).rejects.toMatchObject(
        { code: '23505' },
      );
    });

    it('enforces the deferred quota_reservations → generation_jobs FK', async () => {
      const pool = getPool();
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*) FROM pg_constraint WHERE conname = 'quota_reservations_generation_fk'`,
      );
      expect(rows[0]?.count).toBe('1');
    });
  });
});
