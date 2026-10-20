/**
 * The binary-artifact seam.
 *
 * Consumers: `attachments/` (upload pipeline), `artifactsink/` (generated files), cleanup jobs.
 * Implemented by `storage/infrastructure/` (local now, S3 later).
 *
 * Rules the port protects:
 * - keys are opaque, app-generated strings — never filesystem paths;
 * - implementations must be idempotent on delete (a missing key is success);
 * - `putStream` computes SHA-256 while streaming so the DB row reflects the exact stored bytes.
 */

export interface PutStreamResult {
  readonly key: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface GetStreamResult {
  readonly stream: ReadableStream<Uint8Array>;
  readonly sizeBytes: number;
  readonly contentType?: string | undefined;
}

export interface StorageProviderPort {
  readonly kind: string;

  /** Writes the stream under `key`; rejects if the payload exceeds `maxBytes`. */
  putStream(
    key: string,
    body: ReadableStream<Uint8Array> | Uint8Array,
    options: { readonly contentType: string; readonly maxBytes: number },
  ): Promise<PutStreamResult>;

  getStream(
    key: string,
    range?: { readonly start: number; readonly end?: number } | undefined,
  ): Promise<GetStreamResult>;

  exists(key: string): Promise<boolean>;

  /** Idempotent: deleting a missing key resolves successfully. */
  delete(key: string): Promise<void>;

  /**
   * Every stored key under `prefix`, relative to the root and `/`-separated (e.g. `files/2026/10/<uuid>`).
   * Used only by the weekly `storage.reconcile` sweep to find orphaned blobs; returns `[]` when nothing
   * is stored under the prefix (a missing root is not an error).
   */
  listKeys(prefix: string): Promise<string[]>;
}

/** Free bytes available at the storage root, used by the upload disk gate. */
export interface StorageHealth {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

export interface StorageHealthProbe {
  health(): Promise<StorageHealth>;
}
