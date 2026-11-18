import { z } from 'zod';
import type { ProviderRuntimeConfig } from './capabilities.ts';

/**
 * What a provider deployment actually implements. Defaults are chosen per adapter and
 * narrowed automatically for non-first-party `baseUrl`s, so a compatible endpoint is
 * safe to register before any feature has been proven against it.
 */
export interface ProviderDialect {
  readonly chat: true;
  readonly responses: boolean;
  readonly modelCatalogue: boolean;
  readonly healthProbe: 'models' | 'chat';
  readonly files: {
    readonly download: boolean;
    readonly delete: boolean;
  };
  readonly containers: boolean;
  readonly serverCompaction: boolean;
  readonly promptCaching: boolean;
  readonly reasoning: 'native' | 'effort' | 'none';
  readonly documentInput: {
    readonly pdf: 'native' | 'text';
  };
  readonly chatPayload: {
    readonly maxTokens: 'max_tokens' | 'max_completion_tokens';
    readonly sendSafetyIdentifier: boolean;
    readonly sendStreamUsageOption: boolean;
    readonly strictRetry: boolean;
  };
  readonly anthropic?: {
    readonly version: string;
    readonly betas: readonly string[];
    readonly reasoningMode: 'auto' | 'adaptive' | 'budget';
  };
}

export type ProviderDialectInput = Pick<ProviderRuntimeConfig, 'adapter' | 'baseUrl' | 'config'>;

export interface ProviderDialectOverride {
  readonly responses?: boolean;
  readonly modelCatalogue?: boolean;
  readonly healthProbe?: 'models' | 'chat';
  readonly files?: { readonly download?: boolean; readonly delete?: boolean };
  readonly containers?: boolean;
  readonly serverCompaction?: boolean;
  readonly promptCaching?: boolean;
  readonly reasoning?: 'native' | 'effort' | 'none';
  readonly documentInput?: { readonly pdf?: 'native' | 'text' };
  readonly chatPayload?: {
    readonly maxTokens?: 'max_tokens' | 'max_completion_tokens';
    readonly sendSafetyIdentifier?: boolean;
    readonly sendStreamUsageOption?: boolean;
    readonly strictRetry?: boolean;
  };
  readonly anthropic?: {
    readonly version?: string;
    readonly betas?: readonly string[];
    readonly reasoningMode?: 'auto' | 'adaptive' | 'budget';
  };
}

/** Version understood by most Anthropic-compatible gateways; first-party stays on the current default. */
export const COMPAT_ANTHROPIC_VERSION = '2023-06-01';

const ProviderDialectOverrideSchema = z
  .object({
    responses: z.boolean().optional(),
    modelCatalogue: z.boolean().optional(),
    healthProbe: z.enum(['models', 'chat']).optional(),
    files: z
      .object({ download: z.boolean().optional(), delete: z.boolean().optional() })
      .strict()
      .optional(),
    containers: z.boolean().optional(),
    serverCompaction: z.boolean().optional(),
    promptCaching: z.boolean().optional(),
    reasoning: z.enum(['native', 'effort', 'none']).optional(),
    documentInput: z
      .object({ pdf: z.enum(['native', 'text']).optional() })
      .strict()
      .optional(),
    chatPayload: z
      .object({
        maxTokens: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
        sendSafetyIdentifier: z.boolean().optional(),
        sendStreamUsageOption: z.boolean().optional(),
        strictRetry: z.boolean().optional(),
      })
      .strict()
      .optional(),
    anthropic: z
      .object({
        version: z.string().trim().min(1).max(64).optional(),
        betas: z.array(z.string().trim().min(1)).optional(),
        reasoningMode: z.enum(['auto', 'adaptive', 'budget']).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ProviderConfigSchema = z
  .object({ dialect: ProviderDialectOverrideSchema.optional() })
  .passthrough();

/** Throws on an invalid `dialect` block; other config keys stay free-form for adapter-specific knobs. */
export function parseProviderDialectOverride(value: unknown): ProviderDialectOverride {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const parsed = ProviderDialectOverrideSchema.safeParse(raw['dialect']);
  return parsed.success ? (parsed.data as ProviderDialectOverride) : {};
}

function isFirstParty(adapter: string, baseUrl: string | undefined): boolean {
  if (baseUrl === undefined || baseUrl === '') return true;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  switch (adapter) {
    case 'openai':
      return host === 'api.openai.com';
    case 'anthropic':
      return host === 'api.anthropic.com';
    case 'gemini':
      return host === 'generativelanguage.googleapis.com';
    default:
      return false;
  }
}

function baseDialect(adapter: string, firstParty: boolean): ProviderDialect {
  const chatPayload: ProviderDialect['chatPayload'] = firstParty
    ? {
        maxTokens: 'max_completion_tokens',
        sendSafetyIdentifier: true,
        sendStreamUsageOption: true,
        strictRetry: false,
      }
    : {
        maxTokens: 'max_tokens',
        sendSafetyIdentifier: false,
        sendStreamUsageOption: true,
        strictRetry: true,
      };

  switch (adapter) {
    case 'openai':
      return {
        chat: true,
        responses: firstParty,
        // Compatible endpoints expose the same /v1/models; a missing one is detected at request time.
        modelCatalogue: true,
        healthProbe: firstParty ? 'models' : 'chat',
        files: { download: firstParty, delete: firstParty },
        containers: firstParty,
        serverCompaction: firstParty,
        promptCaching: false,
        reasoning: 'effort',
        documentInput: { pdf: firstParty ? 'native' : 'text' },
        chatPayload,
      };
    case 'anthropic':
      return {
        chat: true,
        responses: false,
        modelCatalogue: true,
        healthProbe: firstParty ? 'models' : 'chat',
        files: { download: firstParty, delete: firstParty },
        containers: firstParty,
        serverCompaction: firstParty,
        promptCaching: firstParty,
        reasoning: 'native',
        documentInput: { pdf: firstParty ? 'native' : 'text' },
        chatPayload: { ...chatPayload, maxTokens: 'max_tokens' },
        anthropic: {
          version: firstParty ? '' : COMPAT_ANTHROPIC_VERSION,
          betas: [],
          reasoningMode: 'auto',
        },
      };
    case 'gemini':
      return {
        chat: true,
        responses: false,
        modelCatalogue: true,
        healthProbe: 'models',
        files: { download: firstParty, delete: false },
        containers: false,
        serverCompaction: false,
        promptCaching: false,
        reasoning: 'none',
        documentInput: { pdf: 'native' },
        chatPayload: { ...chatPayload, maxTokens: 'max_tokens', strictRetry: false },
      };
    default:
      return {
        chat: true,
        responses: false,
        modelCatalogue: false,
        healthProbe: 'chat',
        files: { download: false, delete: false },
        containers: false,
        serverCompaction: false,
        promptCaching: false,
        reasoning: 'none',
        documentInput: { pdf: 'text' },
        chatPayload: { ...chatPayload, maxTokens: 'max_tokens', strictRetry: false },
      };
  }
}

function mergeDialect(base: ProviderDialect, override: ProviderDialectOverride): ProviderDialect {
  return {
    chat: true,
    responses: override.responses ?? base.responses,
    modelCatalogue: override.modelCatalogue ?? base.modelCatalogue,
    healthProbe: override.healthProbe ?? base.healthProbe,
    files: {
      download: override.files?.download ?? base.files.download,
      delete: override.files?.delete ?? base.files.delete,
    },
    containers: override.containers ?? base.containers,
    serverCompaction: override.serverCompaction ?? base.serverCompaction,
    promptCaching: override.promptCaching ?? base.promptCaching,
    reasoning: override.reasoning ?? base.reasoning,
    documentInput: { pdf: override.documentInput?.pdf ?? base.documentInput.pdf },
    chatPayload: {
      maxTokens: override.chatPayload?.maxTokens ?? base.chatPayload.maxTokens,
      sendSafetyIdentifier:
        override.chatPayload?.sendSafetyIdentifier ?? base.chatPayload.sendSafetyIdentifier,
      sendStreamUsageOption:
        override.chatPayload?.sendStreamUsageOption ?? base.chatPayload.sendStreamUsageOption,
      strictRetry: override.chatPayload?.strictRetry ?? base.chatPayload.strictRetry,
    },
    ...(base.anthropic !== undefined || override.anthropic !== undefined
      ? {
          anthropic: {
            version: override.anthropic?.version ?? base.anthropic?.version ?? '',
            betas: override.anthropic?.betas ?? base.anthropic?.betas ?? [],
            reasoningMode:
              override.anthropic?.reasoningMode ?? base.anthropic?.reasoningMode ?? 'auto',
          },
        }
      : {}),
  };
}

export function resolveDialect(provider: ProviderDialectInput): ProviderDialect {
  const firstParty = isFirstParty(provider.adapter, provider.baseUrl);
  const merged = mergeDialect(
    baseDialect(provider.adapter, firstParty),
    parseProviderDialectOverride(provider.config),
  );
  return applyLegacyAnthropicConfig(provider, merged);
}

function readLegacyBetas(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }
  return typeof value === 'string' && value.length > 0 ? [value] : [];
}

/** Older rows used `anthropicVersion` / `anthropicBeta`; the dialect block wins when present. */
function applyLegacyAnthropicConfig(
  provider: ProviderDialectInput,
  dialect: ProviderDialect,
): ProviderDialect {
  if (dialect.anthropic === undefined) return dialect;
  const override = parseProviderDialectOverride(provider.config);
  const legacyVersion =
    typeof provider.config['anthropicVersion'] === 'string' &&
    provider.config['anthropicVersion'].trim().length > 0
      ? provider.config['anthropicVersion'].trim()
      : undefined;
  const legacyBetas = readLegacyBetas(provider.config['anthropicBeta']);
  return {
    ...dialect,
    anthropic: {
      version: override.anthropic?.version ?? legacyVersion ?? dialect.anthropic.version,
      betas:
        override.anthropic?.betas !== undefined
          ? override.anthropic.betas
          : legacyBetas.length > 0
            ? legacyBetas
            : dialect.anthropic.betas,
      reasoningMode: dialect.anthropic.reasoningMode,
    },
  };
}

export interface DialectViolation {
  readonly field: string;
  readonly message: string;
}

/** Capabilities the dialect cannot serve are rejected at admin time, never at request time. */
export function validateCapabilitiesForDialect(
  capabilities: {
    readonly documentGeneration?: boolean | undefined;
    readonly compaction?: { readonly triggerTokens?: number } | null | undefined;
    readonly promptCaching?: { readonly supported: boolean } | null | undefined;
    readonly reasoning?: unknown;
    readonly imageGeneration?: { readonly mode: 'tool' | 'provider' } | null | undefined;
    readonly documents?: { readonly pdf?: boolean | undefined } | undefined;
  },
  dialect: ProviderDialect,
): readonly DialectViolation[] {
  const violations: DialectViolation[] = [];

  if (capabilities.documentGeneration === true && !dialect.containers) {
    violations.push({
      field: 'documentGeneration',
      message: 'This provider has no container sandbox; document generation is unavailable.',
    });
  }
  if (
    capabilities.compaction !== undefined &&
    capabilities.compaction !== null &&
    !dialect.serverCompaction
  ) {
    violations.push({
      field: 'compaction',
      message: 'This provider does not support server-side context compaction.',
    });
  }
  if (
    capabilities.promptCaching !== undefined &&
    capabilities.promptCaching !== null &&
    !dialect.promptCaching
  ) {
    violations.push({
      field: 'promptCaching',
      message: 'This provider does not support prompt caching.',
    });
  }
  if (
    capabilities.reasoning !== undefined &&
    capabilities.reasoning !== null &&
    dialect.reasoning === 'none'
  ) {
    violations.push({
      field: 'reasoning',
      message: 'This provider has no reasoning controls.',
    });
  }
  if (capabilities.imageGeneration?.mode === 'tool' && !dialect.responses) {
    violations.push({
      field: 'imageGeneration',
      message: 'Provider-native image generation requires the Responses API.',
    });
  }
  if (capabilities.documents?.pdf === true && dialect.documentInput.pdf !== 'native') {
    violations.push({
      field: 'documents.pdf',
      message: 'Native PDF input is unavailable; documents are sent as extracted text.',
    });
  }

  return violations;
}
