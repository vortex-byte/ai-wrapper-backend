import { z } from 'zod';
import type { ModelCapabilities } from './capabilities.ts';

/** Zod schemas for validating model capabilities and runtime configurations. */

/** Current capability blob version. Bump when a required key changes meaning. */
export const CAPABILITIES_SCHEMA_VERSION = 1;

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
  })
  .strict();

export type CapabilitiesInput = z.input<typeof ModelCapabilitiesSchema>;

const EmptyObject = z.record(z.string(), z.unknown());

export const ProviderConfigSchema = EmptyObject;
export const ModelConfigSchema = EmptyObject;

export function parseCapabilities(value: unknown): ModelCapabilities {
  const parsed = ModelCapabilitiesSchema.parse(value ?? {});
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
  };
}

export function parseConfig(value: unknown): Readonly<Record<string, unknown>> {
  return ProviderConfigSchema.parse(value ?? {});
}

export function toCapabilitiesJson(capabilities: ModelCapabilities): Record<string, unknown> {
  return { schemaVersion: CAPABILITIES_SCHEMA_VERSION, ...capabilities };
}
