# API Contracts — Internal Office AI Chat Platform

| | |
|---|---|
| **Document status** | v1.3 — aligned with `docs/PRD.md` (Draft v1.3) |
| **Date** | 2026-10-08 |
| **Base URL** | `/api` (e.g. `https://ai.corp.example/api`). Ops endpoints are served at the root (`/healthz`, `/readyz`, `/metrics`). |
| **Transport** | HTTPS · JSON (`application/json`) · SSE (`text/event-stream`) for generation streams |

This file is the contract between the backend and the SPA. The PRD is authoritative for behaviour;
this document is authoritative for **wire shapes**. Where they disagree, fix both.

**v1.3 changes:** every JSON response is wrapped in a uniform envelope (§1.1/§1.2); the API is
**unversioned** — paths use the `/api` prefix with no version segment (§17); errors always carry a
stable `code`; `trace` is included **only when `NODE_ENV=development`**.

**v1.1 changes:** authentication is email + password with a server-backed session cookie (no OIDC);
new `password_change_required` gate/error; new `POST /me/password` and
`POST /admin/users/:id/password/reset`; provider API keys are **not** part of the API (configured via
environment — PRD A-16).

---

## 1. Conventions

- **Fields:** `camelCase`. **IDs:** UUIDv7 strings. **Timestamps:** ISO-8601 UTC (`2026-10-08T09:30:00Z`).
- **Auth:** a session cookie (`__Host-session`, `HttpOnly; Secure; SameSite=Lax; Path=/`). All `/api` endpoints require it except `/api/auth/login`. Ops endpoints are internal. See §2.
- **CSRF:** the SPA and API are served from different subdomains of the same site, so the cookie is sent by the browser but CORS applies. Every **non-GET** `/api` request must send `X-CSRF-Token` — the token returned by `POST /api/auth/login` (and re-issued on password change) — and must pass an `Origin` check against `ALLOWED_ORIGINS`. Missing/invalid → `403 forbidden`. **Exception:** `POST /api/auth/login` is validated by the `Origin` check only, since it is the endpoint that issues the token (`SameSite=Lax` + the strict origin allow-list bound the login-CSRF risk).
- **Request ID:** every response carries `X-Request-Id`. A client-supplied value is honored only if it
  matches `^[A-Za-z0-9_-]{8,64}$`, otherwise the server replaces it. The request id is **not** repeated
  inside response bodies; read it from the header.
- **Idempotency:** requests that create a generation require `Idempotency-Key` (a UUID). See §6.2.
- **Pagination:** cursor-based: `?limit=50&cursor=…` → `data` is `{ "items": [...], "nextCursor": string | null }`.
  Never use `offset`.
- **Unknown fields:** rejected on mutations (`400 invalid_request`).
- **No provider-specific fields** ever appear in a response; providers are represented by a display label only.
- **Provider secrets** are never accepted or returned by any endpoint (env-only — PRD A-16).
- **Envelope exemptions (raw bodies):** `GET /api/files/:id/content` (binary + `Range`), SSE frames
  (§7.2), `/healthz`, `/readyz`, `/metrics`. Everything else uses the envelope.

### 1.1 Success envelope (all 2xx with a body)

```json
{ "status": "ok", "message": "Signed out.", "data": { "…": "…" } }
```

- `status` is always `"ok"`.
- `message` is human-readable display text; it **may be empty (`""`)** and must never be parsed for logic.
- `data` holds the payload — an object or an array. The **`data` key is omitted entirely** when the
  operation returns nothing (see the empty-result cases below). Clients must not rely on `data` being present.
- Empty results still use an object: e.g. `"data": { "items": [], "nextCursor": null }`.

### 1.2 Error envelope (all non-2xx JSON errors)

```json
{
  "status": "error",
  "code": "quota_exceeded",
  "message": "Your monthly token quota is exhausted.",
  "retryable": false,
  "details": { "resetAt": "2026-11-01T00:00:00+07:00", "remainingTokens": 0 },
  "trace": "…only present when NODE_ENV=development…"
}
```

- `status` is always `"error"`. `code` values are stable (full catalog in §14); `message` is display
  text (English) and may change.
- `retryable` tells the client whether re-issuing the request may succeed.
- `details` is optional and code-specific (see §14).
- `trace` (stack trace) is present **only** when `NODE_ENV=development`. It is sanitized — never
  contains keys, provider bodies, or SQL parameter values — and is **never** returned in staging or
  production. Request correlation in all environments is via the `X-Request-Id` header.

### 1.3 Response headers

Headers are grouped by response class. `always` means every response (success **and** error) unless the
row says otherwise. All header **values** are strings on the wire; "Value type" describes the logical
type that string encodes. Header names are case-insensitive on the wire.

#### 1.3.1 Always present (2xx and non-2xx)

| Header | Value type | When shown | Notes |
|---|---|---|---|
| `X-Request-Id` | string, `^[A-Za-z0-9_-]{8,64}$` | always | Echoes a valid client-supplied id, else a server-generated UUID. Correlation handle in all environments. |
| `Content-Type` | string | whenever there is a body | `application/json; charset=UTF-8` for enveloped bodies; `text/event-stream` (§7.2) and blob types (§8.4) are exceptions. Absent on bodiless responses. |
| `Cache-Control` | string, literal `no-store` | always on `/api` JSON and `/metrics` | JSON API responses are never cacheable. Overridden on `GET /api/files/:id/content` → `private, no-store` (§8.4). |
| `Vary` | string, contains `Origin` | always | Set even when no `Origin` is present, so shared caches never mix origins. |
| `X-Content-Type-Options` | string, literal `nosniff` | always | Baseline hardening. |
| `X-Frame-Options` | string, literal `DENY` | always | |
| `Referrer-Policy` | string, literal `no-referrer` | always | |
| `Cross-Origin-Opener-Policy` | string, literal `same-origin` | always | |
| `Cross-Origin-Resource-Policy` | string, literal `same-origin` | always | |
| `Strict-Transport-Security` | string, literal `max-age=63072000; includeSubDomains` | **production only** | Omitted in development/test (meaningful only behind TLS). |

#### 1.3.2 Success only (2xx)

| Header | Value type | When shown | Notes |
|---|---|---|---|
| `Set-Cookie: __Host-session=…` | string (Set-Cookie) | `POST /api/auth/login` (200) and `POST /api/me/password` (200) | Attributes `HttpOnly; Secure; SameSite=Lax; Path=/` and **no** `Domain`. On login it issues the session; on password change it carries the rotated session id. |
| `Set-Cookie: __Host-session=; Max-Age=0` | string (Set-Cookie) | `DELETE /api/auth/session` (200) | Clears the cookie; same attributes as the issue form. |
| `Idempotency-Replayed` | string, literal `true` | `2xx` of a replayed `POST …/messages` / retry (§6.2, §6.3) | Omitted on the first, non-replayed response. The body is byte-identical to the original. |
| `RateLimit-Limit` | integer as string, `>= 0` | 2xx of rate-limited routes | Max requests in the current window (§16). |
| `RateLimit-Remaining` | integer as string, `>= 0` | 2xx of rate-limited routes | Requests left in the window. Exposed to the SPA via CORS. |
| `RateLimit-Reset` | integer as string (Unix seconds) | 2xx of rate-limited routes | When the window resets. |
| `Content-Disposition` | string, `inline` \| `attachment; filename="…"` | `GET /api/files/:id/content` (200/206) | `inline` for validated images, `attachment` otherwise (§8.4). |
| `Content-Range` | string, `bytes <start>-<end>/<total>` | `GET /api/files/:id/content` **206 only** | Present only when a `Range` request is satisfied. |
| `Accept-Ranges` | string, literal `bytes` | `GET /api/files/:id/content` (200/206) | Advertises `Range` support. |
| `Content-Length` | integer as string, `>= 0` | any response with a known-length body | Absent for SSE and chunked streams. |

#### 1.3.3 Error only (non-2xx)

| Header | Value type | When shown | Notes |
|---|---|---|---|
| `Retry-After` | integer as string (seconds) or HTTP-date | `429` and `503` (`provider_unavailable`, `provider_rate_limited`, `service_busy`, `storage_unavailable`) | How long to wait before retrying. Mirrors the envelope's `retryable: true`. |
| `RateLimit-Limit` / `-Remaining` / `-Reset` | as in §1.3.2 | `429 rate_limited` (and other rate-limited errors) | Present on the rejection so the client can back off precisely. |

> Non-2xx responses otherwise reuse the "always" headers in §1.3.1 — an error is still `no-store`, still
> carries `X-Request-Id`, and still has the hardening headers.

#### 1.3.4 CORS headers (when the request is cross-origin)

Present on any response whose request carried an `Origin` matching `ALLOWED_ORIGINS`, and on the
matching preflight. A non-allowed origin receives **none** of these (the browser blocks it); the
preflight is still answered `204`, while a **mutating** request from a non-allowed origin is actively
rejected with `403 forbidden` by the CSRF/`Origin` check (§1).

| Header | Value type | When shown | Notes |
|---|---|---|---|
| `Access-Control-Allow-Origin` | string, an exact origin | origin allowed | **Never `*`** — an exact echo of the allowed origin. |
| `Access-Control-Allow-Credentials` | string, literal `true` | origin allowed | Required for the session cookie to ride along. |
| `Access-Control-Expose-Headers` | string, literal `X-Request-Id, RateLimit-Remaining` | origin allowed | Headers the SPA may read from JS. |
| `Access-Control-Allow-Methods` | string, CSV of methods | **preflight (OPTIONS) only** | `GET, POST, PATCH, DELETE, OPTIONS`. |
| `Access-Control-Allow-Headers` | string, CSV of names | **preflight only** | `Content-Type, X-CSRF-Token, Idempotency-Key, X-Request-Id`. |
| `Access-Control-Max-Age` | integer as string (seconds), literal `600` | **preflight only** | Browsers cache the preflight for 10 min. |

**Preflight.** An `OPTIONS` request under `/api` returns **`204 No Content`** with an empty body,
`Vary: Origin`, and — when the origin is allowed — the `Access-Control-Allow-Methods` / `-Headers` /
`-Max-Age` headers above. It bypasses auth: a preflight never carries the session cookie, so it must
not require it.

**CSRF token.** `POST /api/auth/login` returns `data.csrfToken` alongside the session cookie; it is a
stateless `nonce.base64url(HMAC-SHA256(SESSION_SECRET, nonce + ":" + issuedAt))` valid for **12 h**.
Send it as `X-CSRF-Token` on every non-GET request. It is re-issued when the password changes (session
rotation); the SPA should store it in memory only (never `localStorage`).

---

## 2. Authentication & session

### 2.1 `POST /api/auth/login` — public

Request:
```json
{ "email": "ada@corp.example", "password": "correct horse battery staple" }
```
Success `200`:
```json
{ "status": "ok", "message": "", "data": {
    "user": { "id": "0192…", "email": "ada@corp.example", "displayName": "Ada L.",
              "role": "user", "divisionId": "0192…", "mustChangePassword": false },
    "csrfToken": "0fT2…​.9c1a…" } }
```
Plus `Set-Cookie: __Host-session=…`. The `csrfToken` is required as `X-CSRF-Token` on later non-GET
requests (§1); store it in memory only.

Failure `401`:
```json
{ "status": "error", "code": "unauthenticated", "message": "Invalid email or password.",
  "retryable": false }
```

Rules:
- The error is **generic** — never reveals whether the email exists (no user enumeration).
- After **8** consecutive failures the account is locked for **15 min**; while locked the response is
  still `401 unauthenticated` (optionally with `Retry-After`).
- The route is rate-limited per IP (**10/min**). Failures emit a `failed_login` audit row.
- On success the session id is rotated and `failed_login_attempts`/`locked_until` are reset.

### 2.2 `DELETE /api/auth/session` — user

Destroys the current session.
```json
{ "status": "ok", "message": "Signed out." }
```
`200` (no `data`). The `Set-Cookie` clears `__Host-session`.

### 2.3 Forced password change gate

When `user.mustChangePassword == true`, **every** endpoint except these three returns
`403 password_change_required`:

- `GET /api/me`
- `POST /api/me/password`
- `DELETE /api/auth/session`

```json
{ "status": "error", "code": "password_change_required",
  "message": "You must change your password before continuing.", "retryable": false }
```

### 2.4 `POST /api/me/password` — user

Request:
```json
{ "currentPassword": "old…", "newPassword": "new…" }
```
```json
{ "status": "ok", "message": "Password updated.", "data": { "csrfToken": "0fT2….9c1a…" } }
```
`200`. Side effects: `password_updated_at` set, `must_change_password` cleared, **all other sessions
revoked**, and the caller's session **rotated** (a fresh `__Host-session` cookie is set) with a new
`csrfToken` returned. `401 unauthenticated` if `currentPassword` is wrong; `400 invalid_request` if the
new password fails policy (min length 12).

---

## 3. Me

### 3.1 `GET /api/me`

```json
{ "status": "ok", "message": "", "data": {
    "id": "0192…", "email": "ada@corp.example", "displayName": "Ada L.",
    "role": "user", "status": "active", "divisionId": "0192…",
    "mustChangePassword": false, "createdAt": "2026-01-02T10:00:00Z" } }
```

### 3.2 `GET /api/me/quota`

```json
{ "status": "ok", "message": "", "data": {
    "period": { "start": "2026-10-01T00:00:00+07:00", "end": "2026-11-01T00:00:00+07:00" },
    "limitTokens": 500000, "usedTokens": 20000, "reservedTokens": 24310, "remainingTokens": 455690,
    "limits": { "maxInputTokensPerRequest": 100000, "maxOutputTokensPerRequest": 8000,
                "maxConcurrentGenerations": 2 } } }
```
The period is the calendar month in the configured quota timezone (default `Asia/Jakarta`); instants
are serialized as UTC or with an explicit offset. Use `period.start` for a localized "resets on" label.

### 3.3 `GET /api/me/usage?from&to&groupBy=day|model`

```json
{ "status": "ok", "message": "", "data": { "items": [
    { "key": { "day": "2026-10-07" }, "requests": 31, "failedRequests": 1,
      "inputTokens": 182340, "outputTokens": 20114, "quotaTokens": 202454,
      "estimatedCostUsd": 0.91 } ] } }
```

---

## 4. Models

### 4.1 `GET /api/models`

Returns only models the caller may use (archived/retired hidden for new conversations; see statuses).

```json
{ "status": "ok", "message": "", "data": { "items": [
    { "id": "0192…", "displayName": "Claude (Sonnet class)", "providerLabel": "Anthropic",
      "status": "active", "deprecation": null,
      "capabilities": { "streaming": true, "vision": true, "documents": { "pdf": true },
                        "imageGeneration": false, "documentGeneration": false,
                        "contextWindow": 200000, "maxOutputTokens": 8192 },
      "limits": { "maxFilesPerMessage": 5, "maxImagesPerMessage": 10 } } ] } }
```

`status`: `active | disabled | deprecated | retired`. `deprecation` is `null` or
`{ "retireAt": "…", "replacementModelId": "…" }`.

---

## 5. Conversations

### 5.1 `POST /api/conversations`

```json
{ "modelId": "0192…", "title": null }
```
`201`:
```json
{ "status": "ok", "message": "Conversation created.", "data": {
    "id": "0192…", "modelId": "0192…", "title": "New conversation",
    "createdAt": "…", "modelLocked": false } }
```
`modelLocked` becomes `true` after the first message (`422 model_unavailable` if the model is not usable).

### 5.2 `GET /api/conversations?limit&cursor`

```json
{ "status": "ok", "message": "", "data": {
    "items": [ { "id": "…", "title": "…", "modelId": "…", "messageCount": 14,
                 "lastMessageAt": "…", "createdAt": "…" } ],
    "nextCursor": "01J…" } }
```

### 5.3 `GET /api/conversations/:id`

Conversation detail (same shape as 5.1 plus `messageCount`, `lastMessageAt`) inside `data`.
`404` for another user's conversation (never `403`).

### 5.4 `PATCH /api/conversations/:id`

```json
{ "title": "Contract review" }
```
`200` with the updated conversation inside `data`. Only the title is mutable.

### 5.5 `DELETE /api/conversations/:id`

```json
{ "status": "ok", "message": "Conversation deleted." }
```
`200` (no `data`). Soft-delete. Messages/parts/files become inaccessible (`404` on later reads) and are
purged after the retention window.

### 5.6 `POST /api/conversations/:id/fork` — P1

Creates a **new** conversation seeded with a copy of the history, on a different model.

```json
{ "modelId": "0192…" }
```
`201` with the new conversation inside `data`. This is **not** a model switch — the original is untouched.

---

## 6. Messages & sending

### 6.1 `GET /api/conversations/:id/messages?limit=50&before=<seq>`

```json
{ "status": "ok", "message": "", "data": { "items": [
    { "id": "…", "seq": 13, "role": "assistant", "status": "complete",
      "finishReason": "stop", "createdAt": "…", "generationId": "…",
      "parts": [
        { "id": "…", "position": 0, "type": "text", "format": "markdown", "text": "…" },
        { "id": "…", "position": 1, "type": "image", "origin": "assistant",
          "file": { "id": "…", "mimeType": "image/png", "width": 1024, "height": 1024,
                    "status": "available", "downloadUrl": "/api/files/…/content" } },
        { "id": "…", "position": 2, "type": "generated_file",
          "file": { "id": "…", "name": "summary.pdf", "mimeType": "application/pdf",
                    "sizeBytes": 84211, "status": "expired" } } ] } ],
    "nextCursor": null } }
```

Message `status`: `streaming | complete | incomplete | failed`.
File `status`: `available | processing | expired | missing` (`expired`/`missing` → no `downloadUrl`).

**Part types (wire):**

| `type` | Extra fields |
|---|---|
| `text` | `text`, `format` (`markdown`) |
| `image` | `origin` (`user`\|`assistant`), `file` |
| `document` | `file` (extracted text is never returned inline) |
| `generated_file` | `origin`, `file` |
| `structured` (P2) | `data` |
| reserved: `tool_call`, `tool_result`, `reasoning` | ignored by clients that don't know them |

### 6.2 `POST /api/conversations/:id/messages` — idempotent

Headers: `Idempotency-Key: 3f2b…` (**required**), plus `X-CSRF-Token` (see §1).

```json
{
  "parts": [
    { "type": "text", "text": "Summarize the attached contract and list risks." },
    { "type": "file", "fileId": "0192…" }
  ],
  "options": { "maxOutputTokens": 4000 }
}
```

`202 Accepted`:
```json
{ "status": "ok", "message": "Generation queued.", "data": {
    "userMessage":      { "id": "…", "seq": 12, "role": "user", "status": "complete", "parts": [ … ] },
    "assistantMessage": { "id": "…", "seq": 13, "role": "assistant", "status": "streaming", "parts": [] },
    "generation":       { "id": "…", "status": "pending", "streamUrl": "/api/generations/…/stream" },
    "quota":            { "reservedTokens": 24310, "remainingTokens": 475690 } } }
```

**Idempotency semantics**

- Same key + same payload hash → the **original** response is replayed, with
  `Idempotency-Replayed: true` and the **same** `generation.id`. The client then attaches to the stream.
- Same key + different payload → `422 idempotency_key_reuse`.
- The idempotency insert, quota reservation, message/generation creation, and file attachment commit
  in **one transaction**; a concurrent duplicate blocks on the primary key and then replays. There is
  no "in progress" limbo state.
- Keys expire after 24 h.

**Errors:** `409 generation_in_progress`, `409 file_not_ready`, `422 unsupported_for_model`,
`422 context_too_large`, `422 idempotency_key_reuse`, `429 quota_exceeded | concurrency_limit | rate_limited`,
`503 service_busy`.

### 6.3 `POST /api/conversations/:id/messages/:mid/retry`

Retries a `failed`/`cancelled` generation for the same user message. Creates a **new** generation and a
**new** assistant message, and sets `supersededBy` on the old one.
`202` with the same `data` shape as §6.2. Requires `Idempotency-Key`.

---

## 7. Generations & streaming

### 7.1 `GET /api/generations/:id`

```json
{ "status": "ok", "message": "", "data": {
    "id": "…", "conversationId": "…", "status": "completed",
    "finishReason": "stop",
    "usage": { "inputTokens": 18250, "outputTokens": 1190, "quotaTokens": 19440, "source": "provider" },
    "remainingQuota": 455920,
    "error": null } }
```
On failure `data.error` is `{ "code": "provider_unavailable", "message": "…", "retryable": true }`.

### 7.2 `GET /api/generations/:id/stream` (SSE) — **raw, not enveloped**

Optional request header `Last-Event-ID` (the last `id:` the client saw) to replay missed events.
Response headers:
```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
Connection: keep-alive
```

**Frame format:** `id: <seq>` (monotonic per generation), `event: <type>`, `data: <json>`.
SSE frames are **not** wrapped in the JSON envelope; `generation.failed` carries the error fields
(`code`, `message`, `retryable`) directly.

```
id: 1
event: generation.state
data: {"state":"generating"}

id: 2
event: part.started
data: {"partId":"…","position":0,"type":"text"}

id: 3
event: text.delta
data: {"partId":"…","delta":"Here is "}

id: 87
event: generation.completed
data: {"finishReason":"stop","usage":{"inputTokens":18250,"outputTokens":1190,"quotaTokens":19440},"remainingQuota":455920}
```

**Event catalog**

| Event | Payload | Purpose |
|---|---|---|
| `generation.state` | `{state}` | `pending \| generating \| …` |
| `message.created` | `{userMessageId, assistantMessageId}` | first frame |
| `context.truncated` | `{droppedMessages, droppedAttachments}` | UI notice |
| `part.started` | `{partId, position, type, mimeType?, name?}` | new part |
| `text.delta` | `{partId, delta}` | text chunk (coalesced ≤ 20/s) |
| `part.completed` | `{partId, status, fileId?, downloadUrl?}` | binary frames only after the file is stored |
| `progress` | `{stage, percent?}` | job-style generations |
| `usage.updated` | `{inputTokens, outputTokens}` | optional live meter |
| `generation.completed` | `{finishReason, usage:{input,output,quotaTokens}, remainingQuota}` | terminal ✅ |
| `generation.cancelled` | `{reason}` | terminal |
| `generation.failed` | `{error:{code,message,retryable}}` | terminal ❌ |
| `snapshot` | `{message with parts so far}` | sent when replay from the ring buffer is impossible |
| `:heartbeat` | — (comment) | every 15 s |
| reserved | `tool.*`, `reasoning.delta` | clients must ignore unknown events |

Reconnect: if `Last-Event-ID` is still in the server buffer the stream replays then goes live; otherwise
it emits `snapshot` (built from PostgreSQL) and continues. A disconnected client within the 60 s grace
does not cancel the generation (PRD A-12).

### 7.3 `POST /api/generations/:id/cancel`

Idempotent.
```json
{ "status": "ok", "message": "Cancellation requested." }
```
`202` (no `data`). Aborts the provider call, persists partial text, marks the generation `cancelled`,
and settles/releases quota accordingly.

---

## 8. Attachments & file content

### 8.1 `POST /api/conversations/:id/attachments`

`multipart/form-data`, field `files` (≤ 5 files, ≤ 30 MB total). Rate-limited (§16).

`201 | 202`:
```json
{ "status": "ok", "message": "", "data": { "items": [
    { "id": "…", "name": "contract.pdf", "kind": "document", "mimeType": "application/pdf",
      "sizeBytes": 1048576, "status": "processing", "pageCount": null,
      "expiresAt": "2026-10-08T15:00:00Z" } ] } }
```
- `201` if every accepted file finished its fast-path extraction; `202` if any is still `processing`.
- Per-file failures are reported **per item** (`"status":"rejected","error":{"code":"unsupported_file_type"}`).
  HTTP `201` if at least one was accepted, `4xx` if all failed.

### 8.2 `GET /api/attachments/:id`

Status only (`uploading | validating | processing | ready | rejected | failed | expired | deleted`) in `data`.
Poll until `ready` before sending it in a message.

### 8.3 `DELETE /api/attachments/:id`

Deletes an **unattached** upload.
```json
{ "status": "ok", "message": "Attachment deleted." }
```
`200` (no `data`). Attached files cannot be deleted here.

### 8.4 `GET /api/files/:id/content` — **raw, not enveloped**

Streams the blob (uploaded or generated). Owner-only — admins/auditors are **not** exempt.
- Validated images: `Content-Disposition: inline`; everything else `attachment`.
- Also: `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox; default-src 'none'`, supports `Range`.
- `404` if not owner, `410`/part `status: expired` if the TTL passed.

---

## 9. Admin — users & divisions

All admin routes require `role=admin`. Every mutation writes an `audit_logs` row in the same transaction.

| Method & path | Description |
|---|---|
| `GET /api/admin/users?query&divisionId&status&limit&cursor` | List/search users |
| `POST /api/admin/users` | Create/pre-provision a user (email, displayName, role, divisionId; initial password or `generatePassword: true`) |
| `GET /api/admin/users/:id` | Detail |
| `PATCH /api/admin/users/:id` | Update role / division / status (`status: disabled` revokes all sessions) |
| `POST /api/admin/users/:id/password/reset` | Reset password |
| `GET /api/admin/divisions` · `POST /api/admin/divisions` · `PATCH /api/admin/divisions/:id` | Divisions |

`POST /api/admin/users` request:
```json
{ "email": "new@corp.example", "displayName": "New Hire",
  "role": "user", "divisionId": "0192…", "generatePassword": true }
```
`201`:
```json
{ "status": "ok", "message": "User created.", "data": {
    "id": "…", "email": "new@corp.example", "mustChangePassword": true,
    "temporaryPassword": "Kx7-…" } }
```
`temporaryPassword` is returned **only** when `generatePassword: true` and only in this response; it is
never stored in plaintext.

`POST /api/admin/users/:id/password/reset`:
```json
{ "generatePassword": true, "reason": "User forgot password (ticket #4821)" }
```
`200` → `{ "status": "ok", "message": "Password reset.", "data": { "temporaryPassword": "Kx7-…" } }`
(or `200` with **no `data`** if a `newPassword` was supplied).
Side effects: revokes **all** the user's sessions, sets `mustChangePassword`.

Safeguards: cannot disable/demote the last active admin.

---

## 10. Admin — quota & usage

### 10.1 `GET /api/admin/quota-policies/:scope/:id?`

`scope` ∈ `global | division | user`. Returns the raw policy row (nullable fields inherit) in `data`.

### 10.2 `PUT /api/admin/quota-policies/:scope/:id?`

```json
{ "monthlyTokens": 1000000, "maxInputTokensPerRequest": 150000,
  "maxOutputTokensPerRequest": 16000, "maxConcurrentGenerations": 3,
  "applyToCurrentPeriod": true, "reason": "Legal team pilot" }
```
`null` fields inherit from division/global. `applyToCurrentPeriod: true` re-resolves and adjusts the
current `quota_accounts` row via a ledger `adjust` entry. Returns the updated policy in `data`.

### 10.3 `POST /api/admin/users/:id/quota/adjustments`

```json
{ "tokens": 200000, "reason": "Incident follow-up", "expiresAtPeriodEnd": true }
```
Positive = grant, negative = claw back. Writes a ledger row (never edits history) + audit.
`200` → `{ "status": "ok", "message": "Adjustment applied.", "data": { "entryType": "adjust", "tokensDelta": 200000 } }`.

### 10.4 `GET /api/admin/users/:id/quota`

Current period counters plus the recent ledger:
```json
{ "status": "ok", "message": "", "data": {
    "period": { "start": "…", "end": "…" },
    "limitTokens": 1000000, "usedTokens": 123456, "reservedTokens": 0, "remainingTokens": 876544,
    "ledger": [ { "entryType": "settle", "tokensDelta": 12400, "reason": null,
                  "createdAt": "…", "requestId": "…" } ] } }
```

### 10.5 `GET /api/admin/usage?from&to&groupBy=user|model|provider|day|month|division`

```json
{ "status": "ok", "message": "", "data": { "items": [
    { "key": { "modelId": "…", "displayName": "…", "provider": "anthropic" },
      "requests": 1523, "failedRequests": 12,
      "inputTokens": 8123412, "outputTokens": 912331, "quotaTokens": 9035743,
      "estimatedCostUsd": 41.27,
      "usageSource": { "provider": 0.998, "estimated": 0.002 } } ] } }
```

---

## 11. Admin — providers & models

### 11.1 `GET /api/admin/providers` · `POST /api/admin/providers` · `PATCH /api/admin/providers/:id`

Provider registry. **The API key is never accepted or returned** — `secretRef` is the **name of the
environment variable** that holds it (PRD A-16).

`PATCH /api/admin/providers/:id`:
```json
{ "displayName": "Anthropic", "secretRef": "ANTHROPIC_API_KEY", "status": "active",
  "config": { "maxConcurrency": 8, "connectTimeoutMs": 10000 } }
```
`GET` response (`data`):
```json
{ "id": "…", "key": "anthropic", "displayName": "Anthropic", "adapter": "anthropic",
  "baseUrl": null, "secretRef": "ANTHROPIC_API_KEY", "status": "active",
  "config": { "maxConcurrency": 8 }, "configVersion": 4, "updatedAt": "…" }
```
> Rotating the actual key is an operator action: update the env/`.env` file and restart the process
> (rolling restart). See PRD §15.6, §24.2.

### 11.2 `GET /api/admin/models` · `POST /api/admin/models` · `PATCH /api/admin/models/:id`

```json
{ "status": "disabled",
  "capabilities": { "streaming": true, "vision": true, "documents": { "pdf": true },
                    "contextWindow": 200000, "maxOutputTokens": 8192, "schemaVersion": 1 },
  "defaultMaxOutputTokens": 4096, "quotaWeight": 1.0,
  "config": { "timeoutMs": 180000 } }
```

### 11.3 `GET /api/admin/providers/health`

```json
{ "status": "ok", "message": "", "data": { "items": [
    { "providerId": "…", "key": "anthropic", "status": "healthy",
      "lastCheckAt": "…", "latencyMs": 214,
      "errorRate5m": 0.0, "errorRate60m": 0.012, "circuit": "closed" } ] } }
```

### 11.4 `POST /api/admin/providers/:id/test`

Runs a cheap health check now (must not consume meaningful tokens). `200`:
```json
{ "status": "ok", "message": "", "data": { "ok": true, "latencyMs": 230, "detail": "models.list ok" } }
```

---

## 12. Admin — errors & audit

### 12.1 `GET /api/admin/errors?from&to&category&providerId&modelId&limit&cursor`

Sanitized `error_events` (no provider bodies, keys, or stack traces) in `data` as
`{ "items": [...], "nextCursor": … }`.

### 12.2 `GET /api/admin/audit-logs?from&to&actorUserId&action&targetType&targetId&limit&cursor`

```json
{ "status": "ok", "message": "", "data": { "items": [
    { "id": "10231", "action": "user.password_reset", "actorUserId": "…",
      "targetType": "user", "targetId": "…", "before": null,
      "after": { "mustChangePassword": true }, "requestId": "…",
      "ip": "10.0.4.19", "createdAt": "…" } ],
    "nextCursor": null } }
```
`before`/`after` are redacted — key material and passwords never appear.

---

## 13. Ops — **raw, not enveloped**

| Endpoint | Purpose | Access |
|---|---|---|
| `GET /healthz` | liveness (no dependencies) | internal |
| `GET /readyz` | DB reachable, migrations current, storage writable | internal |
| `GET /metrics` | Prometheus exposition | network-restricted |

Provider health is **not** part of readiness.

---

## 14. Error catalog

`code` is stable; each maps to an HTTP status and a default `retryable` value in the error envelope
(§1.2). `details` accompanies the codes that need it.

| `code` | HTTP | Retryable | `details` / Notes |
|---|---|---|---|
| `invalid_request` | 400/422 | no | `details.fields` lists problems |
| `unauthenticated` | 401 | no (re-login) | no/expired session, disabled user, bad credentials (generic), or locked account |
| `forbidden` | 403 | no | role lacks permission (also CSRF failure) |
| `password_change_required` | 403 | no | `mustChangePassword` gate (§2.3) |
| `not_found` | 404 | no | also used for other users' resources |
| `conflict` / `generation_in_progress` | 409 | after finish | an active generation already exists |
| `idempotency_key_reuse` | 422 | no | same key, different payload |
| `model_unavailable` | 409 | later | may include `details.replacementModelId` |
| `unsupported_for_model` | 422 | no | e.g. image to a non-vision model |
| `context_too_large` | 422 | no | message + attachments exceed limits |
| `provider_unavailable` | 503 | yes | provider down/misconfigured (details hidden) |
| `provider_rate_limited` | 503 | yes (`Retry-After`) | upstream throttling |
| `rate_limited` | 429 | yes (`Retry-After`) | platform limit |
| `quota_exceeded` | 429 | after reset/grant | `details.resetAt`, `details.remainingTokens` |
| `concurrency_limit` | 429 | after a generation ends | too many concurrent generations |
| `content_filtered` | 200 (terminal event) | no | provider safety block |
| `file_too_large` | 413 | no | |
| `unsupported_file_type` | 415 | no | |
| `file_not_ready` | 409 | yes (poll) | still processing |
| `file_processing_failed` | 422 | no | corrupt/encrypted/unsafe file |
| `generation_timeout` | terminal event | yes (manual retry) | |
| `generation_cancelled` | terminal event | — | user/system cancel |
| `service_busy` | 503 | yes | node at generation capacity |
| `storage_unavailable` | 503 | yes | disk full/unavailable |
| `internal_error` | 500 | maybe | `message` is generic; `trace` only in development |

Errors after a stream has started cannot change the HTTP status: they arrive as a
`generation.failed` SSE event with the same `{code, message, retryable}` and are persisted (§7.1).

---

## 15. Data types & enums

| Concept | Values |
|---|---|
| User role | `user`, `admin`, `auditor` |
| User status | `active`, `disabled` |
| Model status | `active`, `disabled`, `deprecated`, `retired` |
| Conversation (derived) | `modelLocked` boolean |
| Message role | `user`, `assistant` |
| Message status | `streaming`, `complete`, `incomplete`, `failed` |
| Finish reason | `stop`, `length`, `content_filter`, `cancelled`, `error`, `timeout`, `interrupted` |
| Part type | `text`, `image`, `document`, `generated_file`, `structured` (reserved: `tool_call`, `tool_result`, `reasoning`) |
| Generation status | `pending`, `generating`, `completed`, `cancelled`, `failed` |
| Attachment status | `uploading`, `validating`, `processing`, `ready`, `rejected`, `failed`, `missing`, `expired`, `deleted` |
| File availability (wire) | `available`, `processing`, `expired`, `missing` |
| Usage source | `provider`, `estimated` |
| Outcome | `completed`, `cancelled`, `failed` |

---

## 16. Rate limits

| Scope | Default |
|---|---|
| Per IP (unauthenticated + auth endpoints) | 60 req/min; login **10 req/min** |
| Per user — general API | 300 req/min |
| Per user — `POST …/messages` | 20/min (plus the concurrency limit) |
| Per user — uploads | 30/min, 100 MB/10 min |
| Per provider — concurrent upstream calls | configured per provider |

Responses include `Retry-After` and `RateLimit-*` headers. Account lockout (8 failures / 15 min) is
separate from the per-IP limit.

---

## 17. Compatibility & deployment (unversioned API)

- There is **no API version segment**; the SPA contract lives under `/api`. The backend and the SPA
  are a single, continuously deployed product served from the same origin, so the prefix carries no
  version.
- **Additive changes are always allowed**: new response fields and new SSE events may appear at any
  time. Clients **must ignore unknown fields and unknown SSE events**.
- **Breaking changes** (renaming/removing a field, changing a status value, changing an error `code`)
  are only permitted as part of an **atomic SPA + API deploy** from the same release, because there is
  no version boundary to straddle the change. See PRD §24.8 (environments) and §24.7 (rollback).
- Model capabilities are normalized — clients must not branch on provider identity.
- Error `code` values (§14) are treated as a stable, additive-only vocabulary; new codes may be added,
  existing ones are not renamed.
