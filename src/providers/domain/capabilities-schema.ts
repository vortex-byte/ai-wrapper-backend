import { z } from 'zod';
import type {
  ModelCapabilities,
  PartialModelCapabilities,
  ReasoningEffort,
} from './capabilities.ts';
import { REASONING_EFFORTS } from './capabilities.ts';

/** Zod schemas for validating model capabilities and runtime configurations. */

/** Current capability blob version. Bump when a required key changes meaning. */
export const CAPABILITIES_SCHEMA_VERSION = 1;

const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);

interface ReasoningEffortsShape {
  readonly availableEfforts?: readonly ReasoningEffort[] | undefined;
  readonly defaultEffort?: ReasoningEffort | undefined;
}

/** A default outside the selectable set would make the picker unable to represent the model. */
const defaultEffortIsAvailable = (value: ReasoningEffortsShape): boolean => {
  if (value.availableEfforts === undefined || value.defaultEffort === undefined) return true;
  return value.availableEfforts.includes(value.defaultEffort);
};

const effortsAreUnique = (value: ReasoningEffortsShape): boolean => {
  if (value.availableEfforts === undefined) return true;
  return new Set(value.availableEfforts).size === value.availableEfforts.length;
};

const ReasoningCapabilitySchema = z
  .object({
    availableEfforts: z.array(ReasoningEffortSchema).min(1),
    defaultEffort: ReasoningEffortSchema,
  })
  .strict()
  .refine(effortsAreUnique, {
    message: 'availableEfforts must not contain duplicates.',
    path: ['availableEfforts'],
  })
  .refine(defaultEffortIsAvailable, {
    message: 'defaultEffort must be one of availableEfforts.',
    path: ['defaultEffort'],
  });

const PartialReasoningCapabilitySchema = z
  .object({
    availableEfforts: z.array(ReasoningEffortSchema).min(1).optional(),
    defaultEffort: ReasoningEffortSchema.optional(),
  })
  .strict()
  .refine(effortsAreUnique, {
    message: 'availableEfforts must not contain duplicates.',
    path: ['availableEfforts'],
  })
  .refine(defaultEffortIsAvailable, {
    message: 'defaultEffort must be one of availableEfforts.',
    path: ['defaultEffort'],
  });

const DocumentCapabilitiesSchema = z
  .object({
    pdf: z.boolean().default(false),
    maxPages: z.number().int().positive().optional(),
  })
  .strict();

/** Schema for normalized model capabilities. */
export const ModelCapabilitiesSchema = z
  .object({
    schemaVersion: z.number().int().positive().default(CAPABILITIES_SCHEMA_VERSION),
    streaming: z.boolean().default(true),
    vision: z.boolean().default(false),
    documents: DocumentCapabilitiesSchema.default({ pdf: false }),
    imageGeneration: z.boolean().default(false),
    documentGeneration: z.boolean().default(false),
    systemPrompt: z.boolean().default(true),
    tools: z.boolean().default(false),
    maxImagesPerRequest: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    reasoning: ReasoningCapabilitySchema.nullish(),
  })
  .strict();

const PartialDocumentCapabilitiesSchema = z
  .object({
    pdf: z.boolean().optional(),
    maxPages: z.number().int().positive().optional(),
  })
  .strict();

export const PartialModelCapabilitiesSchema = z
  .object({
    schemaVersion: z.number().int().positive().optional(),
    streaming: z.boolean().optional(),
    vision: z.boolean().optional(),
    documents: PartialDocumentCapabilitiesSchema.optional(),
    imageGeneration: z.boolean().optional(),
    documentGeneration: z.boolean().optional(),
    systemPrompt: z.boolean().optional(),
    tools: z.boolean().optional(),
    maxImagesPerRequest: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    reasoning: PartialReasoningCapabilitySchema.nullable().optional(),
  })
  .strict();

export type CapabilitiesInput = z.input<typeof ModelCapabilitiesSchema>;

const EmptyObject = z.record(z.string(), z.unknown());

export const ProviderConfigSchema = EmptyObject;
export const ModelConfigSchema = EmptyObject;

export function parseCapabilities(
  value: unknown,
  fallback?: { contextWindow?: number | undefined; maxOutputTokens?: number | undefined },
): ModelCapabilities {
  const raw =
    typeof value === 'object' && value !== null ? { ...(value as Record<string, unknown>) } : {};
  if (
    (raw['contextWindow'] === undefined || raw['contextWindow'] === null) &&
    fallback?.contextWindow !== undefined
  ) {
    raw['contextWindow'] = fallback.contextWindow;
  }
  if (
    (raw['maxOutputTokens'] === undefined || raw['maxOutputTokens'] === null) &&
    fallback?.maxOutputTokens !== undefined
  ) {
    raw['maxOutputTokens'] = fallback.maxOutputTokens;
  }
  const parsed = ModelCapabilitiesSchema.parse(raw);
  return {
    streaming: parsed.streaming,
    vision: parsed.vision,
    documents: {
      pdf: parsed.documents.pdf,
      ...(parsed.documents.maxPages !== undefined ? { maxPages: parsed.documents.maxPages } : {}),
    },
    imageGeneration: parsed.imageGeneration,
    documentGeneration: parsed.documentGeneration,
    systemPrompt: parsed.systemPrompt,
    tools: parsed.tools,
    ...(parsed.maxImagesPerRequest !== undefined
      ? { maxImagesPerRequest: parsed.maxImagesPerRequest }
      : {}),
    contextWindow: parsed.contextWindow,
    maxOutputTokens: parsed.maxOutputTokens,
    ...(parsed.reasoning !== undefined && parsed.reasoning !== null
      ? {
          reasoning: {
            availableEfforts: [...parsed.reasoning.availableEfforts],
            defaultEffort: parsed.reasoning.defaultEffort,
          },
        }
      : {}),
  };
}

export function parsePartialCapabilities(value: unknown): PartialModelCapabilities {
  if (value === undefined || value === null) return {};
  const parsed = PartialModelCapabilitiesSchema.parse(value);
  return {
    ...(parsed.streaming !== undefined ? { streaming: parsed.streaming } : {}),
    ...(parsed.vision !== undefined ? { vision: parsed.vision } : {}),
    ...(parsed.documents !== undefined
      ? {
          documents: {
            ...(parsed.documents.pdf !== undefined ? { pdf: parsed.documents.pdf } : {}),
            ...(parsed.documents.maxPages !== undefined
              ? { maxPages: parsed.documents.maxPages }
              : {}),
          },
        }
      : {}),
    ...(parsed.imageGeneration !== undefined ? { imageGeneration: parsed.imageGeneration } : {}),
    ...(parsed.documentGeneration !== undefined
      ? { documentGeneration: parsed.documentGeneration }
      : {}),
    ...(parsed.systemPrompt !== undefined ? { systemPrompt: parsed.systemPrompt } : {}),
    ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
    ...(parsed.maxImagesPerRequest !== undefined
      ? { maxImagesPerRequest: parsed.maxImagesPerRequest }
      : {}),
    ...(parsed.contextWindow !== undefined ? { contextWindow: parsed.contextWindow } : {}),
    ...(parsed.maxOutputTokens !== undefined ? { maxOutputTokens: parsed.maxOutputTokens } : {}),
    ...(parsed.reasoning !== undefined
      ? parsed.reasoning === null
        ? { reasoning: null }
        : {
            reasoning: {
              ...(parsed.reasoning.availableEfforts !== undefined
                ? { availableEfforts: [...parsed.reasoning.availableEfforts] }
                : {}),
              ...(parsed.reasoning.defaultEffort !== undefined
                ? { defaultEffort: parsed.reasoning.defaultEffort }
                : {}),
            },
          }
      : {}),
  };
}

export function parseConfig(value: unknown): Readonly<Record<string, unknown>> {
  return ProviderConfigSchema.parse(value ?? {});
}

export function toCapabilitiesJson(capabilities: ModelCapabilities): Record<string, unknown> {
  const { reasoning, ...rest } = capabilities;
  return {
    schemaVersion: CAPABILITIES_SCHEMA_VERSION,
    ...rest,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}
