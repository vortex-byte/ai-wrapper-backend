export const OPENAI_OUTPUT_DIR = '/mnt/data';

export const CURATED_SKILL_IDS: Readonly<Record<string, string>> = {
  xlsx: 'openai-spreadsheets',
};

export const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  zip: 'application/zip',
};

export const MAX_CONTAINER_ARTIFACTS = 20;

export const MAX_IMAGE_ARTIFACT_BYTES = 50 * 1024 * 1024;

export const MAX_IMAGE_BASE64_LENGTH = Math.ceil((MAX_IMAGE_ARTIFACT_BYTES * 4) / 3);

export const IMAGE_FILE_PREFIX = 'image:';

/** Prefix for streamed partial-preview identifiers; a partial is never the final artifact. */
export const PARTIAL_IMAGE_FILE_PREFIX = 'image-partial:';

const SIZE_PATTERN = /^(\d{1,4})x(\d{1,4})$/;
const MAX_IMAGE_EDGE = 3840;
const MIN_IMAGE_PIXELS = 655_360;
const MAX_IMAGE_PIXELS = 8_294_400;
const MAX_IMAGE_ASPECT_RATIO = 3;

function isAcceptableSize(value: string): boolean {
  if (value === 'auto') return true;
  const match = SIZE_PATTERN.exec(value);
  if (match === null) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width % 16 !== 0 || height % 16 !== 0) return false;
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) return false;
  if (Math.max(width / height, height / width) > MAX_IMAGE_ASPECT_RATIO) return false;
  const pixels = width * height;
  return pixels >= MIN_IMAGE_PIXELS && pixels <= MAX_IMAGE_PIXELS;
}

export const IMAGE_GENERATION_OPTION_KEYS = [
  'size',
  'quality',
  'background',
  'output_format',
  'moderation',
  'action',
] as const;

type ImageOptionKey = (typeof IMAGE_GENERATION_OPTION_KEYS)[number];

/**
 * Per-option validators. The provider rejects the whole turn for an invalid value, so anything
 * that fails here is dropped (and logged) rather than forwarded.
 *
 * `gif` and `svg` are documented on the Image API, not on the Responses `image_generation` tool,
 * and an SVG returned by a tool would be stored and served as an active document.
 */
export const IMAGE_GENERATION_OPTION_VALUES: Readonly<
  Record<ImageOptionKey, (value: string) => boolean>
> = {
  size: isAcceptableSize,
  quality: (value) => ['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value),
  background: (value) => ['auto', 'transparent', 'opaque'].includes(value),
  output_format: (value) => ['png', 'jpeg', 'webp'].includes(value),
  moderation: (value) => ['auto', 'low'].includes(value),
  action: (value) => ['auto', 'generate', 'edit'].includes(value),
};

/** The image tool streams at most three partial previews. */
export const MAX_PARTIAL_IMAGES = 3;

export const MIN_OUTPUT_COMPRESSION = 0;
export const MAX_OUTPUT_COMPRESSION = 100;

export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

export const CONTAINER_FILE_PREFIX = 'container:';

export const BILLING_429_CODES: ReadonlySet<string> = new Set([
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'project_spend_limit_exceeded',
]);
