/**
 * Provider-file cleanup seam for the glue modules (artifact sink, attachment expiry, conversation
 * purge). It carries no provider format — only an opaque id plus the registry key that owns it —
 * so callers stay free of `providers/`. Resolution to an adapter lives in `providers/`.
 */
export interface ProviderFileRef {
  readonly providerFileId: string;
  /** Provider registry key; `null` when the attachment carries no provider reference. */
  readonly providerKey: string | null;
}

export interface ProviderFileCleaner {
  /** Best-effort delete; resolves to `false` when the file was skipped or could not be removed. */
  deleteFile(file: ProviderFileRef): Promise<boolean>;
}
