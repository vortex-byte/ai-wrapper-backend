# Feature Plan: Local In-Browser AI Models

**Status:** Draft
**Last updated:** 2026-11-18
**Scope:** `ai-wrapper-api` (Hono + PostgreSQL) and `ai-wrapper-fe` (Next.js 16 SPA)
**Related contracts:** [`docs/API_CONTRACTS.md`](API_CONTRACTS.md) §4 (models), §6 (messages), §7 (generations)

---

## 1. Summary

Add a `local` provider type to the existing multi-provider chat platform. Users download an
open-weight model from Hugging Face into their own browser and inference runs on their device
through WebGPU. No server-side inference, GPU capacity, or separately installed runtime such as
Ollama is needed.

The backend remains the source of truth for authentication, the model catalog, conversation
history, and message persistence. It is **not** in the inference path: it receives the finished
user turn and assistant reply for storage, but never the token stream.

## 2. What already exists (and what this feature plugs into)

This plan is written against the current implementation. It does **not** assume a generic
`ChatProvider` abstraction; the SPA talks to the API through typed React Query hooks, and that is
reused rather than replaced.

### 2.1 Backend (implemented)

- **Catalog:** `ai_providers` + `ai_models` in PostgreSQL, managed by admins through
  `POST/PATCH/DELETE /api/admin/providers` and `/api/admin/models`
  (`src/providers/application/registry-admin-service.ts`, `src/providers/http/admin-routes.ts`).
  A provider must use a registered adapter key
  (`src/providers/infrastructure/register-adapters.ts`).
- **User catalog:** `GET /api/models` (`src/providers/http/model-routes.ts`) returns
  `{ id, displayName, providerLabel, status, capabilities, limits, imageOutput }` for active models
  on active providers. Model IDs are **UUIDv7**, not Hugging Face identifiers.
- **Conversations:** every conversation is bound to one `ai_models` row (`conversations.model_id`).
  The model is immutable after the first message (DB trigger), so a conversation never mixes
  providers.
- **Send pipeline:** `POST /api/conversations/:id/messages` requires `Idempotency-Key`, opens one
  transaction (idempotency claim → sequence allocation → user message + assistant placeholder →
  `generation_jobs` row → quota reservation), then queues server-side generation
  (`src/generations/application/send-service.ts`).
- **Streaming:** `GET /api/generations/:id/stream` replays/streams SSE frames with `Last-Event-ID`
  support. `POST /api/generations/:id/cancel` stops a run.
- **Persistence shape:** `messages` stores `role`, `status`, `finish_reason`, `metadata`, and
  `seq`; content lives in `message_parts`. There are **no** `provider`, `model_id`,
  `generated_on`, or `client_token_count` columns on `messages`; the conversation already owns the
  model.
- **Cross-cutting:** envelope `{status,message,data}`, CSRF on non-GET, per-user rate limits,
  UUIDv7 IDs, cursor pagination, no content in logs.

### 2.2 Frontend (implemented)

- Next.js 16 App Router, React 19, TanStack Query; typed BFF in `lib/api` (`browserApi`,
  envelope unwrapping, CSRF refresh, SSE reader in `lib/api/sse.ts`).
- `useModels()` (`lib/api/hooks/models.ts`) loads the catalog once and caches it for five minutes.
- `ChatView` (`components/features/chat/chat-view.tsx`) owns sending:
  create conversation → upload attachments → `useSendMessage` → `useGenerationStream` → invalidate
  messages/conversations/quota.
- `ChatComposer` groups models by `providerLabel`, locks the model for existing chats, and hides
  image/reasoning controls from capability flags. Attachments are gated by
  `limits.maxFilesPerMessage`.
- History renders through `messageToView` in `lib/chat/mappers.ts`; the stream's `generationId` is
  what makes the UI resume a server generation, so a message without it is never reconnected.
- There is no WebLLM dependency, no local worker, and no client-origin message endpoint today.

### 2.3 Gaps this feature must close

1. No `local` adapter/provider/model rows and no `execution` marker in the model wire shape.
2. No endpoint that stores a client-generated user turn or assistant reply without quota and
   without a `generation_jobs` row.
3. No client runtime, model download UI, or persistence hooks for local turns.
4. No CSP on the SPA for Hugging Face downloads and a WASM/worker runtime.

## 3. Goals

- Let a user download a local model once, load it, and chat with it entirely in the browser.
- Reuse the existing chat UI, model picker, history, and persistence model.
- Keep local conversations in PostgreSQL history by default, exactly like server conversations.
- Add zero server GPU/inference cost and no server quota consumption for local turns.
- Support Chromium, Firefox, and Safari/WebKit on desktop and mobile where the platform exposes
  WebGPU.

## 4. Non-Goals

- Server-side execution of local models, or exposing a user's device to the server.
- Metering or enforcing token quotas on local inference (the client cannot be trusted).
- Recording local turns in `usage_events` / `usage_daily` or the quota ledger.
- Server-side context building, server-side `systemAddendum` injection, tools, image generation, or
  document generation for local models. Local models do receive a **fixed, bundled system prompt**
  (see §4.1); that is different from the admin-editable server-side addendum.
- File/vision input for local models in the first release. The composer disables attachments via
  the model's `limits.maxFilesPerMessage = 0`.
- Fine-tuning or training.
- An internal Hugging Face mirror at launch (Hugging Face is reachable from the office network).
- Automatic model-tier recommendation. A small hint is shown when the user picks a local model.

### Why these are non-goals

They are not arbitrary exclusions. Each one is currently implemented **inside the server-side
inference pipeline**, and local inference deliberately bypasses that pipeline. Reusing them would
either send the prompt/context back through the server or require a second, browser-only
implementation.

| Excluded feature | Why it does not carry over to local models |
|---|---|
| Server-side context builder | `src/context-builder/context-builder.ts` produces a provider-shaped `NormalizedChatRequest`: it estimates tokens, truncates or compacts history against the provider/model context window, resolves replayed images, and budgets input using the user's remaining quota. Local models need a prompt built against the **actually loaded WebLLM model** and its KV-cache/context limits, in the browser. A server-built request would duplicate prompt assembly, expose the platform prompt, and still need client-side re-truncation. The client still manages context; only the *server-side* builder is out of scope. |
| Tools | The current tools are provider-hosted or cloud-hosted (image generation, containers/code execution). A local engine has no equivalent sandbox or execution environment, tool-call support varies by model, and a browser tool executor would add a new permission/sandbox/security surface. Tool usage also participates in quota tariffs, which do not exist for local turns. |
| Image generation | Existing image generation is either a provider-hosted tool or a dedicated image model. WebLLM text models do not render images; in-browser diffusion is a different runtime and model class with its own large download. |
| Document generation | It relies on provider cloud containers, `ArtifactSink`, attachment storage, and quota tariffs. The browser has no server sandbox, and adding client-side file generation would need a separate artifact/storage path. |

These are scope cuts for the text-chat MVP, not permanent bans: M3 can add client-side tools or
file handling if a product need appears. The model capability flags (`imageGeneration: null`,
`tools: false`, `documentGeneration: false`, `documents.pdf: false`) make the existing UI hide
these controls automatically, and the server send path rejects local models entirely.

### 4.1 Local system prompt **is** in the MVP

The exclusion applies to the server-side `systemAddendum` mechanism, not to platform instructions
themselves. Local models should still behave consistently, so the MVP includes a fixed local
system prompt:

- **Where it lives:** `lib/local-models/system-prompt.ts` exports a single
  `LOCAL_SYSTEM_PROMPT` constant. It is bundled with the SPA and changed only by a frontend deploy.
- **How it is applied:** `streamLocalChat()` always prepends it as the first
  `{ role: "system" }` message, before history and the new user turn. It is not part of the HTTP
  request body and is never read from `options`, conversation history, or browser storage.
- **How it is protected from accidental override:** the local persistence endpoints use strict Zod
  schemas and reject `system`, `systemPrompt`, or similar fields; the SPA has no UI or query
  parameter that can replace the constant. The model capability `systemPrompt: true` only means the
  engine accepts a `system` role.
- **Why hardcoded instead of admin-configurable:** a server-side addendum would require shipping
  the text to the browser and re-implementing prompt templating per model. A hardcoded constant
  keeps one source of truth for local behavior, avoids a new mutable public setting, and cannot be
  changed by a normal user at request time. If the prompt must change without a frontend deploy
  later, serve a read-only version from the API and cache it; that is a separate decision.
- **Honest limitation:** a user who controls their own browser can always modify client code or
  attach a debugger. "Hardcoded" prevents the official client and the API from supplying a
  different system prompt; it does **not** make prompt integrity enforceable on a user-owned
  device. Prompt injection inside the user turn remains a model-level risk, exactly as it is for
  server models.

The server-side, admin-editable `systemAddendum` path remains a non-goal for local models because
it is part of the server inference pipeline. The fixed local prompt is the local equivalent and is
enough for the MVP.

## 5. Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Execution location | Browser, marked `execution: "client"` on the model | No server inference path or quota accounting |
| Runtime | `@mlc-ai/web-llm`, pinned | WebGPU, prebuilt models, OpenAI-shaped chat API |
| Execution context | Web Worker (`CreateWebWorkerMLCEngine`) | Keeps the SPA responsive during load/generation |
| Model identity | `ai_models` row (UUID) with `apiModelId` = WebLLM model id | Conversations and history already reference `ai_models.id` |
| Catalog source | Admin-managed `ai_models` under one `local` provider | Reuses the existing registry, admin UI, and `/api/models` |
| Server adapter | `LocalAdapter` marker with no network/execution | Provider creation requires a registered adapter key |
| Caching | WebLLM-managed Cache API + `storage.persist()` | Download once, reuse across sessions |
| Persistence | Two new synchronous endpoints, not SSE | Server never sees the token stream |
| Local system prompt | Hardcoded `LOCAL_SYSTEM_PROMPT` bundled with the SPA; prepended by the local runtime | Consistent behavior; not user- or request-configurable |
| Quotas | No reservation, no `usage_events`, no ledger rows | Local inference has no company cost |
| History | Server-side by default, no opt-out | Matches current behavior for every conversation |
| Browsers | Chromium, Firefox, WebKit; desktop + mobile; feature-detected | Product requirement; WebGPU is the gate, not the UA |

Alternatives considered:

- **Transformers.js (ONNX):** viable fallback runtime, but adds a second model format and code
  path. Deferred until M0 proves WebLLM on all target engines.
- **wllama (GGUF over WebAssembly):** useful CPU fallback or for user-supplied `.gguf` files.
  Deferred.

## 6. Model Catalog

Any WebLLM-compatible model may be registered. The table below is an initial suggested ladder, not
a closed list; exact model IDs and VRAM requirements must be taken from the pinned WebLLM
`prebuiltAppConfig.model_list` (`vram_required_MB`) at implementation time. `downloadSizeBytes` is
measured during catalog setup because WebLLM does not expose it as a single field.

| Tier | Example `apiModelId` | Intended device |
|---|---|---|
| `small` | `Qwen3-0.6B-q4f16_1-MLC` | Low-end laptops, phones, simple tasks |
| `standard` | `gemma-2-2b-it-q4f16_1-MLC` | Default office laptop |
| `balanced` | `Llama-3.2-3B-Instruct-q4f16_1-MLC` | Better quality, more memory |
| `high` | `Phi-3.5-mini-instruct-q4f16_1-MLC` | Reasoning/coding, capable laptops |

Each local model is an `ai_models` row under one provider:

- Provider: `adapter = "local"`, a provider `key` of your choosing (the seed uses `on-device`), a
  `displayName` the SPA groups the picker by (the seed uses `On-device`), and no `secretRef`: the
  column is `NOT NULL`, so the server defaults it to `UNUSED_LOCAL_KEY`. That value is never
  resolved, and no secret is ever sent to the browser.
- Model: `apiModelId` is the WebLLM id; `displayName` is the user-facing label.
- Capabilities are fixed for the first release:

```json
{
  "streaming": true,
  "vision": false,
  "documents": { "pdf": false },
  "imageGeneration": null,
  "documentGeneration": false,
  "systemPrompt": true,
  "tools": false,
  "contextWindow": 8192,
  "maxOutputTokens": 2048
}
```

This makes the existing wire `limits` resolve to `maxFilesPerMessage: 0` and
`maxImagesPerMessage: 0`, so the composer disables attachments automatically. `systemPrompt: true`
only means the engine accepts the hardcoded `LOCAL_SYSTEM_PROMPT` role; it does not make the prompt
user-configurable.

- Local-only metadata lives in the model's free-form `config` (no migration), for example:

```json
{
  "local": {
    "webllmModelId": "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    "tier": "balanced",
    "downloadSizeBytes": 2100000000,
    "vramRequiredMB": 3674,
    "license": "llama3.2",
    "sourceRevision": "main",
    "requiredFeatures": ["shader-f16"]
  }
}
```

- Licenses are recorded and shown to the user. **Any license is acceptable**; there is no legal
  gate on the catalog. Pin `sourceRevision` (or a commit hash) so weights cannot change silently.
- `quota_weight` stays `1.000` and is unused for local models.
- `GET /api/models` gains additive fields. Existing clients ignore them:

```json
{
  "id": "0192…",
  "displayName": "Llama 3.2 3B (di perangkat)",
  "providerLabel": "Di perangkat ini",
  "status": "active",
  "execution": "client",
  "local": {
    "webllmModelId": "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    "tier": "balanced",
    "downloadSizeBytes": 2100000000,
    "vramRequiredMB": 3674,
    "license": "llama3.2",
    "requiredFeatures": ["shader-f16"]
  },
  "capabilities": { "…": "…" },
  "limits": { "maxFilesPerMessage": 0, "maxImagesPerMessage": 0 },
  "imageOutput": null
}
```

`execution` is derived from the provider's adapter (`local` ⇒ `"client"`, everything else ⇒
`"server"`); it is not stored as a separate model column. `local` is `null` for server models.

## 7. Architecture

```
Next.js SPA (ai-wrapper-fe)
├── ChatView ──► useSendMessage ──► Hono API ──► provider adapters (server models)
│      │             │                  │
│      │             └── SSE /api/generations/:id/stream
│      │
│      └── Local branch for execution="client"
│             ├── lib/local-models (WebLLM engine in a Web Worker) ──► WebGPU
│             │        ▲
│             │        └── downloads weights from Hugging Face; cached by the browser
│             ├── POST /api/conversations/:id/messages/local          (user turn)
│             └── POST /api/conversations/:id/messages/:mid/local-reply (assistant reply)
│
└── Existing history: GET /api/conversations/:id/messages ──► PostgreSQL
```

There is **one inference path**, chosen by the conversation's model. Server models keep the current
SSE pipeline. Local models never create a `generation_jobs` row, never reserve quota, and never
stream through the API.

### 7.1 Local turn sequence

1. `POST /api/conversations` with the local model's UUID (unchanged).
2. SPA ensures the WebLLM engine is loaded (downloading first if needed). A failed download/load
   does **not** persist a turn, so a conversation is never locked to a model the device cannot run.
3. SPA stores the user turn with `POST /api/conversations/:id/messages/local`; the response contains
   the persisted `userMessage` (UUID, `seq`). Until then the bubble is optimistic, like today.
4. SPA prepends the hardcoded `LOCAL_SYSTEM_PROMPT`, builds context from recent history plus the new
   text, and streams tokens from the worker into the existing assistant bubble.
5. On completion, SPA posts the final assistant text to
   `POST /api/conversations/:id/messages/:mid/local-reply`; the response contains the persisted
   `assistantMessage`.
6. SPA invalidates the message pages and conversation list, exactly like
   `invalidateAfterTurn()` does for server generations.

A cancelled or failed local generation is **not** persisted. The user message remains in history and
the SPA offers a retry that re-runs inference against that user message.

## 8. Backend Changes

### 8.1 Registry and catalog

1. Add `LocalAdapter` in `src/providers/infrastructure/adapters/local/` and register it in
   `createDefaultProviderRegistry()`.
   - `adapterKey = "local"`.
   - `execute()` yields a terminal provider error ("Local models run in the browser") instead of
     calling anything.
   - `estimateInputTokens()` returns `{ tokens: 0, confidence: "exact" }`.
   - `healthCheck()` returns ok with detail `"Runs in the browser"`; `listModels()` returns `[]`.
   - It has no network client, no API key, and no provider SDK.
2. Extend the registry projection (`src/providers/infrastructure/drizzle-registry-repository.ts`)
   with `providerAdapter: aiProviders.adapter` on `ModelRecord`.
3. Extend `toWireModel()` in `src/providers/http/model-routes.ts`:
   - `execution`: `"client"` when `providerAdapter === "local"`, otherwise `"server"`.
   - `local`: parsed from `model.config.local` (Zod-validated, `null` when absent).
4. Update the admin service so a `local` provider:
   - accepts no `baseUrl` and ignores `secretRef`;
   - skips provider model import (`listProviderModels` returns `[]`);
   - validates local model config (`config.local`) with a dedicated schema.

No database migration is required.

### 8.2 Reject local models on the server send path

In `SendService.send()` and `SendService.retry()`, after resolving the conversation model, reject
models whose provider adapter is `local`:

```json
{ "status": "error", "code": "unsupported_for_model",
  "message": "This model runs in your browser, not on the server.",
  "retryable": false }
```

This prevents a local model from ever reserving quota, creating a generation, or occupying the
one-active-generation slot.

### 8.3 New persistence endpoints

Both endpoints live in `src/conversations/http/routes.ts` and are backed by a new
`ClientMessageService` in `src/generations/application/` (the existing send service already writes
conversation rows, so this follows the current module pattern). Both require the session cookie,
`X-CSRF-Token`, `Idempotency-Key`, and the existing user rate limit. Add both routes to
`docs/API_CONTRACTS.md` §6 in the same change.

#### `POST /api/conversations/:id/messages/local`

Stores one user turn for a client-execution conversation.

Request:

```json
{ "parts": [{ "type": "text", "text": "Ringkas dokumen ini." }] }
```

- Validate: conversation ownership (404 for another user), model is active and
  `execution === "client"` (else `422 unsupported_for_model`), text-only parts, at least one
  non-empty part, total text ≤ 200,000 characters, no `file`/binary parts.
- Transaction: claim idempotency (`POST /api/conversations/:id/messages/local`) → `allocateSeq(id, 1)`
  → insert a `role = "user"`, `status = "complete"` message with one text part → set the title if it
  is still the default (`deriveTitleFromText`, same as the server path) → store the idempotent
  response.
- `messages.metadata` records `{ "execution": "client" }`.
- No quota reservation, no `generation_jobs` row, no `usage_events` row.

Response `201`:

```json
{ "status": "ok", "message": "Message saved.", "data": {
    "userMessage": { "id": "…", "seq": 4, "role": "user", "status": "complete",
                     "finishReason": null, "createdAt": "…", "generationId": null,
                     "parts": [ { "id": "…", "position": 0, "type": "text",
                     "format": "markdown", "text": "…" } ] } } }
```

Replays return the stored response with `Idempotency-Replayed: true`.

#### `POST /api/conversations/:id/messages/:mid/local-reply`

Stores the finished assistant reply for `:mid`.

Request:

```json
{
  "parts": [{ "type": "text", "text": "…" }],
  "finishReason": "stop",
  "clientUsage": { "inputTokens": 812, "outputTokens": 244 }
}
```

- Validate: conversation ownership; client-execution model; `:mid` is a user message in this
  conversation; `:mid` is still the latest non-superseded message (otherwise `409 conflict`, so a
  delayed reply can never reorder history); no assistant reply already exists for `:mid`
  (idempotent replay handles the retry case); text-only, non-empty, ≤ 200,000 characters;
  `finishReason` is one of `stop | length`.
- Transaction: claim idempotency
  (`POST /api/conversations/:id/messages/:mid/local-reply`) → `allocateSeq(id, 1)` → insert a
  `role = "assistant"`, `status = "complete"`, `completed_at = now()` message with one text part.
- `messages.metadata` records `{ "execution": "client", "local": { "clientUsage": … } }`.
  `clientUsage` is informational only and is never used for quota or billing.
- No quota, generation, usage, or ledger writes.

Response `201`:

```json
{ "status": "ok", "message": "Reply saved.", "data": {
    "assistantMessage": { "id": "…", "seq": 5, "role": "assistant", "status": "complete",
                          "finishReason": "stop", "createdAt": "…", "generationId": null,
                          "parts": [ { "id": "…", "position": 0, "type": "text",
                          "format": "markdown", "text": "…" } ] } } }
```

#### Shared behavior

- Both endpoints use the existing envelope helpers and error vocabulary
  (`invalid_request`, `not_found`, `conflict`, `unsupported_for_model`, `rate_limited`), and their
  Zod schemas reject `system`/`systemPrompt` fields so a client cannot persist a competing system
  prompt.
- The regular conversation `userRateLimit` applies; the user-turn endpoint also uses the existing
  `generationLimit` so a local turn consumes one request slot. The reply endpoint does not, so a
  turn does not consume two generation slots.
- Neither endpoint touches `attachments`, `files`, or `storage`.

### 8.4 Data model

No schema change. This is a deliberate correction to earlier drafts of this plan:

| Earlier draft | Actual implementation |
|---|---|
| `messages.provider` | Not needed. `conversations.model_id` identifies the model and provider. |
| `messages.model_id` | Not needed; same reason. |
| `messages.generated_on` | `messages.metadata.execution = "client"` for provenance. |
| `messages.client_token_count` | Optional `messages.metadata.local.clientUsage`, informational only. |
| Quota/usage rows | None. Local turns do not appear in `usage_events` or `usage_daily`. |

Reports and dashboards therefore continue to describe **server-billed** usage only. If local usage
counts are needed later, add a read-only reporting query over `messages.metadata` rather than
pretending local tokens were billed.

## 9. Frontend Changes (`ai-wrapper-fe`)

### 9.1 Types and catalog

- Add to `lib/api/types/models.ts`:

```ts
export interface ILocalModelInfo {
  webllmModelId: string;
  downloadSizeBytes: number;
  vramRequiredMB: number;
  license: string;
}

export interface IModel {
  // existing fields…
  execution: "server" | "client";
  local: ILocalModelInfo | null;
}
```

- `useModels()` is unchanged. Local models arrive in the same list and are grouped by the
  `providerLabel` ("Di perangkat ini"), so the existing `ChatComposer` model menu already separates
  them from server providers.
- `ChatView` currently falls back to `models[0]` on a fresh chat. Keep local models after server
  models in catalog order, or change that fallback to prefer `execution === "server"`, so a local
  model never becomes the silent default on an unsupported device.

### 9.2 Local runtime module

Add a client-only module:

```
lib/local-models/
├── engine.ts       # singleton engine, load/unload, abort, streaming
├── worker.ts       # new Worker(...); CreateWebWorkerMLCEngine
├── cache.ts        # download state, storage estimate/persist, delete
├── system-prompt.ts # hardcoded LOCAL_SYSTEM_PROMPT (single source of truth)
└── types.ts        # progress + error shapes
```

- `engine.ts` is `"use client"` and must never be imported by a server component.
- Only one model is loaded at a time; switching unloads the current engine. A single worker is
  reused per tab.
- `streamLocalChat()` exposes an `AsyncIterable<string>` plus an `interrupt()` used by the existing
  stop button.
- The worker must be bundled in a way that works with Next.js 16 + Turbopack. Verify the production
  build in M0; fall back to a static worker file in `public/` only if the bundler cannot handle it.
- Pin `@mlc-ai/web-llm` to an exact version in `package.json`.

### 9.3 ChatView integration

Branch on the conversation/selected model, not on provider names:

```ts
const isClientModel = model?.execution === "client";
```

- `handleSend` keeps creating the conversation through the existing mutation.
- `dispatchTurn` splits:
  - **server:** current path (`useSendMessage` → `useGenerationStream`).
  - **client:** load/ensure the engine → `useSaveLocalUserTurn` → `useLocalTurn` (engine stream) →
    `useSaveLocalReply` → invalidate the same query keys.
- `useLocalTurn` exposes the same view shape as `LiveTurn` so `AssistantMessageBox` and
  `liveToView` keep working. Widen `LiveTurn.generationId` to `string | null` and set it to `null`;
  no SSE connection is attempted.
- The stop button calls `interrupt()` instead of `POST /generations/:id/cancel`.
- While a local turn is running, sending another turn is blocked (same `streaming` guard as today).
- Gate the pending-first-turn effect on `useModels()` resolving and the conversation's `modelId`
  being present in the catalog; otherwise the execution branch is unknown and the turn could be
  sent to the server path by mistake.
- Build local context client-side: flatten the loaded history, estimate tokens, and drop the oldest
  turns until the prompt fits `capabilities.contextWindow - capabilities.maxOutputTokens`. Show a
  quiet "konteks dipotong" hint when turns are dropped. The server context builder is not involved.
  The history is read from the query cache and awaited when it is still loading, so a turn sent
  right after opening a conversation still gets the earlier turns as context.
- Always prepend `LOCAL_SYSTEM_PROMPT` as the first `role: "system"` message before history and the
  new user turn. Do not send it in the persistence payload and do not accept an override from
  `options`, history, URL state, or local storage.
- Local models ignore `options.reasoningEffort`, image generation, and attachments; the composer
  already hides those controls and caps files at `limits.maxFilesPerMessage = 0`.
- The placeholder bubble that stands in for the turn being stored takes the stored message id once
  the server accepted it, so the turn is rendered once while the answer is generated. The
  composition lives in `lib/chat/mappers.ts` (`composeMessages`) and is covered by a unit test.

### 9.4 New API hooks and types

Add to `lib/api/endpoints/conversations.ts`, `lib/api/hooks/messages.ts`, and
`lib/api/types/messages.ts`:

```ts
localMessage: (id: string) => `/conversations/${id}/messages/local`,
localReply: (id: string, messageId: string) =>
  `/conversations/${id}/messages/${messageId}/local-reply`,
```

- `useSaveLocalUserTurn()` → `{ userMessage }`.
- `useSaveLocalReply()` → `{ assistantMessage }`.
- Generate an `Idempotency-Key` with `crypto.randomUUID()` for each request, exactly like
  `useSendMessage`.
- `browserApi` already adds CSRF and refreshes it on `403`; no extra code is needed.

### 9.5 Model picker badge and download UI

The requirement is a **small badge**, not automatic tier selection:

- In the local provider group, each item shows a badge beside the name:
  `small`, `standard`, `balanced`, `high`.
- Selecting a model that is not downloaded opens a small confirmation (size, WebGPU status,
  privacy note) with a primary action "Unduh & pakai".
- Download state is shown per model using icon (not downloaded, downloading, ready, loaded). The icon is should be `justify-between` with model name and the badge.
- A "Model lokal" section on `/profile` lists downloaded models, size, and a delete action that
  removes the model's entries from the WebLLM-managed Cache API (using the helper exposed by the
  pinned WebLLM version) and refreshes `navigator.storage.estimate()`.

### 9.6 History, reload, and retry

- Persisted local messages render through the existing `useMessages` → `messageToView` path; no new
  history endpoint is needed.
- Because the saved assistant message has no `generationId`, the existing effect in `ChatView` that
  resumes SSE will not fire.
- Reloading during a local generation shows the saved user turn and no assistant bubble (the reply
  was not persisted yet). This is intentional and avoids a permanent "streaming" placeholder.
- A failed local generation shows a client-only error bubble with "Coba lagi"; retry re-runs
  inference against the already-saved user message and then calls `local-reply`. The retry reuses the
  stored message id and the original idempotency keys, so the server replays the stored turn
  instead of writing a second one.
- Opening an existing local conversation on a device/browser without WebGPU renders its history but
  disables the composer with an explanation; history is never hidden.
- Add a small model label to the chat header or conversation list by resolving
  `conversation.modelId` against `useModels()`; no API change is needed.

### 9.7 Admin UI

Extend the existing `/admin/model` screens:

- Provider form: `local` in the adapter select; hide `baseUrl`/`secretRef`; "Test connection"
  reports "Runs in the browser".
- Model form for a local provider: preset text-only capabilities, expose `apiModelId`,
  `config.local.downloadSizeBytes`, `vramRequiredMB`, `license`, and `sourceRevision`; hide
  "import models from provider".

## 10. User Flows

1. **Discover:** the model picker lists local models alongside server providers, with size and
   a private/offline hint.
2. **Download:** the user confirms, sees progress and can cancel; the download resumes/caches across
   reloads through WebLLM's Cache API.
3. **Chat:** the first send creates a conversation on the local model; tokens stream from the worker
   into the normal assistant bubble; stop interrupts the worker.
4. **Persist:** once the model is ready, the user turn is saved before inference; the assistant reply
   is saved on completion. Both appear in history on any device, like any other conversation.
5. **Manage:** downloaded models can be listed and deleted from the profile page.
6. **Unsupported device:** if WebGPU is unavailable, the adapter request fails, or storage is
   insufficient, local models stay visible but disabled with a clear reason (the reason is shown as
   inline secondary text in the model row); server models remain the default.

## 11. Capability Detection

- `navigator.gpu?.requestAdapter()` must succeed before a local model is offered as usable.
- Check the adapter for the features the chosen model needs (at minimum `shader-f16` where the
  model requires it).
- `navigator.storage.estimate()` must show enough headroom for the model plus the KV cache before
  download.
- Call `navigator.storage.persist()` once, on first local use, to reduce eviction.
- `navigator.deviceMemory` is informational only on Chromium; it is **not** used to auto-select a
  tier.
- Load failures (OOM, device lost, shader compilation) show a manual suggestion to try a smaller
  model and a retry action.
- If the pinned WebLLM build uses WebAssembly threads, verify `crossOriginIsolated` and test any
  COOP/COEP headers added for `SharedArrayBuffer` against existing SPA assets before enabling them
  globally.
- Detection is feature-based, never UA-sniffing.

### 11.1 Target browser matrix

| Engine | Desktop | Mobile | Notes |
|---|---|---|---|
| Chromium | Yes | Yes (Android) | Primary development target |
| Firefox | Yes | Yes (Android, where WebGPU is available) | WebGPU rollout varies by OS/version |
| Safari/WebKit | Yes (macOS) | Yes (iOS/iPadOS) | WebGPU rollout varies by OS version |

The product requirement is all three engines on desktop and mobile. The feature gate is actual
WebGPU/WebLLM capability, not browser branding. M0 must verify WebLLM on each engine and device
class; if an engine cannot run WebLLM at all, that is a release blocker to resolve (for example with
the deferred Transformers.js/wllama fallback), not a silent removal from scope.

## 12. Security, Privacy, and Compliance

- **History is on by default.** Local chats are persisted exactly like server chats; there is no
  opt-out in this release. The UI states this clearly.
- **The local system prompt is fixed.** It is a bundled constant, never supplied by the request or
  editable in the UI. The persistence endpoints reject `system`/`systemPrompt` fields. This prevents
  the official client and API from substituting instructions; it cannot prevent a user who modifies
  their own client from changing local behavior, because the model runs on their device.
- Prompts and replies stay on the device **during inference**. They reach the backend only as the
  finished user/assistant messages used for history.
- Treat client-submitted content as untrusted: validate ownership, roles, part types, text size, and
  `finishReason`; never accept binary parts for local models; rate-limit both endpoints.
- No Hugging Face token is shipped to the browser. Public models only.
- The SPA currently ships **no** Content-Security-Policy. When one is added (recommended in M2),
  `connect-src` must allow the exact download hosts observed in M0 (initially `huggingface.co`,
  `cdn-lfs*.huggingface.co`, and the model-lib CDN), and `worker-src`/`script-src` must allow the
  WebLLM worker and WASM (`'wasm-unsafe-eval'`). Next.js inline scripts require a nonce or an
  equivalent allowance; do not add a blanket `'unsafe-inline'`.
- Pin the model revision (`config.local.sourceRevision`) and the `@mlc-ai/web-llm` version.
- Hugging Face is reachable from the office network. An internal mirror remains a contingency, not
  a launch dependency; if it becomes necessary, point WebLLM at it through a custom `appConfig`
  without changing the inference topology.
- Do not log local prompt/reply text. Existing logging rules apply unchanged.
- Markdown rendering stays on the current `react-markdown` path (no raw HTML), so local output
  cannot introduce a new XSS surface.

## 13. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| WebGPU/WebLLM gaps on Firefox, Safari, or mobile | Feature unusable on a required engine | M0 compatibility spike per engine/device; capability gate; fallback runtime decision if blocked |
| Mobile memory/thermal limits | Crashes or slow generation | Offer the light tier, show size/VRAM, manual choice, retry with a smaller model |
| Large downloads on slow networks | Poor first use | Show size before download, allow cancel, cache and persist storage |
| No quota control on local usage | Cannot meter tokens | Accepted by design; no billing rows; local turns are not in usage reports |
| History storage abuse by a client | DB growth | Auth + rate limits + 200k-character cap + conversation ownership checks |
| Delayed assistant reply reorders history | Corrupted thread | Server rejects a reply whose user message is no longer the latest (`409 conflict`) |
| Browser cache eviction | Repeated downloads | `storage.persist()`, quota check, management UI |
| Local model quality in Bahasa Indonesia | User dissatisfaction | Label the tier, set expectations, evaluate real office prompts in M0/M1 |
| WebLLM or model-format upgrade breaks a model | Breakage after deploy | Pin the library and model revisions; test upgrades explicitly |
| CSP added later blocks downloads/worker | Feature fails only in production | Include local hosts in the CSP test matrix; verify in staging |

## 14. Milestones

**M0 — Spike and compatibility (2–4 days)**

- Load one model in a Web Worker and stream a reply on Chromium, Firefox, and Safari/WebKit, on
  desktop and at least one mobile device per engine.
- Measure load time, memory, and download size; verify the Next.js 16/Turbopack worker build.
- Confirm the exact WebLLM model list and metadata fields for the pinned version.
- Confirm the Hugging Face/CDN hosts for the future CSP.

**M1 — MVP**

- `LocalAdapter` marker, `providerAdapter` in the registry, `execution` + `local` in
  `GET /api/models`; update registry fixtures and the model-wire tests for the additive fields.
- `POST /messages/local` and `POST /messages/:mid/local-reply` with idempotency, validation, and no
  quota/usage writes.
- Reject local models on the existing server send/retry paths.
- `LocalProvider` runtime + worker, hardcoded `LOCAL_SYSTEM_PROMPT`, `ChatView` branch,
  persistence hooks, one or two models.
- Model picker hint and basic download progress.

**M2 — Hardening**

- Full capability detection, storage management UI, delete/download state, retry and reload edge
  cases.
- Browser/device matrix hardening (Safari/WebKit, Firefox, mobile).
- Full initial catalog, admin form extensions, CSP, and staging verification.
- Tests: no quota/usage rows for local turns, idempotent replay, 404 on another user's conversation,
  server rejection of local models, reordered-reply rejection.

**M3 — Optional enhancements**

- Ollama/`localhost` provider for power users.
- wllama CPU fallback or user-supplied `.gguf` files.
- More models via a custom `appConfig` with pinned revisions.
- Local usage counts in reporting (read-only, derived from message metadata).

## 15. Acceptance Criteria

- A user on a supported browser/device can download, load, and chat with a local model without
  installing anything.
- Reloading does not re-download an already cached model.
- The UI stays responsive during model load and generation.
- Local conversations are persisted in history by default, render like any other conversation, and
  show the model label.
- Unsupported devices see a clear explanation and disabled local models, not a failed download.
- Users can see storage usage and delete downloaded models.
- No quota reservation, `generation_jobs` row, `usage_events` row, or `usage_daily` increment is
  created for a local turn.
- `POST /api/conversations/:id/messages` and `.../retry` reject a local model with
  `422 unsupported_for_model`, so a local model can never enter the server inference path.
- Local turns are text-only; attachments, image generation, reasoning controls, and document
  generation are unavailable for local models.
- Every local turn is prefixed with the hardcoded `LOCAL_SYSTEM_PROMPT`; no request field, user
  setting, or UI control can replace or disable it.
- Reply persistence is idempotent; a delayed reply cannot be written after a newer turn.

## 16. Resolved Questions

1. **Browsers:** Chromium, Firefox, and Safari/WebKit, on both desktop and mobile. The gate is
   WebGPU/WebLLM capability, not user-agent detection; M0 verifies each engine and device class.
2. **History:** stored on the server by default, exactly like the current implementation. No opt-out
   in this release.
3. **Hugging Face:** reachable from the office network. No internal mirror at launch; keep it as a
   documented contingency.
4. **Licenses:** any model is acceptable. Record and display the license; do not block the catalog on
   license type.
5. **Recommendation:** no automatic model-tier selection. Show a small hint (private, approximate
   size, no quota) when the user picks a local model.
6. **System addendum for local models:** included in MVP as a hardcoded `LOCAL_SYSTEM_PROMPT` in the
   SPA, not as the admin-editable server-side addendum. The latter remains out of scope because it
   belongs to the server inference pipeline.