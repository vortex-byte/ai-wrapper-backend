import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AuthService } from '@/auth/application/auth-service.ts';
import type { Config } from '@/config/index.ts';
import { AppError, isAppError } from '@/errors.ts';
import { ok } from '@/http/envelope.ts';
import { requireAuth } from '@/http/middleware/require-auth.ts';
import { requireCsrf } from '@/http/middleware/require-csrf.ts';
import type { AppEnv } from '@/http/types.ts';
import type { AttachmentService } from '../application/attachment-service.ts';
import { FILE_LIMITS, sanitizeDisplayName, type Attachment } from '../domain/attachment.ts';

const MAX_FILES_PER_REQUEST = 5;

/** Parses `Range: bytes=a-b` (RFC 7233). Single ranges only; suffix form supported. */
export function parseRangeHeader(
  header: string | undefined,
): { start: number; end?: number } | { suffixLength: number } | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength === 0) return null;
    return { suffixLength };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start)) return null;
  const end = rawEnd !== '' ? Number(rawEnd) : null;
  if (end !== null && (!Number.isSafeInteger(end) || end < start)) return null;
  return end !== null ? { start, end } : { start };
}

/** Wire shape for an accepted upload. */
interface WireAttachment {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly status: string;
  readonly pageCount: number | null;
  readonly expiresAt: string;
}

/** Wire item for a file that failed validation. Reported per item, never as a whole-request error. */
interface WireRejectedAttachment {
  readonly name: string;
  readonly status: 'rejected';
  readonly error: { readonly code: string };
}

function toWireAttachment(attachment: Attachment): WireAttachment {
  return {
    id: attachment.id,
    name: attachment.displayName,
    kind: attachment.kind,
    mimeType: attachment.detectedMime,
    sizeBytes: attachment.sizeBytes,
    status: attachment.status,
    pageCount: attachment.pageCount,
    expiresAt: attachment.expiresAt.toISOString(),
  };
}

/** Multipart may carry one `file`/`files` entry or a repeated set; both normalise to an array. */
function collectUploadedFiles(body: Record<string, string | File | (string | File)[]>): File[] {
  const collected: File[] = [];
  for (const field of ['files', 'file']) {
    const value = body[field];
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry instanceof File) collected.push(entry);
    }
  }
  return collected;
}

export function attachmentRoutes(input: {
  readonly service: AttachmentService;
  readonly auth: AuthService;
  readonly config: Config;
}): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * Auth and CSRF are bound to this exact route so an unmatched path under the shared `/api`
   * tree falls through to `404` instead of `401`.
   */
  routes.post(
    '/conversations/:id/attachments',
    requireAuth(input.auth, input.config),
    requireCsrf(input.config),
    async (c) => {
      const auth = c.get('auth');
      if (auth === undefined) throw new AppError('unauthenticated');

      const conversationId = c.req.param('id');
      if (conversationId === undefined || conversationId === '') {
        throw new AppError('invalid_request', 'A conversation id is required.');
      }

      const body = await c.req.parseBody({ all: true });
      const files = collectUploadedFiles(body);
      if (files.length === 0) {
        throw new AppError('invalid_request', 'A multipart "files" part is required.');
      }
      if (files.length > MAX_FILES_PER_REQUEST) {
        throw new AppError(
          'invalid_request',
          `At most ${MAX_FILES_PER_REQUEST} files may be uploaded per request.`,
        );
      }

      // The cap applies to the cumulative request, not each file alone. Checked before any bytes
      // are read so an oversized body is rejected up front.
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (totalBytes > FILE_LIMITS.maxBytes) {
        throw new AppError('file_too_large');
      }

      const accepted: WireAttachment[] = [];
      const rejected: WireRejectedAttachment[] = [];
      let firstError: AppError | null = null;

      for (const file of files) {
        try {
          const result = await input.service.upload({
            userId: auth.user.id,
            conversationId,
            fileName: file.name,
            declaredMime: file.type !== '' ? file.type : null,
            bytes: new Uint8Array(await file.arrayBuffer()),
          });
          accepted.push(toWireAttachment(result.attachment));
        } catch (error) {
          // Only a rejected *file* is reported per item; anything else is a server fault.
          if (!isAppError(error)) throw error;
          firstError ??= error;
          rejected.push({
            name: sanitizeDisplayName(file.name),
            status: 'rejected',
            error: { code: error.code },
          });
        }
      }

      if (accepted.length === 0) {
        throw firstError ?? new AppError('unsupported_file_type');
      }

      const stillProcessing = accepted.some((item) => item.status !== 'ready');
      return c.json(ok({ items: [...accepted, ...rejected] }), stillProcessing ? 202 : 201);
    },
  );

  /** Processing status only; the client polls until `ready`. */
  routes.get('/attachments/:id', requireAuth(input.auth, input.config), async (c) => {
    const auth = c.get('auth');
    if (auth === undefined) throw new AppError('unauthenticated');
    const view = await input.service.getForUser(c.req.param('id'), auth.user.id);
    return c.json(
      ok({
        id: view.id,
        status: view.status,
        ...(view.errorCode !== null ? { errorCode: view.errorCode } : {}),
      }),
    );
  });

  /**
   * Content serving: ownership-scoped, with RFC 7233 byte ranges, `nosniff`, a sanitized filename
   * and a private cache.
   */
  routes.get(
    '/files/:id/content',
    requireAuth(input.auth, input.config),
    async (c: Context<AppEnv>) => {
      const auth = c.get('auth');
      if (auth === undefined) throw new AppError('unauthenticated');

      const attachmentId = c.req.param('id');
      if (attachmentId === undefined) throw new AppError('not_found');
      const range = parseRangeHeader(c.req.header('range'));
      const content = await input.service.getContent(
        attachmentId,
        auth.user.id,
        range ?? undefined,
      );
      const isImage = content.attachment.kind === 'image';

      c.header('Content-Type', content.attachment.detectedMime);
      // A 206 body is the slice, not the whole blob.
      c.header(
        'Content-Length',
        String(content.partial ? content.end - content.start + 1 : content.totalBytes),
      );
      c.header('ETag', `"${content.attachment.sha256}"`);
      c.header('Accept-Ranges', 'bytes');
      c.header('X-Content-Type-Options', 'nosniff');
      c.header('Content-Security-Policy', "sandbox; default-src 'none'");
      c.header('Cache-Control', 'private, no-store');
      // Never reflect the raw upload name; always a sanitized copy.
      const safeName = content.attachment.displayName.replace(/["\\\r\n]/g, '');
      c.header(
        'Content-Disposition',
        `${isImage ? 'inline' : 'attachment'}; filename="${safeName}"`,
      );
      if (content.partial) {
        c.header('Content-Range', `bytes ${content.start}-${content.end}/${content.totalBytes}`);
        return c.body(content.stream, 206);
      }
      return c.body(content.stream, 200);
    },
  );

  return routes;
}
