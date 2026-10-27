/**
 * Attachment metadata a message part needs to render after a reload (API contract §6.1).
 *
 * Owned by conversations and implemented over the attachments module: the read API hydrates
 * `file` for `image | document | generated_file` parts without learning table names.
 */

export type MessageFileStatus = 'available' | 'processing' | 'expired' | 'missing';

export interface MessageFileSummary {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly status: MessageFileStatus;
}

export interface MessageFileLookup {
  /** Owner-scoped batch read; ids the caller cannot see are omitted. */
  listFiles(
    attachmentIds: readonly string[],
    userId: string,
  ): Promise<readonly MessageFileSummary[]>;
}
