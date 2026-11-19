/** Metadata for browser-executed ("local") models: the registry rows the SPA runs with WebLLM. */

import { z } from 'zod';
import type { ModelCapabilities } from './capabilities.ts';

/** The adapter key a provider must use for its models to execute in the browser. */
export const LOCAL_ADAPTER_KEY = 'local';

/** Placeholder env-var name for a local provider: never resolved, the browser holds the weights. */
export const LOCAL_PROVIDER_SECRET_REF = 'UNUSED_LOCAL_KEY';

/** Size class shown as a badge in the model picker. */
export const LOCAL_MODEL_TIERS = ['small', 'standard', 'balanced', 'high'] as const;

export type LocalModelTier = (typeof LOCAL_MODEL_TIERS)[number];

export interface LocalModelInfo {
  /** The WebLLM model id used to load the weights. Always equal to the model's `apiModelId`. */
  readonly webllmModelId: string;
  readonly tier: LocalModelTier;
  readonly downloadSizeBytes: number;
  readonly vramRequiredMB: number;
  /** Pinned upstream revision of the weights, for reproducibility. */
  readonly sourceRevision: string;
  /** WebGPU features the model needs, e.g. `shader-f16`. */
  readonly requiredFeatures: readonly string[];
}

export const LocalModelInfoSchema = z
  .object({
    webllmModelId: z.string().trim().min(1).max(256),
    tier: z.enum(LOCAL_MODEL_TIERS),
    downloadSizeBytes: z.number().int().positive(),
    vramRequiredMB: z.number().int().positive(),
    sourceRevision: z.string().trim().min(1).max(128),
    requiredFeatures: z.array(z.string().trim().min(1).max(64)).max(16).optional(),
  })
  .strict();

/** True when the provider adapter runs inference in the browser instead of on the server. */
export function isLocalAdapter(adapter: string): boolean {
  return adapter === LOCAL_ADAPTER_KEY;
}

/** Reads the `config.local` block of a local model, or `null` when it is absent or invalid. */
export function readLocalModelInfo(
  config: Readonly<Record<string, unknown>>,
): LocalModelInfo | null {
  const raw = config['local'];
  if (raw === undefined || raw === null) return null;
  const parsed = LocalModelInfoSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    webllmModelId: parsed.data.webllmModelId,
    tier: parsed.data.tier,
    downloadSizeBytes: parsed.data.downloadSizeBytes,
    vramRequiredMB: parsed.data.vramRequiredMB,
    sourceRevision: parsed.data.sourceRevision,
    requiredFeatures: parsed.data.requiredFeatures ?? [],
  };
}

/**
 * Local models are text-only: no attachments, no tools, no image or document generation.
 * Returns the list of capability violations, empty when the capabilities are acceptable.
 */
export function validateLocalCapabilities(
  capabilities: ModelCapabilities,
): readonly string[] {
  const violations: string[] = [];
  if (capabilities.streaming !== true) violations.push('streaming must be enabled');
  if (capabilities.vision !== false) violations.push('vision must be disabled');
  if (capabilities.documents.pdf !== false) violations.push('document input must be disabled');
  if (capabilities.imageGeneration !== null) violations.push('image generation must be disabled');
  if (capabilities.documentGeneration !== false) {
    violations.push('document generation must be disabled');
  }
  if (capabilities.tools !== false) violations.push('tools must be disabled');
  if (capabilities.systemPrompt !== true) violations.push('system prompt must be enabled');
  return violations;
}
