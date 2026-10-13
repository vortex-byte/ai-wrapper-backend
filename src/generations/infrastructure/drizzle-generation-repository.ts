import { and, eq, sql } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { generationJobs, idempotencyKeys, messageParts } from '@/db/schema.ts';
import { withTransaction, type TransactionContext } from '@/db/tx.ts';
import type { GenerationStatus } from '../domain/generation.ts';
import type {
  CheckpointTextInput,
  GenerationRecord,
  GenerationRepository,
  InsertGenerationInput,
  StaleGenerationRow,
  StoredIdempotentResponse,
  TransitionTerminalInput,
} from '../ports/generation-repository.ts';

const generationColumns = {
  id: generationJobs.id,
  requestId: generationJobs.requestId,
  userId: generationJobs.userId,
  conversationId: generationJobs.conversationId,
  assistantMessageId: generationJobs.assistantMessageId,
  modelId: generationJobs.modelId,
  providerId: generationJobs.providerId,
  status: generationJobs.status,
  runnerId: generationJobs.runnerId,
  cancelReason: generationJobs.cancelReason,
  startedAt: generationJobs.startedAt,
  heartbeatAt: generationJobs.heartbeatAt,
  finishedAt: generationJobs.finishedAt,
  lastEventSeq: generationJobs.lastEventSeq,
  estInputTokens: generationJobs.estInputTokens,
  maxOutputTokens: generationJobs.maxOutputTokens,
  modelLock: generationJobs.modelLock,
  options: generationJobs.options,
  contextInfo: generationJobs.contextInfo,
  errorCategory: generationJobs.errorCategory,
  errorDetail: generationJobs.errorDetail,
  providerRequestId: generationJobs.providerRequestId,
  providerLatencyMs: generationJobs.providerLatencyMs,
  attempt: generationJobs.attempt,
  supersededBy: generationJobs.supersededBy,
  createdAt: generationJobs.createdAt,
} as const;

interface GenerationRow {
  id: string;
  requestId: string;
  userId: string;
  conversationId: string;
  assistantMessageId: string;
  modelId: string;
  providerId: string;
  status: string;
  runnerId: string | null;
  cancelReason: string | null;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  lastEventSeq: number;
  estInputTokens: number | null;
  maxOutputTokens: number;
  modelLock: unknown;
  options: unknown;
  contextInfo: unknown;
  errorCategory: string | null;
  errorDetail: unknown;
  providerRequestId: string | null;
  providerLatencyMs: number | null;
  attempt: number;
  supersededBy: string | null;
  createdAt: Date;
}

function asObject(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toRecord(row: GenerationRow): GenerationRecord {
  return {
    id: row.id,
    requestId: row.requestId,
    userId: row.userId,
    conversationId: row.conversationId,
    assistantMessageId: row.assistantMessageId,
    modelId: row.modelId,
    providerId: row.providerId,
    status: row.status as GenerationStatus,
    runnerId: row.runnerId,
    cancelReason: row.cancelReason,
    startedAt: row.startedAt,
    heartbeatAt: row.heartbeatAt,
    finishedAt: row.finishedAt,
    lastEventSeq: row.lastEventSeq,
    estInputTokens: row.estInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    modelLock: asObject(row.modelLock),
    options: asObject(row.options),
    contextInfo: asObject(row.contextInfo),
    errorCategory: row.errorCategory,
    errorDetail: row.errorDetail === null ? null : asObject(row.errorDetail),
    providerRequestId: row.providerRequestId,
    providerLatencyMs: row.providerLatencyMs,
    attempt: row.attempt,
    supersededBy: row.supersededBy,
    createdAt: row.createdAt,
  };
}

export class DrizzleGenerationRepository implements GenerationRepository {
  async insert(input: InsertGenerationInput, tx: TransactionContext): Promise<GenerationRecord> {
    const rows = await runDb(tx)
      .insert(generationJobs)
      .values({
        id: input.id,
        requestId: input.requestId,
        userId: input.userId,
        conversationId: input.conversationId,
        assistantMessageId: input.assistantMessageId,
        modelId: input.modelId,
        providerId: input.providerId,
        status: 'pending',
        estInputTokens: input.estInputTokens,
        maxOutputTokens: input.maxOutputTokens,
        modelLock: input.modelLock as Record<string, unknown>,
        options: input.options as Record<string, unknown>,
        contextInfo: input.contextInfo as Record<string, unknown>,
      })
      .returning(generationColumns);
    const row = rows[0];
    if (!row) throw new Error('insert into generation_jobs returned no row');
    return toRecord(row as GenerationRow);
  }

  async findByIdForUser(
    id: string,
    userId: string,
    tx?: TransactionContext,
  ): Promise<GenerationRecord | null> {
    const rows = await runDb(tx)
      .select(generationColumns)
      .from(generationJobs)
      .where(and(eq(generationJobs.id, id), eq(generationJobs.userId, userId)))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row as GenerationRow) : null;
  }

  async findById(id: string, tx?: TransactionContext): Promise<GenerationRecord | null> {
    const rows = await runDb(tx)
      .select(generationColumns)
      .from(generationJobs)
      .where(eq(generationJobs.id, id))
      .limit(1);
    const row = rows[0];
    return row ? toRecord(row as GenerationRow) : null;
  }

  async checkpointText(input: CheckpointTextInput, tx?: TransactionContext): Promise<void> {
    const execute = async (context: TransactionContext | undefined) => {
      if (input.chunk.length > 0) {
        await runDb(context)
          .update(messageParts)
          .set({
            textContent: sql`COALESCE(${messageParts.textContent}, '') || ${input.chunk}`,
            updatedAt: new Date(),
          })
          .where(eq(messageParts.id, input.partId));
      }

      await runDb(context)
        .update(generationJobs)
        .set({
          heartbeatAt: input.heartbeatAt,
          lastEventSeq: input.lastEventSeq,
        })
        .where(eq(generationJobs.id, input.generationId));
    };

    if (tx) {
      await execute(tx);
    } else {
      await withTransaction(async (innerTx) => execute(innerTx));
    }
  }

  async transitionToTerminal(
    input: TransitionTerminalInput,
    tx?: TransactionContext,
  ): Promise<boolean> {
    const values: Record<string, unknown> = {
      status: input.status,
      finishedAt: input.finishedAt,
    };
    if (input.cancelReason !== undefined) values['cancelReason'] = input.cancelReason;
    if (input.errorCategory !== undefined) values['errorCategory'] = input.errorCategory;
    if (input.errorDetail !== undefined) values['errorDetail'] = input.errorDetail;

    const rows = await runDb(tx)
      .update(generationJobs)
      .set(values)
      .where(
        and(
          eq(generationJobs.id, input.generationId),
          sql`${generationJobs.status} IN ('pending', 'generating')`,
        ),
      )
      .returning({ id: generationJobs.id });

    return rows.length > 0;
  }

  async markGenerating(id: string, startedAt: Date, tx?: TransactionContext): Promise<void> {
    await runDb(tx)
      .update(generationJobs)
      .set({
        status: 'generating',
        startedAt,
        heartbeatAt: startedAt,
      })
      .where(and(eq(generationJobs.id, id), eq(generationJobs.status, 'pending')));
  }

  async claimIdempotencyKey(
    input: {
      readonly userId: string;
      readonly key: string;
      readonly endpoint: string;
      readonly requestHash: string;
      readonly expiresAt: Date;
    },
    tx: TransactionContext,
  ): Promise<
    | { readonly claimed: true }
    | { readonly claimed: false; readonly stored: StoredIdempotentResponse }
  > {
    // S4 (AGENTS §6.12): `DO UPDATE` (not `DO NOTHING`) so a concurrent uncommitted insert with
    // the same (user_id, key) is waited on; the loser then returns the winner's row and replays.
    // `xmax = 0` distinguishes the freshly-inserted row (a true claim) from an updated existing
    // one (a replay), which `DO NOTHING` cannot express.
    const rows = await runDb(tx)
      .insert(idempotencyKeys)
      .values({
        userId: input.userId,
        key: input.key,
        endpoint: input.endpoint,
        requestHash: input.requestHash,
        responseStatus: 0,
        responseBody: {},
        expiresAt: input.expiresAt,
      })
      .onConflictDoUpdate({
        target: [idempotencyKeys.userId, idempotencyKeys.key],
        set: { requestHash: sql`${idempotencyKeys.requestHash}` },
      })
      .returning({
        requestHash: idempotencyKeys.requestHash,
        responseStatus: idempotencyKeys.responseStatus,
        responseBody: idempotencyKeys.responseBody,
        isNew: sql<boolean>`xmax = 0`,
      });
    const row = rows[0];
    if (!row) throw new Error('idempotency claim returned no row');
    if (row.isNew) return { claimed: true };
    return {
      claimed: false,
      stored: {
        requestHash: row.requestHash,
        responseStatus: row.responseStatus,
        responseBody: row.responseBody,
      },
    };
  }

  async storeIdempotentResponse(
    input: {
      readonly userId: string;
      readonly key: string;
      readonly responseStatus: number;
      readonly responseBody: unknown;
    },
    tx: TransactionContext,
  ): Promise<void> {
    await runDb(tx)
      .update(idempotencyKeys)
      .set({
        responseStatus: input.responseStatus,
        responseBody: input.responseBody as Record<string, unknown>,
      })
      .where(and(eq(idempotencyKeys.userId, input.userId), eq(idempotencyKeys.key, input.key)));
  }

  async countActiveForUser(userId: string, tx?: TransactionContext): Promise<number> {
    const rows = await runDb(tx)
      .select({ count: sql<number>`count(*)::int` })
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.userId, userId),
          sql`${generationJobs.status} IN ('pending','generating')`,
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async countActiveNodeWide(tx?: TransactionContext): Promise<number> {
    const rows = await runDb(tx)
      .select({ count: sql<number>`count(*)::int` })
      .from(generationJobs)
      .where(sql`${generationJobs.status} IN ('pending','generating')`);
    return rows[0]?.count ?? 0;
  }

  async findStaleGenerations(
    criteria: {
      readonly generatingHeartbeatOlderThanSeconds: number;
      readonly pendingOlderThanSeconds: number;
      readonly limit?: number;
    },
    tx?: TransactionContext,
  ): Promise<readonly StaleGenerationRow[]> {
    const limit = criteria.limit ?? 100;
    const query = sql`
      SELECT id, assistant_message_id as "assistantMessageId", status
      FROM generation_jobs
      WHERE (status = 'generating' AND COALESCE(heartbeat_at, started_at, created_at) < now() - (${criteria.generatingHeartbeatOlderThanSeconds} || ' seconds')::interval)
         OR (status = 'pending' AND created_at < now() - (${criteria.pendingOlderThanSeconds} || ' seconds')::interval)
      ORDER BY created_at ASC
      LIMIT ${limit};
    `;
    const res = await runDb(tx).execute(query);
    return (res.rows as unknown as Array<{ id: string; assistantMessageId: string; status: string }>).map((row) => ({
      id: row.id,
      assistantMessageId: row.assistantMessageId,
      status: row.status,
    }));
  }
}
