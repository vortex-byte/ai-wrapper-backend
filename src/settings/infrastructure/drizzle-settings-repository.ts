import { eq, sql } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { systemSettings } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import { parseSettingValue, type SystemSetting } from '../domain/settings.ts';
import type { SettingsRepository } from '../ports/settings-repository.ts';

const settingColumns = {
  key: systemSettings.key,
  value: systemSettings.value,
  version: systemSettings.version,
  updatedBy: systemSettings.updatedBy,
  updatedAt: systemSettings.updatedAt,
} as const;

interface SettingRow {
  key: string;
  value: unknown;
  version: number;
  updatedBy: string | null;
  updatedAt: Date;
}

function toSetting<T>(row: SettingRow): SystemSetting<T> {
  return {
    key: row.key,
    value: parseSettingValue<T>(row.key, row.value),
    version: row.version,
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt,
  };
}

export class DrizzleSettingsRepository implements SettingsRepository {
  async get<T = unknown>(key: string, tx?: TransactionContext): Promise<SystemSetting<T> | null> {
    const rows = await runDb(tx)
      .select(settingColumns)
      .from(systemSettings)
      .where(eq(systemSettings.key, key))
      .limit(1);
    return rows[0] ? toSetting<T>(rows[0]) : null;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    updatedBy?: string | null,
    tx?: TransactionContext,
  ): Promise<SystemSetting<T>> {
    const rows = await runDb(tx)
      .insert(systemSettings)
      .values({
        key,
        value,
        version: 1,
        updatedBy: updatedBy ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value,
          version: sql`${systemSettings.version} + 1`,
          updatedBy: updatedBy ?? null,
          updatedAt: new Date(),
        },
      })
      .returning(settingColumns);

    const row = rows[0];
    if (!row) throw new Error(`Failed to set system setting ${key}`);
    return toSetting<T>(row);
  }

  async listAll(tx?: TransactionContext): Promise<readonly SystemSetting[]> {
    const rows = await runDb(tx).select(settingColumns).from(systemSettings);
    return rows.map((r) => toSetting(r));
  }
}
