/** Storage port for persisting, reading, and listing binary artifact streams. */

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

  /** Lists stored keys under a prefix for reconciliation. */
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
