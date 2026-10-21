import type { TransactionContext } from '@/db/tx.ts';

/** Persistence port for quota accounts, reservations, and ledger records. */

export interface QuotaAccountRow {
  readonly id: string;
  readonly userId: string;
  readonly scopeType: 'total' | 'provider' | 'model';
  readonly scopeId: string | null;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly baseLimitTokens: number;
  readonly adjustmentTokens: number;
  readonly usedTokens: number;
  readonly reservedTokens: number;
  readonly limits: Readonly<Record<string, unknown>>;
  readonly updatedAt: Date;
}

export interface QuotaReservationRow {
  readonly id: string;
  readonly generationId: string;
  readonly userId: string;
  readonly accountId: string;
  readonly reservedTokens: number;
  readonly settledTokens: number | null;
  readonly status: 'active' | 'settled' | 'released' | 'expired';
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly finalizedAt: Date | null;
}

export type LedgerEntryType =
  | 'period_open'
  | 'reserve'
  | 'settle'
  | 'release'
  | 'expire_release'
  | 'adjust'
  | 'grant'
  | 'rebase';

export interface LedgerAppendInput {
  readonly userId: string;
  readonly accountId: string;
  readonly generationId: string | null;
  readonly entryType: LedgerEntryType;
  readonly tokensDelta: number;
  readonly usedAfter: number;
  readonly reservedAfter: number;
  readonly actorUserId?: string | undefined;
  readonly reason?: string | undefined;
  readonly requestId?: string | undefined;
}

export interface GetOrCreateAccountInput {
  readonly id: string;
  readonly userId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly baseLimitTokens: number;
  readonly limits: Readonly<Record<string, unknown>>;
}

export interface ReserveAtomicResult {
  /** `null` rows ⇒ the conditional WHERE failed ⇒ quota_exceeded (429). */
  readonly reserved: boolean;
  readonly usedTokens: number;
  readonly reservedTokens: number;
  readonly limitTokens: number;
}

export interface QuotaAccountRepository {
  /**
   * Lazy period creation: inserts or returns existing account for the user's current period.
   */
  getOrCreateAccount(
    input: GetOrCreateAccountInput,
    tx: TransactionContext,
  ): Promise<QuotaAccountRow>;

  /**
   * Atomic reservation via conditional UPDATE. Returns reserved = false when over limit.
   */
  reserveAtomic(
    accountId: string,
    reserveTokens: number,
    tx: TransactionContext,
  ): Promise<ReserveAtomicResult>;

  /** The user's account for the current period, or null when none exists (no write). */
  findCurrentAccount(
    userId: string,
    now: Date,
    tx?: TransactionContext,
  ): Promise<QuotaAccountRow | null>;

  /** Insert the reservation row after `reserveAtomic` succeeds. */
  insertReservation(
    input: {
      readonly id: string;
      readonly generationId: string;
      readonly userId: string;
      readonly accountId: string;
      readonly reservedTokens: number;
      readonly expiresAt: Date;
    },
    tx: TransactionContext,
  ): Promise<void>;

  /** Locks reservation row for a generation in settlement transactions. */
  lockReservationForGeneration(
    generationId: string,
    tx: TransactionContext,
  ): Promise<QuotaReservationRow | null>;

  /** Unconditional balance update on settlement/release (settle: actual>0; release: actual=0). */
  applySettlement(
    accountId: string,
    reservedTokensToRemove: number,
    usedTokensToAdd: number,
    tx: TransactionContext,
  ): Promise<QuotaAccountRow | null>;

  /** Marks the reservation settled/released/expired. */
  finalizeReservation(
    generationId: string,
    status: 'settled' | 'released' | 'expired',
    settledTokens: number | null,
    finalizedAt: Date,
    tx: TransactionContext,
  ): Promise<void>;

  /** Append-only ledger write (DB grants forbid UPDATE/DELETE on this table). */
  appendLedger(input: LedgerAppendInput, tx: TransactionContext): Promise<void>;

  /** Admin adjustment: shift the base limit (policy change) or adjustment_tokens (grant/clawback). */
  adjustLimit(
    accountId: string,
    delta: number,
    target: 'base' | 'adjustment',
    tx: TransactionContext,
  ): Promise<QuotaAccountRow | null>;

  /** All accounts for the user (any period), newest first. */
  listAccountsForUser(userId: string, tx?: TransactionContext): Promise<readonly QuotaAccountRow[]>;

  /** Accounts for pre-creation/reconciliation sweeps: every user's current-period account. */
  listCurrentAccounts(now: Date, limit: number, tx?: TransactionContext): Promise<readonly QuotaAccountRow[]>;

  /** Expired active reservations to be reaped. */
  findExpiredActiveReservations(now: Date, limit: number, tx?: TransactionContext): Promise<
    readonly QuotaReservationRow[]
  >;

  /** Ledger tail for the admin quota view. */
  listLedger(
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
  >;

  /**
   * Reconciliation inputs: ledger-derived used/adjustment totals and live reserved sum for an account.
   */
  reconciliationTotals(
    accountId: string,
    tx?: TransactionContext,
  ): Promise<{
    readonly ledgerUsedTokens: number;
    readonly ledgerAdjustmentTokens: number;
    readonly liveReservedTokens: number;
  }>;
}
