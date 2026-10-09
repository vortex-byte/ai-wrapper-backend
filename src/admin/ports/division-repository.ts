import type { TransactionContext } from '@/db/tx.ts';

export interface Division {
  readonly id: string;
  readonly name: string;
  readonly externalRef: string | null;
  readonly createdAt: Date;
}

export interface CreateDivisionInput {
  readonly id: string;
  readonly name: string;
  readonly externalRef?: string | null | undefined;
}

export interface UpdateDivisionInput {
  readonly id: string;
  readonly name?: string | undefined;
  readonly externalRef?: string | null | undefined;
}

export interface DivisionRepository {
  findById(id: string, tx?: TransactionContext): Promise<Division | null>;
  findByName(name: string, tx?: TransactionContext): Promise<Division | null>;
  findMany(tx?: TransactionContext): Promise<Division[]>;
  create(input: CreateDivisionInput, tx?: TransactionContext): Promise<Division>;
  update(input: UpdateDivisionInput, tx?: TransactionContext): Promise<Division>;
}
