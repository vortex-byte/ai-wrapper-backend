import { eq } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { divisions } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import { AppError } from '@/errors.ts';
import type {
  CreateDivisionInput,
  Division,
  DivisionRepository,
  UpdateDivisionInput,
} from '../ports/division-repository.ts';

const divisionColumns = {
  id: divisions.id,
  name: divisions.name,
  externalRef: divisions.externalRef,
  createdAt: divisions.createdAt,
} as const;

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

  async findMany(tx?: TransactionContext): Promise<Division[]> {
    return runDb(tx).select(divisionColumns).from(divisions).orderBy(divisions.name);
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
}
