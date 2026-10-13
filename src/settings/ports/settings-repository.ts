import type { TransactionContext } from '@/db/tx.ts';
import type { SystemSetting } from '../domain/settings.ts';

export interface SettingsRepository {
  get<T = unknown>(key: string, tx?: TransactionContext): Promise<SystemSetting<T> | null>;
  set<T = unknown>(
    key: string,
    value: T,
    updatedBy?: string | null,
    tx?: TransactionContext,
  ): Promise<SystemSetting<T>>;
  listAll(tx?: TransactionContext): Promise<readonly SystemSetting[]>;
}
