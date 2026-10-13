import type { AuditLogRepository } from '@/audit/ports/audit-log-repository.ts';
import { AUDIT_ACTIONS } from '@/audit/actions.ts';
import { withTransaction } from '@/db/index.ts';
import type { RequestMeta } from '@/request-context.ts';
import { parseSettingValue, type SystemSetting } from '../domain/settings.ts';
import type { SettingsRepository } from '../ports/settings-repository.ts';

export interface SettingsDeps {
  readonly repository: SettingsRepository;
  readonly audit: AuditLogRepository;
}

export interface SetSettingInput<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly actorUserId: string;
  readonly meta: RequestMeta;
}

export interface SettingsService {
  get<T = unknown>(key: string): Promise<SystemSetting<T> | null>;
  set<T = unknown>(input: SetSettingInput<T>): Promise<SystemSetting<T>>;
  listAll(): Promise<readonly SystemSetting[]>;
}

export function createSettingsService(deps: SettingsDeps): SettingsService {
  return {
    async get<T = unknown>(key: string) {
      return deps.repository.get<T>(key);
    },

    async set<T = unknown>(input: SetSettingInput<T>) {
      const parsedValue = parseSettingValue<T>(input.key, input.value);
      const before = await deps.repository.get(input.key);

      const setting = await withTransaction(async (tx) => {
        const updated = await deps.repository.set<T>(
          input.key,
          parsedValue,
          input.actorUserId,
          tx,
        );

        await deps.audit.append(
          {
            actorUserId: input.actorUserId,
            action: AUDIT_ACTIONS.settingsUpdate,
            targetType: 'system_setting',
            targetId: input.key,
            before: before ? { value: before.value, version: before.version } : null,
            after: { value: updated.value, version: updated.version },
            requestId: input.meta.requestId,
            ip: input.meta.ip,
            userAgentHash: input.meta.userAgentHash,
          },
          tx,
        );

        return updated;
      });

      return setting;
    },

    async listAll() {
      return deps.repository.listAll();
    },
  };
}
