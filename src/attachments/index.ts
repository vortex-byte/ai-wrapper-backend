export {
  AttachmentService,
  type AttachmentView,
  type UploadInput,
  type UploadResult,
} from './application/attachment-service.ts';
export { extractTextForKind, type ExtractionResult } from './application/text-extraction.ts';
export {
  FILE_LIMITS,
  SUPPORTED_UPLOAD_KINDS,
  detectUploadKind,
  sanitizeDisplayName,
  validateUpload,
  type Attachment,
  type AttachmentKind,
  type AttachmentOrigin,
  type AttachmentStatus,
  type FileExtraction,
  type SupportedUploadKind,
} from './domain/attachment.ts';
export type { AttachmentRepository } from './ports/attachment-repository.ts';
export { DrizzleAttachmentRepository } from './infrastructure/drizzle-attachment-repository.ts';
