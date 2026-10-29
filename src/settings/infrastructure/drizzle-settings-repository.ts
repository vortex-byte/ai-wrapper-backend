import { eq, sql } from 'drizzle-orm';
import { runDb } from '@/db/client.ts';
import { systemSettings, users } from '@/db/schema.ts';
import type { TransactionContext } from '@/db/tx.ts';
import { parseSettingValue, type SettingUpdater, type SystemSetting } from '../domain/settings.ts';
import type { SettingsRepository } from '../ports/settings-repository.ts';

interface SettingRow {
  key: string;
  value: unknown;
  version: number;
  updatedById: string | null;
  updatedByDisplayName: string | null;
  updatedByEmail: string | null;
  updatedAt: Date;
}

function toSetting<T>(row: SettingRow): SystemSetting<T> {
  const updatedBy: SettingUpdater | null =
    row.updatedById && row.updatedByDisplayName && row.updatedByEmail
      ? {
          id: row.updatedById,
          displayName: row.updatedByDisplayName,
          email: row.updatedByEmail,
        }
      : null;

  return {
    key: row.key,
    value: parseSettingValue<T>(row.key, row.value),
    version: row.version,
    updatedBy,
    updatedAt: row.updatedAt,
  };
}

const selectFields = {
  key: systemSettings.key,
  value: systemSettings.value,
  version: systemSettings.version,
  updatedById: systemSettings.updatedBy,
  updatedByDisplayName: users.displayName,
  updatedByEmail: users.email,
  updatedAt: systemSettings.updatedAt,
} as const;

export class DrizzleSettingsRepository implements SettingsRepository {
  async get<T = unknown>(key: string, tx?: TransactionContext): Promise<SystemSetting<T> | null> {
    const rows = await runDb(tx)
      .select(selectFields)
      .from(systemSettings)
      .leftJoin(users, eq(systemSettings.updatedBy, users.id))
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
    await runDb(tx)
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
      });

    const result = await this.get<T>(key, tx);
    if (!result) throw new Error(`Failed to set system setting ${key}`);
    return result;
  }

  async listAll(tx?: TransactionContext): Promise<readonly SystemSetting[]> {
    const rows = await runDb(tx)
      .select(selectFields)
      .from(systemSettings)
      .leftJoin(users, eq(systemSettings.updatedBy, users.id));
    return rows.map((r) => toSetting(r));
  }
}
