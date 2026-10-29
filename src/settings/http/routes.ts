import { Hono } from 'hono';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { Config } from '@/config/index.ts';
import { AppError } from '@/errors.ts';
import { ok } from '@/http/envelope.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requireCsrf } from '@/http/middleware/require-csrf.ts';
import { requirePasswordChanged } from '@/http/middleware/require-password-changed.ts';
import { requireSuperAdmin } from '@/http/middleware/require-role.ts';
import { clientIp, requestMeta } from '@/http/request-meta.ts';
import type { AppEnv } from '@/http/types.ts';
import { parseJsonBody } from '@/http/validate.ts';
import type { SettingsService } from '../application/settings-service.ts';
import {
  DEFAULT_SETTINGS,
  KNOWN_SETTINGS,
  type AttachmentsConfig,
  type SecurityConfig,
} from '../domain/settings.ts';
import { UpdatePlatformSettingsBodySchema } from './schemas.ts';

export interface SettingsRoutesDeps {
  readonly settings: SettingsService;
  readonly auth: AuthService;
  readonly config: Config;
}

export function settingsRoutes(deps: SettingsRoutesDeps): Hono<AppEnv> {
  const { settings, auth, config } = deps;
  const routes = new Hono<AppEnv>();

  routes.use('*', requireCsrf(config));
  routes.use('*', requireAuth(auth, config));
  routes.use('*', requirePasswordChanged());
  routes.use('*', requireSuperAdmin());

  routes.get('/settings', async (c) => {
    const data = await buildSettingsView(settings);
    return c.json(ok(data));
  });

  routes.patch('/settings', async (c) => {
    const caller = c.get('auth');
    if (!caller) throw new AppError('unauthenticated');
    const body = await parseJsonBody(c, UpdatePlatformSettingsBodySchema);
    const meta = requestMeta(c, clientIp(c, config));

    if (body.systemPrompt !== undefined) {
      await settings.set({
        key: KNOWN_SETTINGS.systemPrompt,
        value: body.systemPrompt,
        actorUserId: caller.user.id,
        meta,
      });
    }

    if (body.quotaTimezone !== undefined) {
      await settings.set({
        key: KNOWN_SETTINGS.quotaTimezone,
        value: body.quotaTimezone,
        actorUserId: caller.user.id,
        meta,
      });
    }

    if (body.attachments !== undefined) {
      await settings.set({
        key: KNOWN_SETTINGS.attachments,
        value: body.attachments,
        actorUserId: caller.user.id,
        meta,
      });
    }

    if (body.security !== undefined) {
      await settings.set({
        key: KNOWN_SETTINGS.security,
        value: body.security,
        actorUserId: caller.user.id,
        meta,
      });
    }

    const data = await buildSettingsView(settings);
    return c.json(ok(data, 'Platform settings updated.'));
  });

  return routes;
}

async function buildSettingsView(settings: SettingsService) {
  const [systemPromptSetting, quotaTimezoneSetting, attachmentsSetting, securitySetting] =
    await Promise.all([
      settings.get<string>(KNOWN_SETTINGS.systemPrompt),
      settings.get<string>(KNOWN_SETTINGS.quotaTimezone),
      settings.get<AttachmentsConfig>(KNOWN_SETTINGS.attachments),
      settings.get<SecurityConfig>(KNOWN_SETTINGS.security),
    ]);

  return {
    systemPrompt: {
      value: systemPromptSetting?.value ?? DEFAULT_SETTINGS.systemPrompt,
      version: systemPromptSetting?.version ?? 0,
      updatedAt: systemPromptSetting?.updatedAt.toISOString() ?? null,
      updatedBy: systemPromptSetting?.updatedBy ?? null,
    },
    quotaTimezone: {
      value: quotaTimezoneSetting?.value ?? DEFAULT_SETTINGS.quotaTimezone,
      version: quotaTimezoneSetting?.version ?? 0,
      updatedAt: quotaTimezoneSetting?.updatedAt.toISOString() ?? null,
      updatedBy: quotaTimezoneSetting?.updatedBy ?? null,
    },
    attachments: {
      value: attachmentsSetting?.value ?? DEFAULT_SETTINGS.attachments,
      version: attachmentsSetting?.version ?? 0,
      updatedAt: attachmentsSetting?.updatedAt.toISOString() ?? null,
      updatedBy: attachmentsSetting?.updatedBy ?? null,
    },
    security: {
      value: securitySetting?.value ?? DEFAULT_SETTINGS.security,
      version: securitySetting?.version ?? 0,
      updatedAt: securitySetting?.updatedAt.toISOString() ?? null,
      updatedBy: securitySetting?.updatedBy ?? null,
    },
  };
}
