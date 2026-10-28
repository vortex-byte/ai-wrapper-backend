import { eq, sql, type SQL } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { divisions } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import { AppError } from '@/errors.ts';
import type {
  CreateDivisionInput,
  Division,
  DivisionReferenceCounts,
  DivisionRepository,
  DivisionStatsRange,
  DivisionWithStats,
  UpdateDivisionInput,
} from '../ports/division-repository.ts';

const MICROS_PER_USD = 1_000_000;

const divisionColumns = {
  id: divisions.id,
  name: divisions.name,
  externalRef: divisions.externalRef,
  createdAt: divisions.createdAt,
} as const;

interface StatsRow {
  id: string;
  name: string;
  externalRef: string | null;
  createdAt: string | Date;
  memberCount: number;
  tokens: string | number;
  requests: number;
  costMicros: string | number | null;
  monthlyTokens: string | number | null;
}

function toDivisionWithStats(row: StatsRow): DivisionWithStats {
  return {
    id: row.id,
    name: row.name,
    externalRef: row.externalRef,
    // Raw `execute()` skips drizzle's column parsers, so timestamptz arrives as text.
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
    memberCount: Number(row.memberCount),
    tokens: Number(row.tokens),
    requests: Number(row.requests),
    costUsd: row.costMicros === null ? null : Number(row.costMicros) / MICROS_PER_USD,
    monthlyTokens: row.monthlyTokens === null ? null : Number(row.monthlyTokens),
  };
}

export class DrizzleDivisionRepository implements DivisionRepository {
  async findById(id: string, tx?: TransactionContext): Promise<Division | null> {
    const rows = await runDb(tx)
      .select(divisionColumns)
      .from(divisions)
      .where(eq(divisions.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByName(name: string, tx?: TransactionContext): Promise<Division | null> {
    const rows = await runDb(tx)
      .select(divisionColumns)
      .from(divisions)
      .where(eq(divisions.name, name))
      .limit(1);
    return rows[0] ?? null;
  }

  async findByExternalRef(externalRef: string, tx?: TransactionContext): Promise<Division | null> {
    const rows = await runDb(tx)
      .select(divisionColumns)
      .from(divisions)
      .where(eq(divisions.externalRef, externalRef))
      .limit(1);
    return rows[0] ?? null;
  }

  async findMany(tx?: TransactionContext): Promise<Division[]> {
    return runDb(tx).select(divisionColumns).from(divisions).orderBy(divisions.name);
  }

  async findManyWithStats(
    range: DivisionStatsRange,
    tx?: TransactionContext,
  ): Promise<DivisionWithStats[]> {
    const rows = await this.statsQuery(range, undefined, tx);
    return rows.map(toDivisionWithStats);
  }

  async findWithStats(
    id: string,
    range: DivisionStatsRange,
    tx?: TransactionContext,
  ): Promise<DivisionWithStats | null> {
    const rows = await this.statsQuery(range, id, tx);
    const row = rows[0];
    return row === undefined ? null : toDivisionWithStats(row);
  }

  async create(input: CreateDivisionInput, tx?: TransactionContext): Promise<Division> {
    const rows = await runDb(tx)
      .insert(divisions)
      .values({
        id: input.id,
        name: input.name,
        externalRef: input.externalRef ?? null,
      })
      .returning(divisionColumns);
    const row = rows[0];
    if (!row) throw new AppError('internal_error', 'insert into divisions returned no row');
    return row;
  }

  async update(input: UpdateDivisionInput, tx?: TransactionContext): Promise<Division> {
    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) updates.name = input.name;
    if (input.externalRef !== undefined) updates.externalRef = input.externalRef;

    const rows = await runDb(tx)
      .update(divisions)
      .set(updates)
      .where(eq(divisions.id, input.id))
      .returning(divisionColumns);
    const row = rows[0];
    if (!row) throw new AppError('not_found', `division not found: ${input.id}`);
    return row;
  }

  async countReferences(
    id: string,
    tx?: TransactionContext,
  ): Promise<DivisionReferenceCounts> {
    const result = await runDb(tx).execute(sql`
      SELECT
        (SELECT count(*)::int FROM users WHERE division_id = ${id}::uuid AND deleted_at IS NULL) AS "users",
        (SELECT count(*)::int FROM quota_policies WHERE division_id = ${id}::uuid) AS "quotaPolicies",
        (SELECT count(*)::int FROM usage_events WHERE division_id = ${id}::uuid) AS "usageEvents",
        (SELECT count(*)::int FROM usage_daily WHERE division_id = ${id}::uuid) AS "usageDaily"
    `);
    const row = result.rows[0] as DivisionReferenceCounts | undefined;
    if (row === undefined) {
      return { users: 0, quotaPolicies: 0, usageEvents: 0, usageDaily: 0 };
    }
    return {
      users: Number(row.users),
      quotaPolicies: Number(row.quotaPolicies),
      usageEvents: Number(row.usageEvents),
      usageDaily: Number(row.usageDaily),
    };
  }

  async delete(id: string, tx?: TransactionContext): Promise<boolean> {
    await runDb(tx).execute(sql`
      UPDATE users
         SET division_id = NULL,
             role = CASE WHEN role = 'admin' THEN 'user' ELSE role END,
             updated_at = now()
       WHERE division_id = ${id}::uuid AND deleted_at IS NOT NULL
    `);
    const rows = await runDb(tx)
      .delete(divisions)
      .where(eq(divisions.id, id))
      .returning({ id: divisions.id });
    return rows.length > 0;
  }

  private async statsQuery(
    range: DivisionStatsRange,
    id: string | undefined,
    tx?: TransactionContext,
  ): Promise<StatsRow[]> {
    const idFilter: SQL = id === undefined ? sql`` : sql`AND d.id = ${id}::uuid`;

    const result = await runDb(tx).execute(sql`
      SELECT
        d.id,
        d.name,
        d.external_ref AS "externalRef",
        d.created_at AS "createdAt",
        COALESCE(m.member_count, 0)::int AS "memberCount",
        COALESCE(u.tokens, 0)::bigint AS "tokens",
        COALESCE(u.requests, 0)::int AS "requests",
        u.cost_micros AS "costMicros",
        qp.monthly_tokens AS "monthlyTokens"
      FROM divisions d
      LEFT JOIN (
        SELECT division_id, count(*)::int AS member_count
        FROM users
        WHERE deleted_at IS NULL AND division_id IS NOT NULL
        GROUP BY division_id
      ) m ON m.division_id = d.id
      LEFT JOIN (
        SELECT division_id,
               sum(quota_tokens)::bigint AS tokens,
               sum(requests)::int AS requests,
               sum(est_cost_micros)::bigint AS cost_micros
        FROM usage_daily
        WHERE day >= ${range.from}::date AND day <= ${range.to}::date
        GROUP BY division_id
      ) u ON u.division_id = d.id
      LEFT JOIN quota_policies qp ON qp.scope = 'division' AND qp.division_id = d.id
      WHERE true ${idFilter}
      ORDER BY d.name ASC
    `);

    return result.rows as unknown as StatsRow[];
  }
}
