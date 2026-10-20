import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AppError } from '@/errors.ts';
import type {
  GetStreamResult,
  PutStreamResult,
  StorageHealth,
  StorageHealthProbe,
  StorageProviderPort,
} from '../ports/storage-provider.ts';

/**
 * Local filesystem implementation of StorageProviderPort.
 *
 * - writes to `<root>/<key>.tmp` then renames — a crash never leaves a half-written final blob;
 * - SHA-256 and size are computed while streaming;
 * - every path is resolved and asserted to stay inside the root (path-traversal guard);
 * - deletes are idempotent.
 */
export class LocalStorageProvider implements StorageProviderPort, StorageHealthProbe {
  readonly kind = 'local';

  constructor(private readonly root: string) {
    this.root = path.resolve(root);
  }

  /** Resolves a key to an absolute path, refusing anything that escapes the root. */
  private pathFor(key: string): string {
    const normalized = path.normalize(key).replace(/^([/\\])+/, '');
    const full = path.resolve(this.root, normalized);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new AppError('storage_unavailable', 'Invalid storage key.');
    }
    return full;
  }

  async putStream(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: { readonly contentType: string; readonly maxBytes: number },
  ): Promise<PutStreamResult> {
    void options.contentType;
    const full = this.pathFor(key);
    // A unique per-writer temp name: two concurrent puts of the same key must never share (and
    // then delete) one another's partial file.
    const tmp = `${full}.${process.pid}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(full), { recursive: true });

    const hash = createHash('sha256');
    let size = 0;
    const file = Bun.file(tmp);
    const writer = file.writer();

    try {
      if (body instanceof Uint8Array) {
        size = body.byteLength;
        if (size > options.maxBytes) {
          throw new AppError('file_too_large', 'The file exceeds the storage byte limit.');
        }
        hash.update(body);
        writer.write(body);
      } else {
        for await (const chunk of body) {
          size += chunk.byteLength;
          if (size > options.maxBytes) {
            throw new AppError('file_too_large', 'The file exceeds the storage byte limit.');
          }
          hash.update(chunk);
          writer.write(chunk);
        }
      }
      await writer.end();
      await fs.rename(tmp, full);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      if (err instanceof AppError) throw err;
      throw new AppError('storage_unavailable', 'Could not persist the file.', { cause: err });
    }

    return { key, sizeBytes: size, sha256: hash.digest('hex') };
  }

  async getStream(
    key: string,
    range?: { readonly start: number; readonly end?: number } | undefined,
  ): Promise<GetStreamResult> {
    const full = this.pathFor(key);
    const stat = await fs.stat(full).catch(() => null);
    if (stat === null || !stat.isFile()) {
      throw new AppError('not_found', 'File blob is missing.');
    }

    if (range !== undefined) {
      // An empty blob has no byte to serve; a range over it is an empty body, not an error.
      if (stat.size === 0) {
        return {
          stream: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
          sizeBytes: 0,
        };
      }
      const start = Math.max(0, Math.min(range.start, stat.size - 1));
      const end = range.end !== undefined ? Math.min(range.end, stat.size - 1) : stat.size - 1;
      if (start > end) {
        throw new AppError('invalid_request', 'Invalid byte range.');
      }
      const slice = Bun.file(full).slice(start, end + 1);
      return {
        stream: slice.stream() as ReadableStream<Uint8Array>,
        sizeBytes: end - start + 1,
      };
    }

    return {
      stream: Bun.file(full).stream() as ReadableStream<Uint8Array>,
      sizeBytes: stat.size,
    };
  }

  async exists(key: string): Promise<boolean> {
    const full = this.pathFor(key);
    try {
      const stat = await fs.stat(full);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /** Idempotent: a missing blob is a successful delete. */
  async delete(key: string): Promise<void> {
    const full = this.pathFor(key);
    await fs.rm(full, { force: true });
  }

  /**
   * Recursive listing under `prefix`, used by the weekly `storage.reconcile` sweep.
   * Keys are returned relative to the root with `/` separators so they are comparable to
   * `attachments.storage_key` regardless of platform. A missing root/prefix is an empty
   * result, not an error; symlinks are skipped (they are neither file nor directory).
   */
  async listKeys(prefix: string): Promise<string[]> {
    const base = this.pathFor(prefix);
    const keys: string[] = [];
    await this.collectKeys(base, keys);
    return keys.sort();
  }

  private async collectKeys(dir: string, keys: string[]): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) return;

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.collectKeys(full, keys);
      } else if (entry.isFile()) {
        // In-flight writes are `<key>.<pid>.<uuid>.tmp`; never report (and let the sweep
        // delete) a blob that is still being written.
        if (entry.name.endsWith('.tmp')) continue;
        keys.push(path.relative(this.root, full).split(path.sep).join('/'));
      }
    }
  }

  async health(): Promise<StorageHealth> {
    await fs.mkdir(this.root, { recursive: true });
    const statfs = await fs.statfs(this.root);
    const totalBytes = Number(statfs.blocks) * Number(statfs.bsize);
    const freeBytes = Number(statfs.bavail) * Number(statfs.bsize);
    return { freeBytes, totalBytes };
  }
}
