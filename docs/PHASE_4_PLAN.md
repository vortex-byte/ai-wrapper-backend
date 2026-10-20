# Phase 4 Implementation Plan: Files, Multimodal & Provider Cloud Containers

> **Document Status:** Draft v1.0 — Execution Blueprint for Phase 4  
> **Date:** October 2026  
> **Sources of Truth:** `docs/PRD.md` · `docs/API_CONTRACTS.md` · `AGENTS.md` · `docs/IMPLEMENTATION_PLAN.md`  
> **Key Decisions:** Zero Docker on VPS (D-7, A-4); offload document generation and code execution to **Anthropic Claude and OpenAI hosted cloud containers** instead of running self-hosted container runtimes on the host.

---

## 1. Executive Summary & Architectural Shift

### 1.1 The Architectural Shift
In earlier architectural sketches, document and file generation (PDF reports, DOCX documents, XLSX spreadsheets, PPTX presentations, data visualizations) often relied on self-hosted sandboxes (local Docker containers, headless LibreOffice, Pandoc, or Python runtimes) running on the application server.

In this architecture, **we explicitly reject running self-hosted execution containers on the VPS**. The VPS runs exclusively as native Bun processes (`ROLE = api | worker | all`, systemd, PostgreSQL, zero Docker daemon).

Instead, we leverage **provider cloud-hosted containers and native skills**:
1. **Anthropic Claude Container Sandbox:** Built-in `code_execution` (`code_execution_20250825` / `code_execution_20260120`) running inside an isolated AMD64 Linux sandbox (5 GiB RAM, 5 GiB disk, 1 CPU, 30-day lifecycle) paired with official Anthropic Agent Skills (`pptx`, `xlsx`, `docx`, `pdf`).
2. **OpenAI Hosted Container:** Responses API with `code_interpreter` (hosted cloud Python sandbox) and `shell` with `environment: { type: "container_auto" }` for curated/uploaded skills (e.g., `openai-spreadsheets`). Image generation uses OpenAI's hosted `image_generation` tool on the same API — provider-side only, no local renderer; Claude cannot generate images, and Gemini image output is post-MVP.
3. **ArtifactSink Hydration:** Output files generated inside provider containers are captured from provider Files APIs (Anthropic `/v1/files/:id/content`, OpenAI `/v1/containers/:container_id/files/:file_id/content`), streamed directly into local storage (`LocalStorageProvider`), persisted in `attachments` (`origin = 'generated'`), and linked to `message_parts` (`type = 'generated_file'`).

### 1.2 Comparison Matrix

| Dimension | Self-Hosted Container Approach | Provider Cloud Container Approach |
|---|---|---|
| **VPS Infrastructure** | Requires Docker daemon or microVM hypervisors; complex host kernel security. | **Zero Docker on VPS.** Standard native Bun process under systemd. |
| **Host Resource Impact** | Heavy CPU/RAM spikes during complex compilation (Pandoc, LaTeX, LibreOffice). | **Zero load on VPS CPU/RAM.** Compute occurs on provider infrastructure. |
| **Security & Sandbox Escape** | High risk running untrusted code on local hardware; privilege escalation vectors. | **Complete isolation.** Untrusted code runs in provider-managed multi-tenant sandboxes. |
| **Document Output Quality** | Fragile local templates and CLI converters. | **Post-trained native skills** (`pdf`, `docx`, `xlsx`, `pptx`, `openai-spreadsheets`) with battle-tested styling. |
| **Local File Handling** | Complex volume mounts between host and containers. | Clean API: input files uploaded to provider Files API; output files downloaded by `ArtifactSink`. |

---

## 2. End-to-End Architecture & Sequence

### 2.1 Module Seams & Dependencies

Following `AGENTS.md` §3.2 (Dependency Rule), boundaries remain strictly enforced:
- `attachments/`: Owns upload validation, file metadata persistence, and `FileService`.
- `storage/`: Owns the `StorageProviderPort` and `LocalStorageProvider`. Knows nothing of conversations or providers.
- `providers/`: Implements provider adapters (`openai`, `anthropic`, `gemini`). Only place where provider SDKs appear.
- `orchestrator/`: Cross-module coordinator. Drives generation, connects provider streams to `ArtifactSink`.
- `artifactsink/`: Glue component. Streams provider-emitted bytes/file IDs into `StorageProvider`, creates `attachments` rows, and updates `message_parts`.

```
                    ┌────────────────────────┐
                    │ Client (Web Browser)   │
                    └───────────┬────────────┘
                                │ 1. Upload input file (multipart)
                                ▼
                     POST /api/conversations/:id/attachments
                                │
                    ┌───────────▼────────────┐
                    │ attachments/upload.ts  │ ──► Magic-byte, dimension, zip-bomb checks
                    └───────────┬────────────┘
                                │ 2. Stream to storage
                                ▼
                    ┌────────────────────────┐
                    │  LocalStorageProvider  │ ──► /var/lib/ai-chat/files/YYYY/MM/<uuid>
                    └────────────────────────┘
                                │ 3. Insert row
                                ▼
                    PostgreSQL `attachments` (status='ready')
```

### 2.2 File Generation & Hydration Sequence

```
Client               API Orchestrator          Anthropic / OpenAI               ArtifactSink            LocalStorage
  │                         │                          │                             │                       │
  │  POST /messages (send)  │                          │                             │                       │
  │────────────────────────►│                          │                             │                       │
  │                         │ 1. T1: Quota reserve,    │                             │                       │
  │                         │    create placeholder    │                             │                       │
  │                         │ 2. If input files attached, upload to Provider Files API│                      │
  │                         │─────────────────────────►│                             │                       │
  │                         │    Returns providerFileId│                             │                       │
  │                         │◄─────────────────────────│                             │                       │
  │                         │                          │                             │                       │
  │                         │ 3. Execute with tools    │                             │                       │
  │                         │    (code_execution +     │                             │                       │
  │                         │     skills: docx, pdf)   │                             │                       │
  │                         │─────────────────────────►│                             │                       │
  │                         │                          │ 4. Cloud container runs     │                       │
  │                         │                          │    bash/python, generates   │                       │
  │                         │                          │    file into $OUTPUT_DIR    │                       │
  │                         │                          │                             │                       │
  │  SSE: tool.started      │                          │                             │                       │
  │◄────────────────────────│ (event: tool.started)    │                             │                       │
  │  SSE: tool.delta        │                          │                             │                       │
  │◄────────────────────────│ (event: tool.delta stdout│                             │                       │
  │                         │                          │                             │                       │
  │                         │ 5. Generation completes  │                             │                       │
  │                         │    Returns tool result   │                             │                       │
  │                         │    with providerFileId   │                             │                       │
  │                         │◄─────────────────────────│                             │                       │
  │                         │                          │                             │                       │
  │                         │ 6. Hand off to ArtifactSink                            │                       │
  │                         │───────────────────────────────────────────────────────►│                       │
  │                         │                          │ 7. GET /v1/files/:id/content│                       │
  │                         │                          │◄────────────────────────────│                       │
  │                         │                          │    Binary stream            │                       │
  │                         │                          │────────────────────────────►│ 8. putStream()        │
  │                         │                          │                             │──────────────────────►│
  │                         │                          │                             │ 9. Insert attachments │
  │                         │                          │                             │    (role='generated') │
  │                         │                          │                             │    Update part        │
  │                         │                          │                             │    (type='generated') │
  │                         │ 10. T2: Settle quota & commit                          │                       │
  │                         │◄───────────────────────────────────────────────────────│                       │
  │                         │                                                        │                       │
  │  SSE: part.completed    │                                                        │                       │
  │  {downloadUrl, fileId}  │                                                        │                       │
  │◄────────────────────────│                                                        │                       │
  │  SSE: gen.completed     │                                                        │                       │
  │◄────────────────────────│                                                        │                       │
  │                         │                                                        │                       │
  │ GET /api/files/:id/content                                                       │                       │
  │────────────────────────►│                                                        │                       │
  │                         │ Stream binary from disk ──────────────────────────────────────────────────────►│
  │◄────────────────────────│                                                                                │
```

---

## 3. Detailed Milestone Specifications

### M4.1 — Storage & Attachments Domain Foundations

#### Database Schema
Per `AGENTS.md` §6.7, apply migration `0011_attachments_and_files.sql`:

```sql
CREATE TABLE attachments (
  id               uuid PRIMARY KEY,
  owner_user_id    uuid NOT NULL REFERENCES users(id),
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       uuid REFERENCES messages(id) ON DELETE SET NULL,
  message_part_id  uuid,
  origin           text NOT NULL CHECK (origin IN ('input','generated')),
  kind             text NOT NULL CHECK (kind IN ('image','document','other')),
  display_name     text NOT NULL,
  declared_mime    text,
  detected_mime    text NOT NULL,
  size_bytes       bigint NOT NULL CHECK (size_bytes >= 0),
  sha256           char(64) NOT NULL,
  storage_provider text NOT NULL,
  storage_bucket   text,
  storage_key      text NOT NULL,
  status           text NOT NULL CHECK (status IN
                     ('uploading','validating','processing','ready','rejected','failed','missing','expired','deleted')),
  error_code       text,
  width            int,
  height           int,
  page_count       int,
  metadata         jsonb NOT NULL DEFAULT '{}',
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  pinned_at        timestamptz,
  UNIQUE (storage_key)
);

CREATE TABLE file_extractions (
  file_id        uuid PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  status         text NOT NULL CHECK (status IN ('pending','done','failed','unsupported')),
  extractor      text,
  text           text,
  char_count     int CHECK (char_count >= 0),
  token_estimate int,
  truncated      boolean NOT NULL DEFAULT false,
  page_count     int,
  error_code     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Foreign key on message_parts
ALTER TABLE message_parts
  ADD CONSTRAINT message_parts_file_fk FOREIGN KEY (file_id) REFERENCES attachments(id);

CREATE INDEX attachments_owner_conv_idx ON attachments (owner_user_id, conversation_id);
CREATE INDEX attachments_message_idx    ON attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_expiry_idx     ON attachments (expires_at) WHERE status NOT IN ('expired','deleted');
CREATE INDEX attachments_sha256_idx     ON attachments (sha256);
```

#### Ports & Storage Implementation
- **`src/storage/ports/storage-provider.ts`**:
  ```ts
  export interface PutStreamResult {
    readonly key: string;
    readonly sizeBytes: number;
    readonly sha256: string;
  }

  export interface GetStreamResult {
    readonly stream: ReadableStream<Uint8Array>;
    readonly sizeBytes: number;
    readonly contentType: string;
  }

  export interface StorageProviderPort {
    readonly kind: string;
    putStream(key: string, stream: ReadableStream<Uint8Array>, contentType: string): Promise<PutStreamResult>;
    getStream(key: string, range?: { start: number; end?: number }): Promise<GetStreamResult>;
    exists(key: string): Promise<boolean>;
    delete(key: string): Promise<void>;
  }
  ```
- **`src/storage/infrastructure/local-storage-provider.ts`**:
  - Implements `StorageProviderPort` against `STORAGE_LOCAL_ROOT` (`/var/lib/ai-chat/files`).
  - Key layout: `files/YYYY/MM/<uuidv7>`.
  - Atomicity: writes to `.tmp` file first, hashes on the fly with `crypto.createHash('sha256')`, enforces hard byte limit abort, renames to final key on completion.
  - Native Bun streaming: uses `Bun.file(fullPath).stream()`.

#### Content Serving Route (`GET /api/files/:id/content`)
- Enforces user ownership via `AuthContext`. If user does not own conversation/file, return `404 Not Found` (never 403).
- Content headers:
  - `Content-Type: <detected_mime>`
  - `Content-Disposition: attachment; filename="<sanitized_display_name>"` (or `inline` for verified images)
  - `X-Content-Type-Options: nosniff`
  - `Cache-Control: private, max-age=3600`
  - `Accept-Ranges: bytes`
- Handles HTTP `Range: bytes=start-end` for partial content (audio/video/large PDF seeking) returning `206 Partial Content`.

---

### M4.2 — Upload Validation & Lightweight Text Extraction Pipeline

#### Upload Hardening Rules (PRD §12.4)
1. **Request Stream Cap:** Reject request immediately if bytes exceed `MAX_UPLOAD_BYTES` (30 MB).
2. **Magic-Byte Sniffing:**
   - Detect binary signature before accepting.
   - Reject declared `image/png` if magic bytes indicate `text/html` or executable ELF/PE.
3. **Image Probing:**
   - Read image header bytes to extract width/height.
   - Limit: max dimensions 8000×8000 px (≤ 40 MP). Reject pixel bombs.
   - Reject animated GIFs/APNG/SVGs.
4. **OOXML Archive Protection (.docx, .xlsx):**
   - Must be valid ZIP archive.
   - Limit zip entries ≤ 2,000; total uncompressed size ≤ 100 MB; compression ratio ≤ 100:1 (zip-bomb guard).
   - Reject macro-enabled documents (`.docm`, `.xlsm`, or containing `vbaProject.bin`).
5. **PDF Protection:**
   - Reject encrypted/password-protected PDFs.
   - Reject PDFs with embedded JavaScript or form submit actions.

#### Async Text Extraction (`file_extractions`) — powered by **anydoc**
- **Engine:** [`firecrawl/anydoc`](https://github.com/firecrawl/anydoc) (`@firecrawl/anydoc` npm package) — a pure-Rust converter (Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, PDF → clean GitHub-Flavored Markdown) with Node.js bindings that run on the libuv thread pool (never blocks the Bun event loop). Median conversion < 5 ms.
- **Why anydoc:** one dependency replaces per-format parsers (pdf-parse, mammoth, xlsx readers); it performs content-based format detection (mislabeled files still convert), scores highest on every judged format in its benchmark, and is MIT-licensed.
- **Supported input kinds (PRD §12.3):** `.pdf` (text-based, locally via pdf-inspector), `.docx` (also `.doc`), `.xlsx` (also `.xls`), `.pptx`, `.csv`, `.txt`/`.md` (plain text, no conversion needed), `.rtf`, `.odt/.ods/.odp`, `.epub`.
- **Scanned PDFs / OCR:** anydoc raises `NeedsOcr` for image-only PDFs. MVP records the extraction as `failed` with `error_code = 'needs_ocr'`; the hosted OCR path (`ocr: 'hosted'` → Firecrawl Parse, `FIRECRAWL_API_KEY` for higher limits) is the P2 OCR extension point and is **off by default** — no document bytes leave the VPS unless explicitly enabled.
- **Security boundaries retained:** upload hardening (§ above) runs *before* anydoc; encrypted documents are already rejected at validation time (anydoc's `Encrypted` error is a backstop). Output is data-only Markdown — tabular exports keep the CSV formula-injection prefix rule (PRD §12.4 rule 10).
- **Bounded output:** anydoc Markdown is capped at ≤ 200,000 chars (truncation flagged in `file_extractions.truncated`) so extracted text can't blow up context building.
- **Fast-path pattern unchanged:** `POST /api/conversations/:id/attachments` waits ≤ 5 s for extraction; done in time → `201 ready`, else → `202 processing` + `jobs` row, client polls `GET /api/attachments/:id`.

---

### M4.3 — Anthropic Claude Cloud Container & Agent Skills Adapter

#### Provider Configuration & Skills Attachment
In `src/providers/infrastructure/adapters/anthropic/`:
- When the model registry enables document generation (`capabilities.documentGeneration`, or `model.config.container`), attach the `code_execution` tool and `container.skills` from `model.config.containerSkills`: clients do not toggle skills per request.
  ```json
  {
    "model": "claude-sonnet-4-6",
    "max_tokens": 4096,
    "tools": [
      {
        "type": "code_execution_20250825",
        "name": "code_execution"
      }
    ],
    "container": {
      "skills": [
        { "type": "anthropic", "skill_id": "pdf", "version": "latest" },
        { "type": "anthropic", "skill_id": "docx", "version": "latest" },
        { "type": "anthropic", "skill_id": "xlsx", "version": "latest" },
        { "type": "anthropic", "skill_id": "pptx", "version": "latest" }
      ]
    }
  }
  ```

#### Multi-Turn Container State Reuse
> **Not implemented yet.** The adapter accepts `container.id` and reports the rolling `expires_at`, but
> nothing persists the id: `generation_jobs.context_info` never records it, so each turn starts a fresh
> container. Tracked as the open half of M4.3 in `docs/IMPLEMENTATION_PLAN.md`.

1. **Container Tracking:** The Anthropic response contains:
   ```json
   "container": {
     "id": "cntr_01AbCdEfGhIjKlMnOpQrStUv",
     "expires_at": "2026-11-15T12:00:00Z"
   }
   ```
2. **Persistence:** The orchestrator records `container.id` inside `generation_jobs.context_info` and associates it with the conversation.
3. **Follow-Up Request:** On the next user message in that conversation, the adapter checks if the container is within its 30-day lifetime and passes:
   ```json
   "container": {
     "id": "cntr_01AbCdEfGhIjKlMnOpQrStUv",
     "skills": [...]
   }
   ```
   This restores the container sandbox with all existing files, variables, and history intact.

#### Input Document Forwarding
When a user uploads a dataset (e.g., `data.csv`) and asks Claude to generate an Excel spreadsheet:
1. Backend reads the file stream from `LocalStorageProvider`.
2. Calls Anthropic Files API:
   `POST https://api.anthropic.com/v1/files` (multipart `file=@data.csv`).
3. Obtains Anthropic `file_id` (e.g., `file_011CNha8iCJcU1wXNR6q4V8w`).
4. Injects a `container_upload` content block in the user message turn:
   ```json
   {
     "role": "user",
     "content": [
       { "type": "text", "text": "Analyze this data and create an executive summary in docx and xlsx" },
       { "type": "container_upload", "file_id": "file_011CNha8iCJcU1wXNR6q4V8w" }
     ]
   }
   ```
5. Caches the Anthropic `file_id` in `attachments.metadata` so subsequent turns in the same conversation do not re-upload the same file.

#### Capturing & Hydrating Generated Files
1. **Output Directory Capture:** Claude copies generated documents to `$OUTPUT_DIR`.
2. **Tool Result Extraction:** Anthropic returns a `bash_code_execution_tool_result` where `content` contains `bash_code_execution_output` with `file_id`:
   ```json
   {
     "type": "bash_code_execution_tool_result",
     "tool_use_id": "srvtoolu_01B3C4D5...",
     "content": {
       "type": "bash_code_execution_result",
       "stdout": "Report generated successfully.\n",
       "content": [
         { "file_id": "file_018XyZ..." }
       ]
     }
   }
   ```
3. **Hydration via Files API:**
   - Fetch metadata: `GET https://api.anthropic.com/v1/files/{file_id}` (retrieves `filename`, `size_bytes`).
   - Download binary: `GET https://api.anthropic.com/v1/files/{file_id}/content`.
   - Hand off stream to `ArtifactSink`.

#### Handling `pause_turn` Stop Reason
If Claude executes a long multi-step script or simulation, Anthropic may return `stop_reason: "pause_turn"`.
- The orchestrator runner intercepts `pause_turn`.
- Appends the intermediate assistant response to message history.
- Immediately sends a continuation request in the same container with empty prompt, allowing Claude to finish its execution without client intervention (bounded by a safety limit of ≤ 10 iterations).

---

### M4.4 — OpenAI Hosted Container & Built-in Skills Adapter

> **Status: implemented** in `src/providers/infrastructure/adapters/openai/adapter.ts`. The
> request/tool shapes below were corrected against the official docs + the shipped `openai`
> SDK types (v7) while implementing; the original sketch had two assumptions that do not hold:
> skills attach to the **shell** container only, and generated container files are downloaded
> through the **container** files API, not the global Files API.

#### Responses API Built-in Tools Configuration
Container turns go to `/v1/responses`; every other turn stays on Chat Completions, so ordinary
chat is unaffected. A provider that fronts OpenAI with Chat Completions only can opt out with
`config.useChatCompletions = true`.

One sandbox per request — declaring `code_interpreter` *and* `shell` with separate auto
containers would hand the model two sandboxes that cannot see each other's files:

- **Code execution only** (`container.codeExecution`, no skills):
  ```json
  { "tools": [{ "type": "code_interpreter", "container": { "type": "auto", "file_ids": ["file-…"] } }],
    "include": ["code_interpreter_call.outputs"] }
  ```
  With `container.containerId` set, the id string is passed instead of the auto object.
- **Document generation** (`container.skills` non-empty) — skills exist only on the hosted
  shell container:
  ```json
  { "tools": [{ "type": "shell", "environment": { "type": "container_auto",
      "file_ids": ["file-…"],
      "skills": [{ "type": "skill_reference", "skill_id": "openai-spreadsheets", "version": "latest" }] } }] }
  ```
  With `container.containerId` set, `environment` becomes
  `{ "type": "container_reference", "container_id": "cntr_…" }`.

`openai-spreadsheets` is the only curated skill id documented by name, so it is the only default
mapping (`xlsx`). A registry pins the rest explicitly with
`model.config.openaiSkills: string[] | {id, version}[]`; unmapped PAL skills simply run on the
shell's own toolchain (Python 3.11 / Node 22 preinstalled). The system prompt gains a hard
instruction to write artifacts under `/mnt/data`, the documented path for user-downloadable
artifacts. `store: false` is the default so generated content is not retained by the provider
(`model.config.storeResponses = true` opts in).

#### Input File Mounting
- Binaries are uploaded to `POST https://api.openai.com/v1/files` with `purpose: "user_data"`
  (the flexible Responses API purpose; this SDK version's `FilePurpose` union has no
  `responses` value).
- The returned `file_id`s become `container_auto.file_ids` (or `code_interpreter.container.file_ids`).
- Documents the platform already has text for can also be sent inline as `input_file` with
  `file_data: "data:<mime>;base64,…"` — the Responses API accepts PDF **and** Office formats,
  unlike Chat Completions (PDF only).

#### Capturing Generated Files
Two sources, both emitted as PAL `artifact_emitted` before `finished`:
- `response.output_text.annotation.added` with `container_file_citation`
  (`container_id`, `file_id`, `filename`) — the code-interpreter path.
- The container files API for anything the model wrote but never cited — the hosted shell's
  documented retrieval path ("use the same container/files APIs as code interpreter"):
  `GET /v1/containers/{container_id}/files` → filter `source: "assistant"`.

Because a container file needs **two** ids, the adapter packs them into one opaque handle
(`container:<container_id>:<file_id>`) and unpacks it in `fetchArtifactStream`, which downloads
`GET /v1/containers/{container_id}/files/{file_id}/content`. The `ArtifactSink` then stores the
bytes, re-measures/re-hashes them, and links the attachment to the part.

#### Compaction
Deferred: the adapter does not use `/v1/responses/compact` or `context_management`. Container
turns are bounded by `max_output_tokens` and the orchestrator's generation timeout; context
growth is handled by the existing context builder.

---

### M4.5 — PAL Orchestration, ArtifactSink & Multi-Part SSE Streaming

#### PAL Normalization
Extend `src/providers/domain/pal.ts` and `src/orchestrator/events.ts` to support tool and artifact events:

```ts
export type GenerationEvent =
  | { readonly type: 'started'; readonly providerRequestId?: string }
  | { readonly type: 'tool_started'; readonly toolCallId: string; readonly name: string; readonly input?: unknown }
  | { readonly type: 'tool_delta'; readonly toolCallId: string; readonly delta: string }
  | { readonly type: 'tool_completed'; readonly toolCallId: string; readonly output?: unknown; readonly fileIds?: string[] }
  | { readonly type: 'artifact_emitted'; readonly providerFileId: string; readonly filename: string; readonly mimeType?: string; readonly sizeBytes?: number }
  | { readonly type: 'part_started'; readonly index: number; readonly partType: 'text' | 'image' | 'file'; readonly mimeType?: string; readonly name?: string }
  | { readonly type: 'text_delta'; readonly index: number; readonly text: string }
  | { readonly type: 'part_done'; readonly index: number; readonly fileId?: string }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly final: boolean }
  | { readonly type: 'finished'; readonly reason: 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other' }
  | { readonly type: 'error'; readonly error: ProviderError };
```

#### SSE Wire Protocol Expansion (`docs/API_CONTRACTS.md`)
Clients receive real-time visibility into cloud container actions:

```
event: tool.started
data: {"partId":"part_1","tool":"bash_code_execution","command":"python make_chart.py"}

event: tool.delta
data: {"partId":"part_1","delta":"Processing 1,500 rows...\nGenerating matplotlib plot...\n"}

event: tool.completed
data: {"partId":"part_1","status":"success","exitCode":0}

event: part.started
data: {"partId":"part_2","position":1,"type":"file","name":"quarterly_report.docx","mimeType":"application/vnd.openxmlformats-officedocument.wordprocessingml.document"}

event: part.completed
data: {"partId":"part_2","status":"complete","fileId":"0192e4ab-...","downloadUrl":"/api/files/0192e4ab-.../content"}
```

#### ArtifactSink Implementation (`src/artifactsink/`)
The `ArtifactSink` operates under the strict rule: **persist before expose**.
1. Receives `artifact_emitted` with `providerFileId`.
2. Calls adapter's `fetchArtifactStream(providerFileId)`.
3. Streams bytes into `StorageProvider.putStream(storageKey, stream, mimeType)`.
4. Computes SHA-256 and verified size.
5. In the final settlement transaction (T2):
   - Inserts row in `attachments` (`origin = 'generated'`, `status = 'ready'`, `expires_at = now() + 30 days`).
   - Updates `message_parts` row with `file_id = attachments.id`, `status = 'complete'`.
6. Emits `part.completed` with `downloadUrl: '/api/files/' + attachments.id + '/content'`.

---

### M4.6 — File Retention, Cleanup & Third Adapter (Gemini)

#### Lifecycle & Retention Jobs
Three automated background jobs maintain storage integrity:
1. **`files.expire_and_delete` (Hourly):**
   - Finds rows in `attachments` where `expires_at <= now()` and `status NOT IN ('expired', 'deleted')` and `pinned_at IS NULL`.
   - Step 1: Sets `status = 'expired'`.
   - Step 2: Deletes binary file via `StorageProvider.delete(storage_key)`.
   - Step 3: Sets `status = 'deleted'`.
   - `file_extractions` text is retained so old conversation context remains intelligible.
2. **`files.orphan_reaper` (Hourly):**
   - Finds unattached uploads (`message_id IS NULL`) older than 1 hour.
   - Deletes binary and marks row `deleted`.
3. **`storage.reconcile` (Weekly):**
   - Scans `/var/lib/ai-chat/files` and compares against active DB `storage_key`s.
   - Deletes orphaned blobs missing from DB.
   - Logs warning if DB references a missing blob on disk.

#### Third Adapter: Google Gemini
- Implements `ProviderAdapter` in `src/providers/adapters/gemini/`.
- Validates the PAL abstraction: adding Gemini requires **zero changes** to `orchestrator/` or core domains.
- Maps PAL requests to Gemini 1.5/2.0 API:
  - Multimodal inputs: images, audio, PDF.
  - Native tools: Google Search grounding and Gemini native code execution.

---

## 4. Comprehensive Edge Cases, Failure Modes & Mitigations

The following matrix documents potential failure modes in Phase 4 and the mandated architectural mitigation for each:

| # | Domain / Area | Edge Case / Potential Issue | Risk / Impact | Mandated Architectural Mitigation |
|---|---|---|---|---|
| **1** | **Anthropic Container** | Claude generates a file but saves it to `/tmp/report.pdf` instead of `$OUTPUT_DIR/report.pdf`. | Anthropic Files API captures nothing; no `file_id` is emitted in tool results; file is lost. | **Prompt Engineering & Adapter Guard:** Adapter appends a strict system addendum when container skills are active: *"CRITICAL: Always copy or save all generated files (PDF, DOCX, XLSX, PPTX, images) directly into the directory specified by `$OUTPUT_DIR` so they can be captured."* |
| **2** | **Anthropic Container** | Stale or expired `container.id` (older than 30 days or evicted by provider). | Follow-up generation fails with `invalid_request_error: container_expired`. | **Graceful Container Fallback:** If Anthropic returns an error indicating container expiration or not found, the adapter automatically strips `container.id`, initializes a fresh container, re-attaches active skill definitions, and retries the turn. |
| **3** | **Anthropic Container** | Execution enters multi-turn pause (`stop_reason = 'pause_turn'`) or loops infinitely. | Generation stalls mid-stream or runs up excessive execution tokens. | **Bounded Continuation Loop:** Orchestrator runner catches `pause_turn` and automatically calls continuation turn in the same container up to a hard cap of `MAX_PAUSE_TURNS = 8`. If exceeded, terminates with `stop_reason: 'interrupted'` and returns partial outputs. |
| **4** | **Artifact Hydration** | Network failure or rate limit (`429`) when calling Provider Files API during `ArtifactSink` download. | User prompt succeeded, but binary download fails; streaming hangs. | **Retry with Exponential Backoff & Circuit Breaker:** `ArtifactSink` retries provider file downloads up to 3 times (1s, 2s, 4s backoff). If permanently failed, part is marked `status = 'failed'` with `error_code = 'file_download_failed'`, generated text is preserved, and tokens actually used are settled normally. |
| **5** | **File Uploads** | Malicious polyglot file (e.g. valid JPEG image header containing executable PHP/JS or HTML payload). | Stored XSS if client browser renders file directly; security vulnerability. | **MIME Sniffing + Forced Download Headers:** Server verifies magic bytes and serves all files with `X-Content-Type-Options: nosniff`. Any document or untrusted file is served with `Content-Disposition: attachment`. Images are verified via dimension probing and stripped of metadata. |
| **6** | **File Uploads** | Decompression bomb / zip bomb in `.docx` or `.xlsx` (e.g. 100 KB zip inflating to 50 GB). | VPS memory exhaustion or disk filling during extraction. | **Zip Pre-Inspection Limits:** Before extracting XML from OOXML zip archives: max entries ≤ 2,000; max uncompressed size ≤ 100 MB; max compression ratio ≤ 100:1. Abort immediately if any limit is exceeded. |
| **7** | **File Uploads** | Pixel bomb image (e.g. 100,000 × 100,000 px monochrome PNG with tiny file size). | Memory spike during image dimension probing. | **Stream-Based Header Sniffing:** Do not decode full image raster into memory. Read only the first 24–64 bytes to inspect the IHDR / SOF0 metadata markers. Reject if width × height > 40 megapixels (e.g. 8000×8000). |
| **8** | **File Uploads** | Macro-enabled Office files (`.docm`, `.xlsm`) containing malicious VBA scripts. | Malware execution on end-user machines downloading the file. | **Strict Extension & MIME Blacklist:** Explicitly reject `.docm`, `.xlsm`, `.dotm`. Inspect zip archive contents and reject if `word/vbaProject.bin` or `xl/vbaProject.bin` is present. |
| **9** | **Local Storage** | Host VPS disk space approaches capacity (> 80% full). | Systemd service crashes, PostgreSQL fails to write WAL, outage. | **Proactive Disk Gate & Emergency Reaper:** `LocalStorageProvider` checks available disk space before accepting uploads. If disk usage > 85%, reject new uploads with `507 Insufficient Storage`. Run emergency purge of unattached orphans and expired files. Alert via Prometheus metric `storage_disk_free_bytes`. |
| **10** | **Local Storage** | Path traversal attempt in file retrieval (e.g. `GET /api/files/..%2F..%2Fetc%2Fpasswd/content`). | Arbitrary host file read vulnerability. | **Opaque Internal Keys:** The HTTP route accepts only UUIDv7 (`/api/files/:id/content`). The database `storage_key` is generated server-side. The file system path is constructed using strict directory normalization (`path.resolve`) and asserts `filePath.startsWith(STORAGE_LOCAL_ROOT)`. |
| **11** | **Quota Accounting** | Tool execution and code output generate far more output tokens than estimated in initial reservation. | User exceeds monthly token quota (account overdraft). | **Safety Margin + Dynamic Overshoot Settlement:** Reservations for requests with container tools include an additional tool buffer (e.g., +4,000 tokens). Settlement (T2) calculates exact token usage from provider response and records `overshoot_tokens = MAX(0, actual - reserved)`, adjusting balances cleanly without rolling back completed generations. |
| **12** | **SSE Streaming** | Client disconnects mid-generation while Claude is running code execution in container. | Orphaned background provider call; wasted spend and tokens. | **Detached Stream Reaper (A-12):** When client SSE connection drops, orchestrator allows a 60-second grace period for reconnect via `Last-Event-ID`. If no subscriber reconnects after 60 seconds, trigger `AbortController.abort()`, finalize partial generation, and settle quota for tokens used up to abort. |
| **13** | **Multi-Turn State** | User uploads 5 large CSVs in turn 1; turn 2 and turn 3 repeat the request. | Re-uploading 5 files to Anthropic Files API on every turn wastes bandwidth and hits provider upload rate limits. | **Provider File ID Caching:** The Anthropic `provider_file_id` is cached in `attachments.metadata->'anthropic_file_id'`. On subsequent turns, the adapter reuses the existing provider file ID instead of re-uploading from local disk. |
| **14** | **Content Credentials** | C2PA Content Credentials added by Anthropic modify generated image bytes. | Downloaded image SHA-256 and size differ from internal container checksums. | **Post-Download Integrity Verification:** `ArtifactSink` computes SHA-256 and byte length on the **downloaded stream**, not on provider pre-transfer estimates. Database records reflect the exact bytes stored locally. |
| **15** | **File Serving** | User requests streaming playback of a 20 MB generated audio/video or large PDF via `GET /api/files/:id/content`. | Browser cannot scrub or page through document; buffering entire file stalls client. | **HTTP Byte-Range Serving:** `GET /api/files/:id/content` implements RFC 7233 byte-range serving (`Accept-Ranges: bytes`, `206 Partial Content`). Streams slice directly from disk via Bun file slice. |

---

## 5. Step-by-Step Execution Plan

### Step 1: Database & Storage Foundations (Days 1–3)
1. Write and run migration `0011_attachments_and_files.sql`.
2. Implement `StorageProviderPort` and `LocalStorageProvider` with atomic temp-file writes and SHA-256 computation.
3. Write comprehensive unit tests for `LocalStorageProvider` (traversal rejection, atomic rename, range streaming).
4. Implement `GET /api/files/:id/content` with ownership verification and byte-range support.

### Step 2: Upload Validation & Text Extraction (Days 4–6)
1. Build upload validation pipeline in `src/attachments/application/upload-service.ts`:
   - Magic-byte detection (PNG, JPEG, WebP, GIF, PDF, DOCX, XLSX).
   - Dimension sniffing for images (max 8000×8000).
   - Zip-bomb and macro detection for OOXML.
2. Implement local text extractors (text/markdown, bounded CSV, basic PDF and DOCX text extraction).
3. Implement `POST /api/conversations/:id/attachments` with 5-second fast-path.
4. Add unit and integration tests with test fixtures (valid images, corrupted images, zip-bombs, macro docs).

### Step 3: Anthropic Container & Skills Integration (Days 7–9)
1. Update `src/providers/adapters/anthropic/`:
   - Add `code_execution_20250825` tool injection.
   - Add `container.skills` configuration (`pdf`, `docx`, `xlsx`, `pptx`).
   - Implement Anthropic Files API uploader (`container_upload` block) with provider file ID caching.
   - Implement `container.id` extraction and multi-turn request replay.
   - Implement `pause_turn` handling in execution loop.
2. Update parser to intercept `bash_code_execution_tool_result` output blocks with generated `file_id`s.
3. Contract tests using recorded Anthropic fixtures for tool calls and file generation.

### Step 4: OpenAI Container & Skills Integration (Days 10–11)
1. Update `src/providers/adapters/openai/` for Responses API:
   - Configure `code_interpreter`, `shell` with `container_auto`, and `image_generation`.
   - Implement OpenAI Files API upload for input files.
   - Intercept generated file citations/outputs.
2. Contract tests using recorded OpenAI Responses API fixtures.

### Step 5: ArtifactSink & Multi-Part SSE Orchestration (Days 12–13)
1. Implement `ArtifactSink` in `src/artifactsink/`:
   - Downloads binary streams from provider Files APIs.
   - Stores to `LocalStorageProvider`.
   - Inserts `attachments` record (`origin = 'generated'`) and links `message_parts`.
2. Extend orchestrator stream loop to emit `tool.started`, `tool.delta`, `tool.completed`, `part.completed`.
3. Verify T2 finalization transaction handles tool tokens and generated parts atomically.

### Step 6: Cleanup Jobs & Third Adapter (Gemini) (Days 14–15)
1. Implement background maintenance jobs in `src/jobs/handlers/`:
   - `files.expire_and_delete` (two-phase TTL).
   - `files.orphan_reaper`.
   - `storage.reconcile`.
2. Implement Google Gemini adapter in `src/providers/adapters/gemini/` supporting multimodal input and native tools.
3. Run end-to-end integration suite and execute live smoke tests (`bun run cli smoke-live --provider <anthropic|openai>`).

---

## 6. Definition of Done (Phase 4 Exit Gate)

Phase 4 is complete when all of the following criteria are met:
1. **Typecheck & Lint:** `bun run typecheck` and `bun run lint` pass cleanly with zero warnings or `any` leaks.
2. **Hardening Tests Green:** Malicious MIME spoofing, zip-bombs, macro-enabled documents, and encrypted PDFs are rejected with standard error envelopes.
3. **Cloud Container Document Generation Verified:**
   - A prompt to Claude asking to generate an Excel spreadsheet and a Word document produces downloadable `.xlsx` and `.docx` files.
   - Files are automatically hydrated to `/var/lib/ai-chat/files` by `ArtifactSink` and served via `/api/files/:id/content`.
4. **Multi-Turn Container State Continuity Verified:**
   - Follow-up turn modifying a generated document successfully reuses `container.id`.
5. **No Docker on Host:** Confirmed that the VPS runs purely on Bun and PostgreSQL, with zero local container runtimes.
6. **Gemini Adapter Functional:** Third adapter is registered and operational with zero core orchestrator changes.
7. **Retention Tested:** Expired attachments have binaries deleted on schedule while metadata and text extractions are preserved.
