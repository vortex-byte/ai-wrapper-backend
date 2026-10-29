import { z } from 'zod';
import { PartialModelCapabilitiesSchema } from '@/providers/domain/capabilities-schema.ts';

/** Zod schemas for provider and model administration endpoints. */

const ConfigSchema = z.record(z.string(), z.unknown());

const ProviderStatusSchema = z.enum(['active', 'disabled']);
const ModelStatusSchema = z.enum(['active', 'disabled']);

const FORBIDDEN_SECRET_NAMES = new Set([
  'SESSION_SECRET',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'MIGRATION_DATABASE_URL',
]);

const SecretRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*_(KEY|TOKEN|SECRET)$/, 'Use an API key or token variable name, e.g. OPENAI_API_KEY.')
  .refine((name) => !FORBIDDEN_SECRET_NAMES.has(name.toUpperCase()), {
    message: 'Referencing system database or session secrets is forbidden.',
  });

const BaseUrlSchema = z
  .string()
  .url()
  .refine(
    (val) => {
      try {
        const parsed = new URL(val);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'baseUrl must use http: or https: scheme.' },
  )
  .nullable()
  .optional();

export const CreateProviderBodySchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use lowercase letters, digits, "-" or "_".'),
  displayName: z.string().trim().min(1).max(128),
  adapter: z.string().trim().min(1).max(64),
  baseUrl: BaseUrlSchema,
  secretRef: SecretRefSchema,
  status: ProviderStatusSchema.optional(),
  config: ConfigSchema.optional(),
});

export const UpdateProviderBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),
    baseUrl: BaseUrlSchema,
    secretRef: SecretRefSchema.optional(),
    status: ProviderStatusSchema.optional(),
    config: ConfigSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field.' });

export const CreateModelBodySchema = z
  .object({
    providerId: z.uuid(),
    apiModelId: z.string().trim().min(1).max(256),
    displayName: z.string().trim().min(1).max(128),
    description: z.string().trim().max(1024).nullable().optional(),
    status: ModelStatusSchema.optional(),
    capabilities: PartialModelCapabilitiesSchema.default({}),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    defaultMaxOutputTokens: z.number().int().positive().optional(),
    quotaWeight: z.number().positive().max(1000).optional(),
    config: ConfigSchema.optional(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine(
    (data) => data.contextWindow !== undefined || data.capabilities.contextWindow !== undefined,
    { message: 'contextWindow is required.', path: ['contextWindow'] },
  )
  .refine(
    (data) => data.maxOutputTokens !== undefined || data.capabilities.maxOutputTokens !== undefined,
    { message: 'maxOutputTokens is required.', path: ['maxOutputTokens'] },
  );

export const UpdateModelBodySchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),
    description: z.string().trim().max(1024).nullable().optional(),
    status: ModelStatusSchema.optional(),
    capabilities: PartialModelCapabilitiesSchema.optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    defaultMaxOutputTokens: z.number().int().positive().optional(),
    quotaWeight: z.number().positive().max(1000).optional(),
    config: ConfigSchema.optional(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: 'Provide at least one field.' });

export const SetPriceBodySchema = z.object({
  effectiveFrom: z.iso.datetime().optional(),
  inputMicrosPerMtok: z.number().int().min(0).max(1_000_000_000_000),
  outputMicrosPerMtok: z.number().int().min(0).max(1_000_000_000_000),
  cachedInputMicrosPerMtok: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
  currency: z
    .string()
    .trim()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'Use a 3-letter ISO currency code.')
    .optional(),
});

export type CreateProviderBody = z.infer<typeof CreateProviderBodySchema>;
export type UpdateProviderBody = z.infer<typeof UpdateProviderBodySchema>;
export type CreateModelBody = z.infer<typeof CreateModelBodySchema>;
export type UpdateModelBody = z.infer<typeof UpdateModelBodySchema>;
export type SetPriceBody = z.infer<typeof SetPriceBodySchema>;
