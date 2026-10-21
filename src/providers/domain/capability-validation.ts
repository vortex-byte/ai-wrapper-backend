import type { ModelCapabilities } from './capabilities.ts';
import type { NormalizedPart } from './pal.ts';

/** Capability-driven validation for checking request parts against model limits. */

export type CapabilityViolation = 'image_not_supported' | 'document_not_supported' | 'too_many_images';

export interface CapabilityCheckResult {
  readonly ok: boolean;
  readonly violation?: CapabilityViolation;
}

/** Validate a request's parts against the model's declared capabilities. */
export function validatePartsForModel(
  capabilities: ModelCapabilities,
  parts: readonly NormalizedPart[],
): CapabilityCheckResult {
  let imageCount = 0;
  let sawDocument = false;

  for (const part of parts) {
    if (part.type === 'image') {
      imageCount += 1;
      if (!capabilities.vision) return { ok: false, violation: 'image_not_supported' };
    }
    if (part.type === 'document') {
      sawDocument = true;
      if (!capabilities.documents.pdf && !supportsAnyDocument(capabilities)) {
        return { ok: false, violation: 'document_not_supported' };
      }
    }
  }

  if (
    capabilities.maxImagesPerRequest !== undefined &&
    imageCount > capabilities.maxImagesPerRequest
  ) {
    return { ok: false, violation: 'too_many_images' };
  }

  if (sawDocument && !supportsAnyDocument(capabilities)) {
    return { ok: false, violation: 'document_not_supported' };
  }

  return { ok: true };
}

function supportsAnyDocument(capabilities: ModelCapabilities): boolean {
  return capabilities.documents.pdf === true;
}

export function violationMessage(violation: CapabilityViolation): string {
  switch (violation) {
    case 'image_not_supported':
      return 'This model does not accept images.';
    case 'document_not_supported':
      return 'This model does not accept documents.';
    case 'too_many_images':
      return 'Too many images for this model.';
  }
}
