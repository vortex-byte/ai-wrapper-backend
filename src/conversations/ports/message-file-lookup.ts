/** Attachment metadata a part needs after a reload, implemented over attachments. */

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
