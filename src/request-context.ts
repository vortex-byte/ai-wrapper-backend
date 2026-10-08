/** Provenance attached to audit rows and security events (never logged as content). */
export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgentHash: string | null;
  readonly requestId: string | null;
}

export function emptyRequestMeta(): RequestMeta {
  return { ip: null, userAgentHash: null, requestId: null };
}
