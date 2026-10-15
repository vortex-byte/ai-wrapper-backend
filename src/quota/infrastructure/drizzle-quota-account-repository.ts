import { and, desc, eq, gt, lt, lte, sql } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { quotaAccounts, quotaLedger, quotaReservations } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import type {
  GetOrCreateAccountInput,
  LedgerAppendInput,
  LedgerEntryType,
  QuotaAccountRepository,
  QuotaAccountRow,
  QuotaReservationRow,
  ReserveAtomicResult,
} from '../ports/quota-account-repository.ts';

/**
 * Implementation of the quota accounting aggregate.
 */

const NULL_SCOPE_SENTINEL = '00000000-0000-0000-0000-000000000000';

interface AccountRowShape {
  id: string;
  userId: string;
  scopeType: string;
  scopeId: string | null;
  periodStart: Date;
  periodEnd: Date;
  baseLimitTokens: string | number;
  adjustmentTokens: string | number;
  usedTokens: string | number;
  reservedTokens: string | number;
  limits: unknown;
  updatedAt: Date;
}

function toNumber(value: string | number): number {
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

function toAccount(row: AccountRowShape): QuotaAccountRow {
  return {
    id: row.id,
    userId: row.userId,
    scopeType: row.scopeType as QuotaAccountRow['scopeType'],
    scopeId: row.scopeId,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    baseLimitTokens: toNumber(row.baseLimitTokens),
    adjustmentTokens: toNumber(row.adjustmentTokens),
    usedTokens: toNumber(row.usedTokens),
    reservedTokens: toNumber(row.reservedTokens),
    limits: (row.limits ?? {}) as Record<string, unknown>,
    updatedAt: row.updatedAt,
  };
}

interface ReservationRowShape {
  id: string;
  generationId: string;
  userId: string;
  accountId: string;
  reservedTokens: string | number;
  settledTokens: string | number | null;
  status: string;
  expiresAt: Date;
  createdAt: Date;
  finalizedAt: Date | null;
}

function toReservation(row: ReservationRowShape): QuotaReservationRow {
  return {
    id: row.id,
    generationId: row.generationId,
    userId: row.userId,
    accountId: row.accountId,
    reservedTokens: toNumber(row.reservedTokens),
    settledTokens: row.settledTokens === null ? null : toNumber(row.settledTokens),
    status: row.status as QuotaReservationRow['status'],
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    finalizedAt: row.finalizedAt,
  };
}

export class DrizzleQuotaAccountRepository implements QuotaAccountRepository {
  async getOrCreateAccount(
    input: GetOrCreateAccountInput,
    tx: TransactionContext,
  ): Promise<QuotaAccountRow> {
    const insertSql = `
      INSERT INTO quota_accounts
        (id, user_id, scope_type, scope_id, period_start, period_end, base_limit_tokens, adjustment_tokens, limits)
      VALUES ($1, $2, 'total', NULL, $3, $4, $5, 0, $6::jsonb)
      ON CONFLICT (user_id, scope_type, COALESCE(scope_id, '${NULL_SCOPE_SENTINEL}'::uuid), period_start)
      DO NOTHING
      RETURNING id
    `;
    const inserted = await tx.client.query<{ id: string }>(insertSql, [
      input.id,
      input.userId,
      input.periodStart,
      input.periodEnd,
      input.baseLimitTokens,
      JSON.stringify(input.limits),
    ]);

    if (inserted.rows.length === 0) {
      const existing = await this.findAccountAt(input.userId, input.periodStart, tx);
      if (existing === null) {
        throw new Error(
          `quota_accounts lazy creation raced but no row found for user ${input.userId}`,
        );
      }
      return existing;
    }

    const account = await this.findAccountAt(input.userId, input.periodStart, tx);
    if (account === null) {
      throw new Error('quota_accounts insert succeeded but row is unreadable');
    }
    await this.appendLedger(
      {
        userId: input.userId,
        accountId: account.id,
        generationId: null,
        entryType: 'period_open',
        tokensDelta: 0,
        usedAfter: account.usedTokens,
        reservedAfter: account.reservedTokens,
      },
      tx,
    );
    return account;
  }

  private async findAccountAt(
    userId: string,
    periodStart: Date,
    tx: TransactionContext,
  ): Promise<QuotaAccountRow | null> {
    const rows = await runDb(tx)
      .select()
      .from(quotaAccounts)
      .where(and(eq(quotaAccounts.userId, userId), eq(quotaAccounts.periodStart, periodStart)))
      .limit(1);
    const row = rows[0];
    return row ? toAccount(row as AccountRowShape) : null;
  }

  async findCurrentAccount(
    userId: string,
    now: Date,
    tx?: TransactionContext,
  ): Promise<QuotaAccountRow | null> {
    const rows = await runDb(tx)
      .select()
      .from(quotaAccounts)
      .where(
        and(
          eq(quotaAccounts.userId, userId),
          eq(quotaAccounts.scopeType, 'total'),
          lte(quotaAccounts.periodStart, now),
          sql`${quotaAccounts.periodEnd} > ${now}`,
        ),
      )
      .orderBy(desc(quotaAccounts.periodStart))
      .limit(1);
    const row = rows[0];
    return row ? toAccount(row as AccountRowShape) : null;
  }

  async reserveAtomic(
    accountId: string,
    reserveTokens: number,
    tx: TransactionContext,
  ): Promise<ReserveAtomicResult> {
    const result = await tx.client.query<{
      used_tokens: string;
      reserved_tokens: string;
      limit_tokens: string;
    }>(
      `
      UPDATE quota_accounts
         SET reserved_tokens = reserved_tokens + $2,
             updated_at = now()
       WHERE id = $1
         AND used_tokens + reserved_tokens + $2 <= base_limit_tokens + adjustment_tokens
      RETURNING used_tokens, reserved_tokens, base_limit_tokens + adjustment_tokens AS limit_tokens
      `,
      [accountId, reserveTokens],
    );
    const row = result.rows[0];
    if (row === undefined) {
      return { reserved: false, usedTokens: 0, reservedTokens: 0, limitTokens: 0 };
    }
    return {
      reserved: true,
      usedTokens: Number.parseInt(row.used_tokens, 10),
      reservedTokens: Number.parseInt(row.reserved_tokens, 10),
      limitTokens: Number.parseInt(row.limit_tokens, 10),
    };
  }

  async insertReservation(
    input: {
      readonly id: string;
      readonly generationId: string;
      readonly userId: string;
      readonly accountId: string;
      readonly reservedTokens: number;
      readonly expiresAt: Date;
    },
    tx: TransactionContext,
  ): Promise<void> {
    await runDb(tx).insert(quotaReservations).values({
      id: input.id,
      generationId: input.generationId,
      userId: input.userId,
      accountId: input.accountId,
      reservedTokens: input.reservedTokens,
      status: 'active',
      expiresAt: input.expiresAt,
    });
  }

  async lockReservationForGeneration(
    generationId: string,
    tx: TransactionContext,
  ): Promise<QuotaReservationRow | null> {
    const result = await tx.client.query<ReservationRowShape>(
      `SELECT id, generation_id AS "generationId", user_id AS "userId",
              account_id AS "accountId", reserved_tokens AS "reservedTokens",
              settled_tokens AS "settledTokens", status, expires_at AS "expiresAt",
              created_at AS "createdAt", finalized_at AS "finalizedAt"
         FROM quota_reservations WHERE generation_id = $1 FOR UPDATE`,
      [generationId],
    );
    const row = result.rows[0];
    return row ? toReservation(row) : null;
  }

  async applySettlement(
    accountId: string,
    reservedTokensToRemove: number,
    usedTokensToAdd: number,
    tx: TransactionContext,
  ): Promise<QuotaAccountRow | null> {
    const result = await tx.client.query<AccountRowShape>(
      `
      UPDATE quota_accounts
         SET reserved_tokens = GREATEST(0, reserved_tokens - $2),
             used_tokens = used_tokens + $3,
             updated_at = now()
       WHERE id = $1
      RETURNING id, user_id AS "userId", scope_type AS "scopeType", scope_id AS "scopeId",
                period_start AS "periodStart", period_end AS "periodEnd",
                base_limit_tokens AS "baseLimitTokens", adjustment_tokens AS "adjustmentTokens",
                used_tokens AS "usedTokens", reserved_tokens AS "reservedTokens",
                limits, updated_at AS "updatedAt"
      `,
      [accountId, reservedTokensToRemove, usedTokensToAdd],
    );
    const row = result.rows[0];
    return row ? toAccount(row) : null;
  }

  async finalizeReservation(
    generationId: string,
    status: 'settled' | 'released' | 'expired',
    settledTokens: number | null,
    finalizedAt: Date,
    tx: TransactionContext,
  ): Promise<void> {
    await runDb(tx)
      .update(quotaReservations)
      .set({ status, settledTokens, finalizedAt })
      .where(eq(quotaReservations.generationId, generationId));
  }

  async appendLedger(input: LedgerAppendInput, tx: TransactionContext): Promise<void> {
    await runDb(tx).insert(quotaLedger).values({
      userId: input.userId,
      accountId: input.accountId,
      generationId: input.generationId,
      entryType: input.entryType,
      tokensDelta: input.tokensDelta,
      usedAfter: input.usedAfter,
      reservedAfter: input.reservedAfter,
      actorUserId: input.actorUserId ?? null,
      reason: input.reason ?? null,
      requestId: input.requestId ?? null,
    });
  }

  async adjustLimit(
    accountId: string,
    delta: number,
    target: 'base' | 'adjustment',
    tx: TransactionContext,
  ): Promise<QuotaAccountRow | null> {
    const column = target === 'base' ? quotaAccounts.baseLimitTokens : quotaAccounts.adjustmentTokens;
    const rows = await runDb(tx)
      .update(quotaAccounts)
      .set({
        ...(target === 'base'
          ? { baseLimitTokens: sql`GREATEST(0, ${column} + ${delta})` }
          : { adjustmentTokens: sql`${column} + ${delta}` }),
        updatedAt: new Date(),
      })
      .where(eq(quotaAccounts.id, accountId))
      .returning();
    const row = rows[0];
    return row ? toAccount(row as AccountRowShape) : null;
  }

  async listAccountsForUser(
    userId: string,
    tx?: TransactionContext,
  ): Promise<readonly QuotaAccountRow[]> {
    const rows = await runDb(tx)
      .select()
      .from(quotaAccounts)
      .where(eq(quotaAccounts.userId, userId))
      .orderBy(desc(quotaAccounts.periodStart));
    return rows.map((row) => toAccount(row as AccountRowShape));
  }

  async listCurrentAccounts(
    now: Date,
    limit: number,
    tx?: TransactionContext,
  ): Promise<readonly QuotaAccountRow[]> {
    const rows = await runDb(tx)
      .select()
      .from(quotaAccounts)
      .where(and(lte(quotaAccounts.periodStart, now), gt(quotaAccounts.periodEnd, now)))
      .limit(limit);
    return rows.map((row) => toAccount(row as AccountRowShape));
  }

  async findExpiredActiveReservations(
    now: Date,
    limit: number,
    tx?: TransactionContext,
  ): Promise<readonly QuotaReservationRow[]> {
    const rows = await runDb(tx)
      .select()
      .from(quotaReservations)
      .where(and(eq(quotaReservations.status, 'active'), lt(quotaReservations.expiresAt, now)))
      .limit(limit);
    return rows.map((row) => toReservation(row as ReservationRowShape));
  }

  async listLedger(
    userId: string,
    limit: number,
    tx?: TransactionContext,
  ): Promise<
    readonly {
      readonly entryType: LedgerEntryType;
      readonly tokensDelta: number;
      readonly reason: string | null;
      readonly createdAt: Date;
      readonly requestId: string | null;
    }[]
  > {
    const rows = await runDb(tx)
      .select({
        entryType: quotaLedger.entryType,
        tokensDelta: quotaLedger.tokensDelta,
        reason: quotaLedger.reason,
        createdAt: quotaLedger.createdAt,
        requestId: quotaLedger.requestId,
      })
      .from(quotaLedger)
      .where(eq(quotaLedger.userId, userId))
      .orderBy(desc(quotaLedger.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      entryType: row.entryType as LedgerEntryType,
      tokensDelta: toNumber(row.tokensDelta),
      reason: row.reason,
      createdAt: row.createdAt,
      requestId: row.requestId,
    }));
  }

  async reconciliationTotals(
    accountId: string,
    tx?: TransactionContext,
  ): Promise<{
    readonly ledgerUsedTokens: number;
    readonly ledgerAdjustmentTokens: number;
    readonly liveReservedTokens: number;
  }> {
    const db = runDb(tx);

    const ledgerRes = await db.execute<{ ledger_used: string; ledger_adjust: string }>(sql`
      SELECT
        COALESCE(sum(CASE WHEN entry_type IN ('reserve','settle','release','expire_release')
                          THEN tokens_delta ELSE 0 END), 0) AS ledger_used,
        COALESCE(sum(CASE WHEN entry_type IN ('adjust', 'grant') THEN tokens_delta ELSE 0 END), 0) AS ledger_adjust
      FROM quota_ledger
      WHERE account_id = ${accountId}
    `);
    const ledgerRow = ledgerRes.rows[0];

    const reservedRes = await db.execute<{ live_reserved: string }>(sql`
      SELECT COALESCE(sum(reserved_tokens), 0) AS live_reserved
      FROM quota_reservations
      WHERE account_id = ${accountId} AND status = 'active'
    `);

    return {
      ledgerUsedTokens: ledgerRow ? Number.parseInt(ledgerRow.ledger_used, 10) : 0,
      ledgerAdjustmentTokens: ledgerRow ? Number.parseInt(ledgerRow.ledger_adjust, 10) : 0,
      liveReservedTokens: reservedRes.rows[0]
        ? Number.parseInt(reservedRes.rows[0].live_reserved, 10)
        : 0,
    };
  }
}
