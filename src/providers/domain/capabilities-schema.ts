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

/** Compaction is opt-in per model: the adapter only requests it when this object is present. */
const CompactionCapabilitySchema = z
  .object({
    triggerTokens: z.number().int().min(1_000).optional(),
  })
  .strict();

const ImageGenerationObjectSchema = z
  .object({
    mode: z.enum(['tool', 'provider']),
    model: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const ImageGenerationCapabilitySchema = z
  .union([z.boolean(), ImageGenerationObjectSchema, z.null()])
  .optional()
  .transform((value) => {
    if (value === true) return { mode: 'tool' as const };
    if (value === false || value === null || value === undefined) return null;
    return value;
  });

const PartialImageGenerationCapabilitySchema = z
  .union([z.boolean(), ImageGenerationObjectSchema, z.null()])
  .optional()
  .transform((value) => {
    if (value === true) return { mode: 'tool' as const };
    if (value === false) return null;
    return value;
  });

/** Schema for normalized model capabilities. */
export const ModelCapabilitiesSchema = z
  .object({
    schemaVersion: z.number().int().positive().default(CAPABILITIES_SCHEMA_VERSION),
    streaming: z.boolean().default(true),
    vision: z.boolean().default(false),
    documents: DocumentCapabilitiesSchema.default({ pdf: false }),
    imageGeneration: ImageGenerationCapabilitySchema.default(null),
    documentGeneration: z.boolean().default(false),
    systemPrompt: z.boolean().default(true),
    tools: z.boolean().default(false),
    maxImagesPerRequest: z.number().int().positive().optional(),
    contextWindow: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(),
    compaction: CompactionCapabilitySchema.nullish(),
    reasoning: ReasoningCapabilitySchema.nullish(),
  })
  .strict()
  .refine(
    (cap) =>
      cap.compaction?.triggerTokens === undefined ||
      cap.compaction.triggerTokens < cap.contextWindow,
    { message: 'compaction triggerTokens must be less than contextWindow' },
  )
  .refine(
    (cap) =>
      cap.maxImagesPerRequest === undefined ||
      cap.vision === true ||
      (cap.imageGeneration !== undefined && cap.imageGeneration !== null),
    {
      message: 'maxImagesPerRequest requires vision or imageGeneration',
      path: ['maxImagesPerRequest'],
    },
  );

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
    imageGeneration: PartialImageGenerationCapabilitySchema,
    documentGeneration: z.boolean().optional(),
    systemPrompt: z.boolean().optional(),
    tools: z.boolean().optional(),
    maxImagesPerRequest: z.number().int().positive().nullable().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    compaction: CompactionCapabilitySchema.nullable().optional(),
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
    imageGeneration:
      parsed.imageGeneration !== undefined && parsed.imageGeneration !== null
        ? {
            mode: parsed.imageGeneration.mode,
            ...(parsed.imageGeneration.model !== undefined
              ? { model: parsed.imageGeneration.model }
              : {}),
          }
        : null,
    documentGeneration: parsed.documentGeneration,
    systemPrompt: parsed.systemPrompt,
    tools: parsed.tools,
    ...(parsed.maxImagesPerRequest !== undefined
      ? { maxImagesPerRequest: parsed.maxImagesPerRequest }
      : {}),
    contextWindow: parsed.contextWindow,
    maxOutputTokens: parsed.maxOutputTokens,
    ...(parsed.compaction !== undefined && parsed.compaction !== null
      ? {
          compaction: {
            ...(parsed.compaction.triggerTokens !== undefined
              ? { triggerTokens: parsed.compaction.triggerTokens }
              : {}),
          },
        }
      : {}),
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
    ...(parsed.imageGeneration !== undefined
      ? parsed.imageGeneration === null
        ? { imageGeneration: null }
        : {
            imageGeneration: {
              mode: parsed.imageGeneration.mode,
              ...(parsed.imageGeneration.model !== undefined
                ? { model: parsed.imageGeneration.model }
                : {}),
            },
          }
      : {}),
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
    ...(parsed.compaction !== undefined
      ? parsed.compaction === null
        ? { compaction: null }
        : {
            compaction: {
              ...(parsed.compaction.triggerTokens !== undefined
                ? { triggerTokens: parsed.compaction.triggerTokens }
                : {}),
            },
          }
      : {}),
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
    imageGeneration: capabilities.imageGeneration ?? null,
    ...(reasoning !== undefined ? { reasoning } : {}),
  };
}
