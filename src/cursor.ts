/**
 * Opaque keyset cursors for list endpoints. A cursor encodes the sort tuple the next page
 * continues after; clients treat it as an opaque string and never
 * construct one. Keyset — never `OFFSET` — is the only pagination strategy.
 *
 * Format: `base64url("<sort-key>|<id>")`, where `<sort-key>` is either an ISO timestamp or a
 * numeric sequence depending on the list.
 *
 * Platform helper (AGENTS.md §3.3): it is pure, lives outside `http/`, and may be imported by
 * `http/` and `application/` — but never by `domain/`, which stays dependency-free.
 */

export interface KeyedCursor {
  readonly sortKey: string;
  readonly id: string;
}

export function encodeCursor(sortKey: string, id: string): string {
  return Buffer.from(`${sortKey}|${id}`).toString('base64url');
}

/** Returns `null` for a malformed cursor so the route can raise `400 invalid_request`. */
export function decodeCursor(cursor: string): KeyedCursor | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.indexOf('|');
    if (separator <= 0 || separator === decoded.length - 1) return null;
    return {
      sortKey: decoded.slice(0, separator),
      id: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

export function encodeTimestampCursor(date: Date, id: string): string {
  return encodeCursor(date.toISOString(), id);
}

export function decodeTimestampCursor(cursor: string): { date: Date; id: string } | null {
  const parsed = decodeCursor(cursor);
  if (parsed === null) return null;
  const date = new Date(parsed.sortKey);
  if (Number.isNaN(date.getTime())) return null;
  return { date, id: parsed.id };
}

export function encodeSeqCursor(seq: number, id: string): string {
  return encodeCursor(String(seq), id);
}

export function decodeSeqCursor(cursor: string): { seq: number; id: string } | null {
  const parsed = decodeCursor(cursor);
  if (parsed === null) return null;
  const seq = Number(parsed.sortKey);
  if (!Number.isSafeInteger(seq)) return null;
  return { seq, id: parsed.id };
}

/** A UUID-shaped id — used to reject a corrupt cursor before it reaches SQL. */
export function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
