# API Contracts — Internal Office AI Chat Platform

| | |
|---|---|
| **Document status** | v1.3 |
| **Date** | 2026-10-08 |
| **Base URL** | `/api` (e.g. `https://ai.corp.example/api`). Ops endpoints are served at the root (`/healthz`, `/readyz`). |
| **Transport** | HTTPS · JSON (`application/json`) · SSE (`text/event-stream`) for generation streams |

This file is the contract between the backend and the SPA. It is authoritative for **wire shapes**
and runtime request/response behavior.

**v1.3 changes:** every JSON response is wrapped in a uniform envelope (§1.1/§1.2); the API is
**unversioned** — paths use the `/api` prefix with no version segment (§17); errors always carry a
stable `code`; `trace` is included **only when `NODE_ENV=development`**.

**v1.1 changes:** authentication is email + password with a server-backed session cookie (no OIDC);
new `password_change_required` gate/error; new `POST /me/password` and
`POST /admin/users/:id/password/reset`; provider API keys are **not** part of the API (configured via
environment variables).

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
- **Provider secrets** are never accepted or returned by any endpoint (configured exclusively via server environment variables).
- **Envelope exemptions (raw bodies):** `GET /api/files/:id/content` (binary + `Range`), SSE frames
  (§7.2), `/healthz`, `/readyz`. Everything else uses the envelope.

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
| `Cache-Control` | string, literal `no-store` | always on `/api` JSON | JSON API responses are never cacheable. Overridden on `GET /api/files/:id/content` → `private, no-store` (§8.4). |
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
| `Access-Control-Expose-Headers` | string, literal `X-Request-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After` | origin allowed | Headers the SPA may read from JS. |
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

Authenticates a user with email and password, creates a server-backed session, and returns user info with a CSRF token.

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `email` | string (`citext`) | Yes | User's registered login email address. |
| `password` | string | Yes | User's cleartext password. |

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

Destroys the current session. Requires no request body or parameters.
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

Updates the authenticated user's password, clears the forced-change requirement, revokes other sessions, and rotates the current session.

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `currentPassword` | string | Yes | User's current active password. |
| `newPassword` | string | Yes | Replacement password meeting security policy (min length 12). |

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

### 2.5 `GET /api/auth/csrf` — user

Returns a fresh stateless CSRF token for the authenticated session without reloading profile data.

```json
{ "status": "ok", "message": "", "data": { "csrfToken": "0fT2….9c1a…" } }
```

---

## 3. Me

### 3.1 `GET /api/me`

Returns the profile and account status of the currently authenticated user, along with a fresh CSRF token. Requires no request parameters.

```json
{ "status": "ok", "message": "", "data": {
    "id": "0192…", "email": "ada@corp.example", "displayName": "Ada L.",
    "role": "user", "status": "active", "divisionId": "0192…",
    "mustChangePassword": false, "createdAt": "2026-01-02T10:00:00Z",
    "csrfToken": "0fT2….9c1a…" } }
```

### 3.2 `GET /api/me/quota`

Returns the current billing period's quota allocation, token consumption, reservations, and request limits for the authenticated user. Requires no request parameters.

```json
{ "status": "ok", "message": "", "data": {
    "period": { "start": "2026-10-01T00:00:00+07:00", "end": "2026-11-01T00:00:00+07:00" },
    "limitTokens": 500000, "usedTokens": 20000, "reservedTokens": 24310, "remainingTokens": 455690,
    "limits": { "maxInputTokensPerRequest": 100000, "maxOutputTokensPerRequest": 8000,
                "maxConcurrentGenerations": 2 } } }
```
The period is the calendar month in the configured quota timezone (default `Asia/Jakarta`); instants
are serialized as UTC or with an explicit offset. Use `period.start` for a localized "resets on" label.

### 3.3 `GET /api/me/usage`

Returns aggregated token usage statistics and estimated cost breakdown for the authenticated user across a specified date range.

**Query parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `from` | string (ISO-8601 date / timestamp) | No | Start of usage date range (inclusive). |
| `to` | string (ISO-8601 date / timestamp) | No | End of usage date range (inclusive). |
| `groupBy` | string (`day` \| `model`) | No | Grouping dimension for aggregate usage data (default `day`). |

```json
{ "status": "ok", "message": "", "data": { "items": [
    { "key": { "day": "2026-10-07" }, "requests": 31, "failedRequests": 1,
      "inputTokens": 182340, "outputTokens": 20114, "quotaTokens": 202454,
      "estimatedCostUsd": 0.91 } ] } }
```

---

## 4. Models

### 4.1 `GET /api/models`

Returns only active models the caller may use on enabled providers. Requires no request parameters.

```json
{ "status": "ok", "message": "", "data": { "items": [
    { "id": "0192…", "displayName": "Claude (Sonnet class)", "providerLabel": "Anthropic",
      "status": "active",
      "capabilities": { "streaming": true, "vision": true, "documents": { "pdf": true },
                        "imageGeneration": false, "documentGeneration": false,
                        "contextWindow": 200000, "maxOutputTokens": 8192 },
      "limits": { "maxFilesPerMessage": 5, "maxImagesPerMessage": 10 } } ] } }
```

`status`: `active | disabled`.

---

## 5. Conversations

### 5.1 `POST /api/conversations`

Creates a new conversation thread bound to a specific model.

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `modelId` | string (UUIDv7) | Yes | Target AI model identifier. |
| `title` | string \| null | No | Optional conversation title (defaults to `"New conversation"` if null/omitted). |

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

### 5.2 `GET /api/conversations`

Lists conversation threads owned by the authenticated user with cursor-based pagination.

**Query parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `limit` | integer | No | Maximum number of conversations to return per page (default `50`, max `100`). |
| `cursor` | string | No | Opaque pagination cursor string (`nextCursor` value from previous page). |

```json
{ "status": "ok", "message": "", "data": {
    "items": [ { "id": "…", "title": "…", "modelId": "…", "messageCount": 14,
                 "lastMessageAt": "…", "createdAt": "…" } ],
    "nextCursor": "01J…" } }
```

### 5.3 `GET /api/conversations/:id`

Retrieves details and status of a specific conversation thread by ID.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Unique ID of the target conversation. |

Conversation detail (same shape as 5.1 plus `messageCount`, `lastMessageAt`) inside `data`.
`404` for another user's conversation (never `403`).

### 5.4 `PATCH /api/conversations/:id`

Updates the title of an existing conversation thread.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Conversation ID. |

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `title` | string | Yes | Updated title for the conversation. |

```json
{ "title": "Contract review" }
```
`200` with the updated conversation inside `data`. Only the title is mutable.

### 5.5 `DELETE /api/conversations/:id`

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Conversation ID to soft-delete. |

```json
{ "status": "ok", "message": "Conversation deleted." }
```
`200` (no `data`). Soft-delete. Messages/parts/files become inaccessible (`404` on later reads) and are
purged after the retention window.

---

## 6. Messages & sending

### 6.1 `GET /api/conversations/:id/messages`

Lists messages and message parts for a conversation thread with backward sequence pagination (`before`).

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Conversation ID. |

**Query parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `limit` | integer | No | Maximum number of messages to return per page (default `50`, max `100`). |
| `before` | integer (bigint) | No | Monotonic sequence number (`seq`). Returns messages with sequence number strictly less than (`<`) `before`. |

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

Submits a new user message turn, reserves quota tokens, and queues assistant generation (idempotent via `Idempotency-Key`).

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Conversation ID. |

**Request headers:**
| Header | Value type | Required | Description |
|---|---|---|---|
| `Idempotency-Key` | string (UUIDv7) | Yes | Unique idempotency key. |
| `X-CSRF-Token` | string | Yes | Stateless CSRF verification token. |

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `parts` | array of objects | Yes | Ordered content blocks comprising the user turn. |
| `parts[].type` | string (`text` \| `file`) | Yes | Part type. |
| `parts[].text` | string | Conditional | User prompt text (required when `type="text"`). |
| `parts[].fileId` | string (UUIDv7) | Conditional | Stored attachment ID (required when `type="file"`). |
| `options` | object | No | Generation execution options. |
| `options.maxOutputTokens` | integer | No | Maximum token ceiling requested for output generation. |
| `options.tools` | object | No | Built-in provider tool toggles. |
| `options.tools.imageGeneration` | boolean | No | Request-scoped opt-in to provider-hosted image generation (default `false`). Only honoured when the model declares `capabilities.imageGeneration`; otherwise the request fails `422 unsupported_for_model`. Adds the image-generation token tariff to the quota reservation for that turn. |

> **Document generation stays registry-level; image generation is per request.** Container skills and
> code execution are enabled on the model record (`capabilities.documentGeneration` plus
> `model.config.container` / `model.config.containerSkills`) so a client never has to opt in and cannot
> escalate container cost. Image generation is the exception: it is opt-in per turn because it is
> billed separately from the token stream, and the registry flag only says the model *can* do it.

```json
{
  "parts": [
    { "type": "text", "text": "Analyze the attached CSV and generate an Excel forecast." },
    { "type": "file", "fileId": "0192…" }
  ],
  "options": {
    "maxOutputTokens": 4000,
    "tools": { "imageGeneration": true }
  }
}
```

`202 Accepted`:
```json
{ "status": "ok", "message": "Generation queued.", "data": {
    "userMessage":      { "id": "…", "seq": 12, "role": "user", "status": "complete", "parts": [ … ] },
    "assistantMessage": { "id": "…", "seq": 13, "role": "assistant", "status": "streaming", "parts": [] },
    "generation":       { "id": "…", "status": "pending", "streamUrl": "/api/generations/…/stream" },
    "quota":            { "reservedTokens": 24310, "remainingTokens": 455690 } } }
```

> Note: `quota` may be `null` if the user is unmetered or has no active quota account.

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

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Conversation ID. |
| `mid` | string (UUIDv7) | Yes | Failed/cancelled user message ID to retry generation for. |

**Request headers:**
| Header | Value type | Required | Description |
|---|---|---|---|
| `Idempotency-Key` | string (UUIDv7) | Yes | Unique idempotency key. |
| `X-CSRF-Token` | string | Yes | Stateless CSRF verification token. |

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `options` | object | No | Generation execution options (same structure as §6.2). |

`202` with the same `data` shape as §6.2. Requires `Idempotency-Key`.

---

## 7. Generations & streaming

### 7.1 `GET /api/generations/:id`

Retrieves the current execution status, token usage, and outcome details of a generation job.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Generation job ID. |

```json
{ "status": "ok", "message": "", "data": {
    "id": "…", "conversationId": "…", "status": "completed",
    "finishReason": "stop",
    "usage": null,
    "remainingQuota": null,
    "error": null } }
```
On failure `data.error` is `{ "code": "provider_unavailable", "message": "…", "retryable": true }`.
`finishReason` reflects the completion or cancel reason (`stop`, `user_cancel`, etc.).

### 7.2 `GET /api/generations/:id/stream` (SSE) — **raw, not enveloped**

Opens a Server-Sent Events (SSE) connection to stream generation lifecycle states, text deltas, and part events in real time.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Generation job ID. |

**Request headers:**
| Header | Value type | Required | Description |
|---|---|---|---|
| `Last-Event-ID` | string \| integer | No | Last received SSE event sequence ID to replay missed events after reconnect. |

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
| `part.started` | `{partId, position, type, mimeType?, name?}` | new part (`text \| image \| document \| generated_file`); `position` is monotonic across all part types in the message |
| `text.delta` | `{partId, delta}` | text chunk (coalesced ≤ 20/s) |
| `tool.started` | `{partId, toolCallId, tool, command?}` | tool execution starting (e.g. `bash_code_execution`, `web_search`); `command` is present when the tool input carries one |
| `tool.delta` | `{partId, toolCallId, delta}` | streaming tool output (stdout/stderr) |
| `tool.completed` | `{partId, toolCallId, status}` | tool finished (`success \| error`) |
| `part.completed` | `{partId, status, fileId?, downloadUrl?}` | binary frames (images, generated files) only after ArtifactSink stores the file |
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
does not cancel the generation.

### 7.3 `POST /api/generations/:id/cancel`

Requests cancellation of an ongoing generation job and settles consumed quota.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Generation job ID to cancel. |

Idempotent.
```json
{ "status": "ok", "message": "Cancellation requested." }
```
`202` (no `data`). Aborts the provider call, persists partial text, marks the generation `cancelled`,
and settles/releases quota accordingly.

---

## 8. Attachments & file content

### 8.1 `POST /api/conversations/:id/attachments`

Uploads and validates files (`multipart/form-data`) for use in conversation messages.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Conversation ID to associate attachments with. |

**Request body (`multipart/form-data`):**
| Field | Value type | Required | Description |
|---|---|---|---|
| `files` | file (binary) \| file[] | Yes | Upload files (≤ 5 files per request, cumulative size ≤ 30 MB). |

Rate-limited (§16).

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

Retrieves the processing and validation status of an uploaded attachment.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Attachment ID. |

Status only (`uploading | validating | processing | ready | rejected | failed | expired | deleted`) in `data`.
Poll until `ready` before sending it in a message.

### 8.3 `DELETE /api/attachments/:id`

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Attachment ID (unattached uploads only). |

Deletes an **unattached** upload (reserved / deferred to P1; unattached uploads are purged automatically after 24 hours by the background orphan reaper job).
```json
{ "status": "ok", "message": "Attachment deleted." }
```
`200` (no `data`). Attached files cannot be deleted here.

### 8.4 `GET /api/files/:id/content` — **raw, not enveloped**

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Attachment/File ID. |

**Request headers:**
| Header | Value type | Required | Description |
|---|---|---|---|
| `Range` | string | No | Standard HTTP Range header (e.g. `bytes=0-1023`) for partial content download. |

Streams the blob (uploaded or generated). Owner-only — admins are **not** exempt.
- Validated images: `Content-Disposition: inline`; everything else `attachment`.
- Also: `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox; default-src 'none'`, supports `Range`.
- `404` if not owner, `410`/part `status: expired` if the TTL passed.

---

## 9. Admin — users & divisions

Administrative routes implement a two-tier model:
- **User management (`/api/admin/users*`):** accessible by `super_admin` (system-wide) and `admin` (division administrator). When invoked by a division `admin`, operations are strictly isolated to users within the administrator's assigned division (`caller.division_id`). Attempted access to users outside that division returns **404** (preventing account existence leakage). Division admins can only provision and manage accounts with `role: "user"`.
- **System-level admin (`/api/admin/divisions*`, and sections 10–13):** accessible strictly by `super_admin`.

Every mutation writes an `audit_logs` row in the same transaction.

| Method & path | Role requirement | Description |
|---|---|---|
| `GET /api/admin/users?query&divisionId&status&limit&cursor` | `admin`, `super_admin` | List/search users (`admin` scoped to own division; `super_admin` all) |
| `POST /api/admin/users` | `admin`, `super_admin` | Create/pre-provision user (`admin` in own division with `role=user`; `super_admin` any role/division) |
| `GET /api/admin/users/:id` | `admin`, `super_admin` | Detail (`admin` own division only, 404 otherwise; `super_admin` any) |
| `PATCH /api/admin/users/:id` | `admin`, `super_admin` | Update user (`admin` email/displayName/status in own division; `super_admin` email/role/division/status/profile) |
| `DELETE /api/admin/users/:id` | `admin`, `super_admin` | Soft-delete user (`admin` own division, `role=user` only, 404 otherwise; `super_admin` any) |
| `GET /api/admin/users/import/template` | `admin`, `super_admin` | Download the `email,name,division` CSV template |
| `POST /api/admin/users/import` | `admin`, `super_admin` | Bulk-provision users from CSV or JSON (max 500 rows) |
| `POST /api/admin/users/:id/password/reset` | `admin`, `super_admin` | Reset password (`admin` own division only, 404 otherwise; `super_admin` any) |
| `GET /api/admin/divisions` · `GET /api/admin/divisions/:id` · `POST /api/admin/divisions` · `PATCH /api/admin/divisions/:id` · `DELETE /api/admin/divisions/:id` | `super_admin` | Divisions (list/detail include usage + policy stats; guarded hard delete) |

---

### 9.1 `GET /api/admin/users`

Lists and searches registered users with optional filtering by query, division, or status.
When called by a division `admin`, results are strictly filtered to `division_id = caller.division_id`. Client-provided `divisionId` query parameter targeting any other division is rejected or ignored.

**Query parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `query` | string | No | Search query string matching against user email or display name. |
| `divisionId` | string (UUIDv7) | No | Filter users assigned to a specific division ID (`super_admin` only). |
| `status` | string (`active` \| `disabled`) | No | Filter users by account status. |
| `limit` | integer | No | Maximum number of users to return per page (default `50`, max `100`). |
| `cursor` | string | No | Opaque pagination cursor string (`nextCursor` value from previous page). |

`200`:
```json
{ "status": "ok", "message": "", "data": {
    "items": [
      { "id": "0192…", "email": "ada@corp.example", "displayName": "Ada L.",
        "role": "user", "status": "active", "divisionId": "0192…",
        "mustChangePassword": false, "createdAt": "2026-01-02T10:00:00Z",
        "updatedAt": "2026-10-08T09:00:00Z", "lastLoginAt": "2026-10-08T08:15:00Z" }
    ],
    "nextCursor": "01J…" } }
```

---

### 9.2 `POST /api/admin/users`

Creates and provisions a new user account with specified role, division, and initial or temporary password.
When called by a division `admin`, `divisionId` is automatically forced to `caller.division_id`, and `role` must be `'user'` (setting `admin` or `super_admin` returns `403 forbidden`). When called by `super_admin`, assigning `role='admin'` requires a non-null `divisionId`.

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `email` | string (`citext`) | Yes | User's login email address. |
| `displayName` | string | Yes | User's display name. |
| `role` | string (`user` \| `admin` \| `super_admin`) | Yes | Role assigned to user (`super_admin` may set any role; division `admin` may only set `user`). |
| `divisionId` | string \| null (UUIDv7) | Conditional | Division ID to assign user to (mandatory if `role='admin'`; forced to `caller.division_id` for division `admin`). |
| `generatePassword` | boolean | No | If `true`, system auto-generates temporary password returned in `data.temporaryPassword`. |
| `password` | string | Conditional | Initial password (required if `generatePassword` is `false` or omitted). |

Request:
```json
{ "email": "new@corp.example", "displayName": "New Hire",
  "role": "user", "divisionId": "0192…", "generatePassword": true }
```
`201`:
```json
{ "status": "ok", "message": "User created.", "data": {
    "id": "…", "email": "new@corp.example", "displayName": "New Hire",
    "role": "user", "status": "active", "divisionId": "0192…",
    "mustChangePassword": true, "createdAt": "2026-10-08T10:00:00Z",
    "updatedAt": "2026-10-08T10:00:00Z", "lastLoginAt": null,
    "temporaryPassword": "Kx7-…" } }
```
`temporaryPassword` is returned **only** when `generatePassword: true` and only in this response; it is
never stored in plaintext.

---

### 9.3 `GET /api/admin/users/:id`

Retrieves account details and profile information for a specific user.
When called by a division `admin`, returns **404** if the target user belongs to a different division, has no division, or has a role other than `'user'` (unless inspecting their own account).

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Target user ID. |

`200`:
```json
{ "status": "ok", "message": "", "data": {
    "id": "0192…", "email": "ada@corp.example", "displayName": "Ada L.",
    "role": "user", "status": "active", "divisionId": "0192…",
    "mustChangePassword": false, "createdAt": "2026-01-02T10:00:00Z",
    "updatedAt": "2026-10-08T09:00:00Z", "lastLoginAt": "2026-10-08T08:15:00Z" } }
```
The admin projection never exposes password hashes, `failedLoginAttempts`, or `lockedUntil`.

---

### 9.4 `PATCH /api/admin/users/:id`

Updates profile attributes (including the login email), role, division assignment, or account status for a user.
When called by a division `admin`:
- Returns **404** if target user is in a different division, unassigned, or has a role other than `'user'` (unless updating their own display name).
- Can only update `email`, `displayName` and `status` (`active` | `disabled`). Supplying `role` or `divisionId` returns `403 forbidden`.
- Cannot disable their own administrator account (`403 forbidden`).

When called by `super_admin`:
- Can update `email`, `displayName`, `role`, `divisionId`, `status`.
- Cannot disable or demote the last active `super_admin` (`409 conflict`).
- Setting `role='admin'` requires a non-null `divisionId`.

Changing `email` rewrites the login identifier; the uniqueness check is case-insensitive (`citext`) and collides with any live account (`409 conflict`). Existing sessions stay valid because they are keyed by user ID, not email.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Target user ID. |

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `email` | string (`citext`) | No | Updated login email address (unique across live accounts). |
| `displayName` | string | No | Updated display name. |
| `role` | string (`user` \| `admin` \| `super_admin`) | No | Updated user role (`super_admin` only). |
| `divisionId` | string \| null (UUIDv7) | No | Updated division ID (`super_admin` only; `null` to unassign). |
| `status` | string (`active` \| `disabled`) | No | Updated status (`disabled` revokes all active sessions immediately). |

Request:
```json
{ "email": "ada.lovelace@corp.example", "displayName": "Ada Lovelace", "role": "super_admin" }
```
`200`:
```json
{ "status": "ok", "message": "User updated.", "data": {
    "id": "0192…", "email": "ada@corp.example", "displayName": "Ada Lovelace",
    "role": "super_admin", "status": "active", "divisionId": "0192…",
    "mustChangePassword": false, "createdAt": "2026-01-02T10:00:00Z",
    "updatedAt": "2026-10-08T09:30:00Z", "lastLoginAt": "2026-10-08T08:15:00Z" } }
```

Safeguards: cannot disable/demote the last active `super_admin` (`409 conflict`); a duplicate `email` returns `409 conflict`.

---

### 9.5 `POST /api/admin/users/:id/password/reset`

Resets a user's password, revokes all active sessions, and forces a password update upon next login.
When called by a division `admin`, returns **404** if the target user belongs to a different division, has no division, or has a role other than `'user'`.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Target user ID. |

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `generatePassword` | boolean | No | If `true`, system generates a temporary password. |
| `newPassword` | string | Conditional | Specified replacement password (required if `generatePassword` is `false` or omitted). |
| `reason` | string | No | Operational justification string logged to audit trail. |

Request:
```json
{ "generatePassword": true, "reason": "User forgot password (ticket #4821)" }
```
`200` → `{ "status": "ok", "message": "Password reset.", "data": { "temporaryPassword": "Kx7-…" } }`
(or `200` with **no `data`** if a `newPassword` was supplied).
Side effects: revokes **all** the user's sessions, sets `mustChangePassword`.

---

### 9.6 `GET /api/admin/divisions`

Lists all organizational divisions with a per-division read model: member count, token usage and
estimated cost over a reporting window, plus the division's monthly quota policy. Requires
`role=super_admin`. This single request replaces a list + `/api/admin/usage` join on the client.

**Query parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `days` | integer (1–365) | No | Length of the usage window ending today, inclusive (default `30`). |

The window is `[today - (days - 1), today]` in **UTC** calendar days, matching the `usage_daily`
buckets.

`200`:
```json
{ "status": "ok", "message": "", "data": {
    "items": [
      { "id": "0192…", "name": "Engineering", "externalRef": "grp_eng_01",
        "createdAt": "2026-01-01T00:00:00Z",
        "memberCount": 12, "tokens": 1843211, "requests": 842,
        "costUsd": 41.27, "monthlyTokens": 5000000 },
      { "id": "0192…", "name": "Legal", "externalRef": "grp_legal_02",
        "createdAt": "2026-01-01T00:00:00Z",
        "memberCount": 0, "tokens": 0, "requests": 0,
        "costUsd": null, "monthlyTokens": null }
    ] } }
```

Field notes:
- `memberCount` counts live users (`deleted_at IS NULL`) assigned to the division.
- `tokens`, `requests`, `costUsd` aggregate `usage_daily` over the window. `costUsd` is `null` when
  no settled row carries a cost estimate (never `0`, which would be a false cost).
- `monthlyTokens` is the division-scope quota policy limit; `null` means the division inherits the
  global limit.
- Items are ordered by `name` ascending.

---

### 9.7 `GET /api/admin/divisions/:id`

Returns the same enriched shape as one §9.6 item for a single division. Requires `role=super_admin`.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Target division ID. |

**Query parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `days` | integer (1–365) | No | Usage window length (default `30`), same UTC semantics as §9.6. |

`200`:
```json
{ "status": "ok", "message": "", "data": {
    "id": "0192…", "name": "Engineering", "externalRef": "grp_eng_01",
    "createdAt": "2026-01-01T00:00:00Z",
    "memberCount": 12, "tokens": 1843211, "requests": 842,
    "costUsd": 41.27, "monthlyTokens": 5000000 } }
```
`404 not_found` when the division does not exist.

---

### 9.8 `POST /api/admin/divisions`

Creates a new organizational division for quota and model access management. Requires `role=super_admin`.

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Unique display name for the division. |
| `externalRef` | string \| null | No | External reference identifier (e.g. HR/AD group reference). |

Request:
```json
{ "name": "Finance", "externalRef": "grp_fin_03" }
```
`201`:
```json
{ "status": "ok", "message": "Division created.", "data": {
    "id": "0192…", "name": "Finance", "externalRef": "grp_fin_03", "createdAt": "2026-10-08T10:00:00Z" } }
```

---

### 9.9 `PATCH /api/admin/divisions/:id`

Updates the display name or external reference of an existing division. Requires `role=super_admin`.
Returns the core division shape (no usage stats).

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Target division ID. |

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `name` | string | No | Updated division display name. |
| `externalRef` | string \| null | No | Updated external reference ID. |

Request:
```json
{ "name": "Finance & Accounting" }
```
`200`:
```json
{ "status": "ok", "message": "Division updated.", "data": {
    "id": "0192…", "name": "Finance & Accounting", "externalRef": "grp_fin_03", "createdAt": "2026-10-08T10:00:00Z" } }
```

---

### 9.10 `DELETE /api/admin/divisions/:id`

Deletes an existing organizational division. Requires `role=super_admin`.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Target division ID. |

**Safeguard:** Hard delete is guarded. If any `users` (assigned members), `quota_policies` (division-level
overrides), or `usage_events`/`usage_daily` (historical consumption) rows still reference this division, the
operation is rejected with `409 conflict` listing the blocking references (e.g. `"Division cannot be
deleted: it still has 3 users, 1 quota policy."`). Members must be reassigned and any policy removed before
the division can be deleted.

`200`:
```json
{ "status": "ok", "message": "Division deleted." }
```
(empty envelope). `404 not_found` if the division does not exist. Writes an `audit_logs` row (`action: "division.delete"`).

---

### 9.11 `GET /api/admin/users/import/template`

Downloads the CSV template accepted by §9.12 (UTF-8 with BOM, header `email,name,division`).
Requires `role=admin` or `role=super_admin`.

**Response:** `200`, `Content-Type: text/csv; charset=utf-8`,
`Content-Disposition: attachment; filename="template_registrasi_pengguna.csv"`.

---

### 9.12 `POST /api/admin/users/import`

Bulk-provisions users at `role='user'` with `status='active'` and `mustChangePassword=true`. Accepts either
a `multipart/form-data` upload in the `file` part or a JSON body. Both variants share the same limits:
at most **500 rows** per request.

A division `admin` must belong to a division; every created user is forced into `caller.division_id` and a
`division` column naming any other division is reported as a row error. `super_admin` may assign the
`division` column, matched case-insensitively against `divisions.external_ref`.

**Request body (JSON):**
| Field | Value type | Required | Description |
|---|---|---|---|
| `rows` | array of objects | Yes | 1–500 rows. |
| `rows[].email` | string (`citext`) | Yes | Login email; must be a valid address and not already live. |
| `rows[].name` | string | Yes | Display name. |
| `rows[].division` | string | No | Division `external_ref`. |

**Request body (multipart):** a single `file` part (max 1 MB) containing a CSV whose header includes
`email` and `name` (order-free, case-insensitive, `,` or `;` delimited) and an optional `division` column.

`200`:
```json
{ "status": "ok", "message": "Bulk registration processed.", "data": {
    "summary": { "total": 3, "created": 2, "skipped": 1 },
    "temporaryPassword": "Kx7-…",
    "createdUsers": [
      { "id": "0192…", "email": "a@corp.example", "displayName": "A",
        "divisionId": "0192…", "divisionExternalRef": "ENG-01" }
    ],
    "errors": [
      { "row": 4, "email": "b@corp.example", "reason": "Email sudah terdaftar di sistem." }
    ] } }
```
- `row` is the physical line in the uploaded CSV (header included) or the 1-based row index plus one for JSON.
- `temporaryPassword` is the single password shared by every account created in the batch. It is returned
  **only** in this response and is never stored in plaintext; each account must change it at first login.
- Creation is atomic per row: a failing row is skipped and reported, the remaining rows still commit.
- `400 invalid_request` for an unreadable/oversized CSV, a missing `email`/`name` header, more than 500 rows,
  or rows with an invalid email or name. The message lists the offending row numbers.
- `403 forbidden` when a division `admin` has no division.

---

### 9.13 `DELETE /api/admin/users/:id`

Soft-deletes a user: sets `deleted_at`, forces `status='disabled'`, and revokes every active session.
Writes an `audit_logs` row (`action: "user.delete"`).

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Target user ID. |

When called by a division `admin`, returns **404** if the target is outside the caller's division or has a
role other than `'user'`. Deleting your own administrator account returns `403 forbidden`. Deleting the last
active `super_admin` returns `409 conflict`.

`200` → `{ "status": "ok", "message": "User deleted." }` (empty envelope). `404 not_found` for an unknown or
already-deleted user. The email is released for re-registration because `users_email_live_uq` only covers
live rows.

---

## 10. Admin — quota & usage

All quota and usage administration endpoints require `role=super_admin`.

### 10.1 `GET /api/admin/quota-policies/:scope/:id?`

Retrieves the quota policy definition for a specific scope (`global`, `division`, or `user`).

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `scope` | string (`global` \| `division` \| `user`) | Yes | Policy target scope. |
| `id` | string (UUIDv7) | Conditional | Target Division ID (when `scope="division"`) or User ID (when `scope="user"`). Omitted when `scope="global"`. |

`scope` ∈ `global | division | user`. Returns the raw policy row (nullable fields inherit) in `data`.

`200`:
```json
{ "status": "ok", "message": "", "data": {
    "id": "0192…", "scope": "division", "divisionId": "0192…", "userId": null,
    "monthlyTokens": 1000000, "maxInputTokensPerRequest": 150000,
    "maxOutputTokensPerRequest": 16000, "maxConcurrentGenerations": 3,
    "allowedModelIds": null, "updatedBy": "0192…", "updatedAt": "2026-10-08T09:00:00Z" } }
```

### 10.2 `PUT /api/admin/quota-policies/:scope/:id?`

Creates or updates a quota policy at the specified scope (`global`, `division`, or `user`), with optional immediate adjustment to active accounts.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `scope` | string (`global` \| `division` \| `user`) | Yes | Policy target scope. |
| `id` | string (UUIDv7) | Conditional | Target Division ID or User ID (omitted for `global`). |

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `monthlyTokens` | integer \| null (bigint) | No | Monthly token limit (`null` inherits from higher scope). |
| `maxInputTokensPerRequest` | integer \| null | No | Maximum input tokens per request (`null` inherits). |
| `maxOutputTokensPerRequest` | integer \| null | No | Maximum output tokens per request (`null` inherits). |
| `maxConcurrentGenerations` | integer \| null | No | Maximum concurrent generations per user (`null` inherits). |
| `allowedModelIds` | array of string (UUIDv7) \| null | No | List of allowed model IDs (`null` inherits). |
| `applyToCurrentPeriod` | boolean | No | If `true`, immediately recalculates and adjusts current period quota balances via ledger entry (default `true`). |
| `reason` | string | No | Audit update justification string. |

```json
{ "monthlyTokens": 1000000, "maxInputTokensPerRequest": 150000,
  "maxOutputTokensPerRequest": 16000, "maxConcurrentGenerations": 3,
  "applyToCurrentPeriod": true, "reason": "Legal team pilot" }
```
`null` fields inherit from division/global. `applyToCurrentPeriod: true` re-resolves and adjusts the
current `quota_accounts` row via a ledger `adjust` entry. Returns the updated policy in `data`.

`200`:
```json
{ "status": "ok", "message": "Quota policy updated.", "data": {
    "id": "0192…", "scope": "user", "divisionId": null, "userId": "0192…",
    "monthlyTokens": 1000000, "maxInputTokensPerRequest": 150000,
    "maxOutputTokensPerRequest": 16000, "maxConcurrentGenerations": 3,
    "allowedModelIds": null, "updatedBy": "0192…", "updatedAt": "2026-10-08T09:30:00Z" } }
```

### 10.3 `POST /api/admin/users/:id/quota/adjustments`

Applies an immediate manual token quota adjustment (grant or deduction) to a user's current account balance with audit justification.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Target user ID. |

**Request body:**
| Field | Value type | Required | Description |
|---|---|---|---|
| `tokens` | integer (bigint) | Yes | Token adjustment amount (positive to grant, negative to claw back). |
| `reason` | string | Yes | Reason for adjustment logged to quota ledger and audit log. |
| `expiresAtPeriodEnd` | boolean | No | Whether adjustment applies only to current period (default `true`). |

```json
{ "tokens": 200000, "reason": "Incident follow-up", "expiresAtPeriodEnd": true }
```
Positive = grant, negative = claw back. Writes a ledger row (never edits history) + audit.
`200` → `{ "status": "ok", "message": "Adjustment applied.", "data": { "entryType": "adjust", "tokensDelta": 200000 } }`.

### 10.4 `GET /api/admin/users/:id/quota`

Retrieves a user's current quota balance, active reservations, and recent ledger transaction history.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Target user ID. |

Current period counters plus the recent ledger:
```json
{ "status": "ok", "message": "", "data": {
    "period": { "start": "…", "end": "…" },
    "limitTokens": 1000000, "usedTokens": 123456, "reservedTokens": 0, "remainingTokens": 876544,
    "limits": { "maxInputTokensPerRequest": 150000, "maxOutputTokensPerRequest": 16000,
                "maxConcurrentGenerations": 3 },
    "ledger": [ { "entryType": "settle", "tokensDelta": 12400, "reason": null,
                  "createdAt": "…", "requestId": "…" } ] } }
```
`limits` is the effective per-request policy resolved for the user. `ledger` returns the 50 most
recent rows, newest first, and never edits history.

### 10.5 `GET /api/admin/usage`

Retrieves system-wide token usage statistics, token volumes, and estimated costs grouped by user, model, provider, division, or time period.

**Query parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `from` | string (ISO-8601 date / timestamp) | No | Start date/timestamp for usage report range. |
| `to` | string (ISO-8601 date / timestamp) | No | End date/timestamp for usage report range. |
| `groupBy` | string (`user` \| `model` \| `provider` \| `day` \| `month` \| `division`) | No | Dimension to aggregate usage statistics by (default `day`). |
| `divisionId` | string (UUIDv7) | No | Restricts the aggregate to one division, in any `groupBy` mode (used by the department detail screen). |

```json
{ "status": "ok", "message": "", "data": { "items": [
    { "key": { "modelId": "…", "displayName": "…", "provider": "anthropic" },
      "requests": 1523, "failedRequests": 12,
      "inputTokens": 8123412, "outputTokens": 912331, "quotaTokens": 9035743,
      "estimatedCostUsd": 41.27,
      "usageSource": { "provider": 0.998, "estimated": 0.002 } } ] } }
```

`key` always contains the grouping column (`userId`, `modelId`, `providerId`, `divisionId`, `day`,
or `month`) plus resolved labels where they exist (`email`, `displayName`, `modelKey`, `provider`,
`providerKey`, `name`). Aggregates come from the `usage_daily` rollup, so they survive a conversation purge;
today's rows may lag by up to one incremental rollup window (5 minutes).

Ordering: `groupBy=user` and `groupBy=division` are sorted by `quotaTokens` **descending** (ties
broken by the dimension value) so the heaviest consumers come first; the other dimensions are
sorted ascending by their key.

`usageSource` is the share of settled generations whose token counts came from the provider
(`provider`) versus a local estimate (`estimated`); the two add up to `1`.

### 10.6 `GET /api/admin/usage/export`

The same aggregate as §10.5, as a downloadable file. Accepts the identical query parameters —
including `divisionId` — and the same `super_admin` requirement.

- **Response:** `200`, `Content-Type: text/csv; charset=utf-8`,
  `Content-Disposition: attachment; filename="usage-<groupBy>-<YYYY-MM-DD>.csv"`, `Cache-Control: no-store`.
- **Body:** RFC 4180 CSV, `CRLF` line endings, header row first. Columns are the grouping columns in
  alphabetical order, then `requests`, `failedRequests`, `inputTokens`, `outputTokens`,
  `quotaTokens`, `estimatedCostUsd`, `usageSourceProvider`, `usageSourceEstimated`.
- Numbers are unquoted; text cells are quoted only when they contain `,`, `"`, CR, or LF. A missing
  `estimatedCostUsd` is an empty cell (never `0`, which would be a false cost).

---

## 11. Admin — providers & models

All provider and model administration endpoints require `role=super_admin`.

### 11.1 Providers (`GET /api/admin/providers`, `POST /api/admin/providers`, `PATCH /api/admin/providers/:id`)

Provider registry. **The API key is never accepted or returned** — `secretRef` is the **name of the
environment variable** that holds it.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Conditional | Target provider ID (required for `PATCH`). |

**Request body (`POST` / `PATCH`):**
| Field | Value type | Required | Description |
|---|---|---|---|
| `key` | string | Conditional | Unique internal provider key (e.g. `anthropic`, `openai`) (required on `POST`). |
| `displayName` | string | Conditional | Human-readable provider label (required on `POST`, optional on `PATCH`). |
| `adapter` | string | Conditional | Registered PAL adapter key (`anthropic`, `openai`, `gemini`) (required on `POST`). |
| `baseUrl` | string \| null | No | Custom provider API base URL override. |
| `secretRef` | string | Conditional | Environment variable name holding the provider API key (required on `POST`, optional on `PATCH`). |
| `status` | string (`active` \| `disabled`) | No | Provider operational status (default `active`). |
| `config` | object | No | Adapter-specific JSON configuration object (e.g. `maxConcurrency`, `connectTimeoutMs`). |

`PATCH /api/admin/providers/:id`:
```json
{ "displayName": "Anthropic", "secretRef": "ANTHROPIC_API_KEY", "status": "active",
  "config": { "maxConcurrency": 8, "connectTimeoutMs": 10000 } }
```
`POST /api/admin/providers` (`201`):
```json
{ "status": "ok", "message": "Provider created.", "data": {
    "id": "0192…", "key": "anthropic", "displayName": "Anthropic", "adapter": "anthropic",
    "baseUrl": null, "secretRef": "ANTHROPIC_API_KEY", "status": "active",
    "config": { "maxConcurrency": 8, "connectTimeoutMs": 10000 }, "configVersion": 1,
    "createdAt": "2026-10-08T10:00:00Z", "updatedAt": "2026-10-08T10:00:00Z" } }
```
`GET` list response (`200`):
```json
{ "status": "ok", "message": "", "data": { "items": [
    { "id": "0192…", "key": "anthropic", "displayName": "Anthropic", "adapter": "anthropic",
      "baseUrl": null, "secretRef": "ANTHROPIC_API_KEY", "status": "active",
      "config": { "maxConcurrency": 8 }, "configVersion": 4, "updatedAt": "2026-10-08T09:00:00Z" }
] } }
```
`PATCH /api/admin/providers/:id` response (`200`):
```json
{ "status": "ok", "message": "", "data": {
    "id": "0192…", "key": "anthropic", "displayName": "Anthropic", "adapter": "anthropic",
    "baseUrl": null, "secretRef": "ANTHROPIC_API_KEY", "status": "active",
    "config": { "maxConcurrency": 8 }, "configVersion": 4, "updatedAt": "2026-10-08T09:00:00Z" } }
```
> Rotating the actual key is an operator action: update the env/`.env` file and restart the process
> (rolling restart).

### 11.2 Models (`GET /api/admin/models`, `POST /api/admin/models`, `PATCH /api/admin/models/:id`)

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Conditional | Target model ID (required for `PATCH`). |

**Request body (`POST` / `PATCH`):**
| Field | Value type | Required | Description |
|---|---|---|---|
| `providerId` | string (UUIDv7) | Conditional | Associated provider ID (required on `POST`). |
| `key` | string | Conditional | Unique internal model slug (required on `POST`). |
| `apiModelId` | string | Conditional | Upstream provider model API identifier (e.g. `claude-3-5-sonnet-20241022`) (required on `POST`). |
| `displayName` | string | Conditional | Model display label (required on `POST`, optional on `PATCH`). |
| `description` | string \| null | No | Human-readable model description. |
| `status` | string (`active` \| `disabled`) | No | Model status (default `disabled`). |
| `capabilities` | object | Conditional | Normalized capability flags object (required on `POST`, optional on `PATCH`). |
| `contextWindow` | integer | Conditional | Context window token capacity (> 0) (required on `POST`, optional on `PATCH`). |
| `maxOutputTokens` | integer | Conditional | Maximum supported output tokens (> 0) (required on `POST`, optional on `PATCH`). |
| `defaultMaxOutputTokens` | integer | Conditional | Default max output tokens (required on `POST`, optional on `PATCH`). |
| `quotaWeight` | number (float) | No | Quota token multiplier weight (default `1.0`). |
| `config` | object | No | Execution configuration object (e.g. `timeoutMs`, reasoning effort). |

**Provider-hosted tool keys inside `config`:**

| Key | Scope | Meaning |
|---|---|---|
| `container` | model | Force the provider container path on even when `capabilities.documentGeneration` is `false`. |
| `containerSkills` | model | Skills to declare on the container (`["pdf","docx","xlsx","pptx"]`); defaults to all four. |
| `imageGeneration` | model | `false` opts a model out of the `image_generation` tool even when the capability flag is on. |
| `imageGenerationOptions` | model | Forwarded provider knobs for the image tool (`output_format` and other allow-listed keys); unknown keys are dropped. |
| `storeResponses` | model | `true` asks OpenAI to retain the Responses object (default `false`). |
| `useChatCompletions` | provider | `true` forces Chat Completions, disabling containers and hosted image generation for that provider. |
| `sortOrder` | integer | No | Display sorting priority index (default `0`). |

```json
{ "status": "disabled",
  "capabilities": { "streaming": true, "vision": true, "documents": { "pdf": true },
                    "contextWindow": 200000, "maxOutputTokens": 8192, "schemaVersion": 1 },
  "defaultMaxOutputTokens": 4096, "quotaWeight": 1.0,
  "config": { "timeoutMs": 180000 } }
```

`POST /api/admin/models` (`201`):
```json
{ "status": "ok", "message": "Model created.", "data": {
    "id": "0192…", "providerId": "0192…", "key": "claude-sonnet-3-5",
    "apiModelId": "claude-3-5-sonnet-20241022", "displayName": "Claude 3.5 Sonnet",
    "description": "High intelligence, fast multimodal model", "status": "disabled",
    "capabilities": { "streaming": true, "vision": true, "documents": { "pdf": true },
                      "contextWindow": 200000, "maxOutputTokens": 8192, "schemaVersion": 1 },
    "contextWindow": 200000, "maxOutputTokens": 8192, "defaultMaxOutputTokens": 4096,
    "quotaWeight": 1.0, "config": { "timeoutMs": 180000 }, "sortOrder": 1,
    "createdAt": "2026-10-08T10:00:00Z", "updatedAt": "2026-10-08T10:00:00Z" } }
```

`GET /api/admin/models` (`200`):
```json
{ "status": "ok", "message": "", "data": {
    "items": [
      { "id": "0192…", "providerId": "0192…", "key": "claude-sonnet-3-5",
        "apiModelId": "claude-3-5-sonnet-20241022", "displayName": "Claude 3.5 Sonnet",
        "status": "active", "capabilities": { "streaming": true, "vision": true, "documents": { "pdf": true },
                                              "contextWindow": 200000, "maxOutputTokens": 8192, "schemaVersion": 1 },
        "contextWindow": 200000, "maxOutputTokens": 8192, "defaultMaxOutputTokens": 4096,
        "quotaWeight": 1.0, "sortOrder": 1 }
    ] } }
```

`PATCH /api/admin/models/:id` (`200`):
```json
{ "status": "ok", "message": "Model updated.", "data": {
    "id": "0192…", "providerId": "0192…", "key": "claude-sonnet-3-5",
    "status": "disabled", "updatedAt": "2026-10-08T10:30:00Z" } }
```

### 11.3 Model Prices (`GET /api/admin/models/:id/prices`, `POST /api/admin/models/:id/prices`)

Effective-dated token pricing for models used in cost reporting. Requires `role=super_admin`.

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Target model ID. |

**Request body (`POST`):**
| Field | Value type | Required | Description |
|---|---|---|---|
| `effectiveFrom` | string (ISO-8601 datetime) | No | When this price becomes active (defaults to current time). |
| `inputMicrosPerMtok` | integer | Yes | Cost in USD micro-cents ($0.000001) per 1M input tokens. |
| `outputMicrosPerMtok` | integer | Yes | Cost in USD micro-cents per 1M output tokens. |
| `cachedInputMicrosPerMtok` | integer \| null | No | Cost for cached prompt tokens per 1M tokens. |
| `currency` | string | No | 3-letter currency code (default `"USD"`). |

`POST /api/admin/models/:id/prices` (`201`):
```json
{ "status": "ok", "message": "Price recorded.", "data": {
    "id": "0192…", "modelId": "0192…", "effectiveFrom": "2026-10-08T10:00:00Z",
    "inputMicrosPerMtok": 3000000, "outputMicrosPerMtok": 15000000,
    "cachedInputMicrosPerMtok": 375000, "currency": "USD", "createdAt": "2026-10-08T10:00:00Z" } }
```

`GET /api/admin/models/:id/prices` (`200`):
```json
{ "status": "ok", "message": "", "data": {
    "items": [
      { "id": "0192…", "modelId": "0192…", "effectiveFrom": "2026-10-08T10:00:00Z",
        "inputMicrosPerMtok": 3000000, "outputMicrosPerMtok": 15000000,
        "cachedInputMicrosPerMtok": 375000, "currency": "USD", "createdAt": "2026-10-08T10:00:00Z" }
    ] } }
```

### 11.4 `GET /api/admin/providers/health`

Retrieves real-time health status, error rates, and circuit breaker states across configured providers. Requires no request parameters.

```json
{ "status": "ok", "message": "", "data": { "items": [
    { "providerId": "…", "key": "anthropic", "status": "healthy",
      "lastCheckAt": "…", "latencyMs": 214, "detail": "models.list ok" } ] } }
```

### 11.5 `POST /api/admin/providers/:id/test`

**Path parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `id` | string (UUIDv7) | Yes | Provider ID to run test check against. |

Runs a cheap health check now (must not consume meaningful tokens). `200`:
```json
{ "status": "ok", "message": "", "data": { "ok": true, "latencyMs": 230, "detail": "models.list ok" } }
```

---

## 12. Admin — errors & audit

All error exploration and audit log endpoints require `role=super_admin`.

### 12.1 `GET /api/admin/errors`

Queries sanitized system error events with filtering by time range, category, provider, or model.

**Query parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `from` | string (ISO-8601 UTC timestamp) | No | Start timestamp of error search window. |
| `to` | string (ISO-8601 UTC timestamp) | No | End timestamp of error search window. |
| `category` | string | No | Error category filter. |
| `providerId` | string (UUIDv7) | No | Filter by provider ID. |
| `modelId` | string (UUIDv7) | No | Filter by model ID. |
| `limit` | integer | No | Maximum number of records to return per page (default `50`, max `100`). |
| `cursor` | string | No | Opaque pagination cursor string. |

Sanitized `error_events` (no provider bodies, keys, or stack traces) in `data` as
`{ "items": [...], "nextCursor": … }`.

`200`:
```json
{ "status": "ok", "message": "", "data": {
    "items": [
      { "id": "1042", "occurredAt": "2026-10-08T09:12:00Z", "requestId": "req_0192…",
        "component": "orchestrator", "category": "provider_timeout",
        "providerId": "0192…", "modelId": "0192…", "generationId": "0192…",
        "message": "Upstream provider timed out after 180s",
        "context": { "timeoutMs": 180000, "streamState": "text.delta" } }
    ],
    "nextCursor": null } }
```

### 12.2 `GET /api/admin/audit-logs`

**Query parameters:**
| Parameter | Value type | Required | Description |
|---|---|---|---|
| `from` | string (ISO-8601 UTC timestamp) | No | Start timestamp of audit log search window. |
| `to` | string (ISO-8601 UTC timestamp) | No | End timestamp of audit log search window. |
| `actorUserId` | string (UUIDv7) | No | Filter by actor user ID. |
| `action` | string | No | Filter by audit action key (e.g. `user.password_reset`). |
| `targetType` | string | No | Filter by target entity type (e.g. `user`, `quota_policy`). |
| `targetId` | string | No | Filter by target entity ID. |
| `limit` | integer | No | Maximum number of records to return per page (default `50`, max `100`). |
| `cursor` | string | No | Opaque pagination cursor string. |

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

Provider health is **not** part of readiness. (The `/metrics` endpoint is removed in favor of Winston daily rotating JSON logs and database reporting tables).

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
| `model_unavailable` | 409 | later | model disabled or not permitted |
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
| `generation_interrupted` | terminal event | yes (manual retry) | server shutdown or worker crash recovery |
| `service_busy` | 503 | yes | node at generation capacity |
| `storage_unavailable` | 503 | yes | disk full/unavailable |
| `internal_error` | 500 | maybe | `message` is generic; `trace` only in development |

Errors after a stream has started cannot change the HTTP status: they arrive as a
`generation.failed` SSE event with the same `{code, message, retryable}` and are persisted (§7.1).

---

## 15. Data types & enums

| Concept | Values |
|---|---|
| User role | `user`, `admin`, `super_admin` |
| User status | `active`, `disabled` |
| Model status | `active`, `disabled` |
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
| Per IP — whole `/api` tree (abuse ceiling) | 600 req/min |
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
  no version boundary to straddle the change.
- Model capabilities are normalized — clients must not branch on provider identity.
- Error `code` values (§14) are treated as a stable, additive-only vocabulary; new codes may be added,
  existing ones are not renamed.
