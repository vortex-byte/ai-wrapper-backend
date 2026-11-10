import {
  DEFAULT_SETTINGS,
  KNOWN_SETTINGS,
  type SecurityConfig,
} from '@/settings/domain/settings.ts';
import type { SettingsLookup } from '@/settings/application/cached-settings-reader.ts';
import type { SessionPolicy } from '../domain/session.ts';
import type { LockoutPolicy } from '../domain/user.ts';

/** Both runtime login policies, resolved from the `security.config` system setting. */
export interface SessionPolicies {
  readonly lockout: LockoutPolicy;
  readonly sessionPolicy: SessionPolicy;
}

/** Falls back per-field to `DEFAULT_SETTINGS.security`; `absoluteMinutes` stays boot-time config (caps the cookie lifetime). */
export function buildSessionPolicies(
  stored: Partial<SecurityConfig> | undefined,
  absoluteMinutes: number,
): SessionPolicies {
  const fallback = DEFAULT_SETTINGS.security;
  return {
    lockout: {
      maxFailures: stored?.loginMaxFailures ?? fallback.loginMaxFailures,
      lockoutMinutes: stored?.loginLockoutMinutes ?? fallback.loginLockoutMinutes,
    },
    sessionPolicy: {
      idleMinutes: stored?.sessionIdleMinutes ?? fallback.sessionIdleMinutes,
      absoluteMinutes,
    },
  };
}

/** Provider for `AuthDeps.policies`, reading the cached `security.config` setting. */
export function createSessionPoliciesProvider(
  settings: SettingsLookup,
  absoluteMinutes: number,
): () => Promise<SessionPolicies> {
  return async () => {
    const setting = await settings.get<Partial<SecurityConfig>>(KNOWN_SETTINGS.security);
    return buildSessionPolicies(setting?.value, absoluteMinutes);
  };
}
