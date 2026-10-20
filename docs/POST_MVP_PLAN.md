# POST_MVP_PLAN.md — Post-MVP Engineering Roadmap (Phases 1–3)

> **Document version:** 1.0  
> **Source of truth:** [`docs/PRD.md`](PRD.md), [`AGENTS.md`](../AGENTS.md), and [`docs/API_CONTRACTS.md`](API_CONTRACTS.md).  
> **Scope boundary:** Covers all features beyond the MVP launch. Built-in provider tools (web search, web fetch, cloud code execution, container skills, and image/doc generation) are already included in the MVP (Phase 4).  
> **Explicit exclusion:** Conversation forking (`POST /conversations/:id/fork`) is **omitted** per product requirements.

---

## 1. Architectural Strategy & Extension Points

Every post-MVP capability attaches cleanly to extension points already designed into the MVP schema and modular monolith architecture (`AGENTS.md` §3):

| Post-MVP Capability | Extension Point Established in MVP | Seam / Port Used |
|---|---|---|
| **Division Model Visibility** | `quota_policies.allowed_model_ids`, `users.division_id` | `GET /api/models` query layer |
| **Circuit Breaker** | `ai_providers.status`, `error_events` table | `providers/circuit-breaker.ts` wrapping `ProviderPort` |
| **RLS Hardening** | `current_setting('app.user_id')` | `db/withTransaction.ts` session config |
| **ClamAV Antivirus** | `attachments.status = 'validating'` | Pipeline hook in `attachments/application/attachment-service.ts` |
| **Object Storage (S3 / R2)** | `attachments.storage_provider`, `storage_key` | `StorageProviderPort` (`storage/s3`) |
| **SSO / OIDC (Entra ID, Okta)** | `users.idp_subject` (indexed partial unique) | `auth/ports/AuthProviderPort` behind session middleware |
| **Quota Threshold Warnings** | `quota_accounts` counter state + `jobs` outbox | `jobs/handlers/quota-alert.ts` worker |
| **OCR Pipeline** | `file_extractions` table (`status`, `extractor`) | `FileService` worker job |
| **Multi-Node SSE Relay** | Monotonic event IDs, `generation_jobs.runner_id` | `orchestrator/relay/redis-relay.ts` |
| **Multi-Tenant Workspaces** | Clean modular boundaries, single-tenant by default | Additive `organizations` table + RLS policy |

---

# Phase 1: Operational Resilience, Governance & Security

**Goal:** Harden operational stability, prevent cascading provider outages, enforce granular organizational visibility, and add defense-in-depth database security.

---

### 1.1 Division-Scoped Model Access

* **Objective:** Allow administrators to restrict specific high-cost or reasoning models (e.g., Opus, o1/o3) to designated divisions (e.g., Data Science, Engineering) while keeping standard models available company-wide.
* **Mechanism:**
  - Evaluates `quota_policies.allowed_model_ids` for the user's `division_id`.
  - When resolved policy has `allowed_model_ids IS NOT NULL`, `GET /api/models` filters results to `id = ANY(allowed_model_ids)`.
  - In `POST /api/conversations`, validates that the requested `model_id` is permitted for the authenticated user's division, returning `403 model_forbidden_for_division` if restricted.
* **Database & Interfaces:**
  - Uses existing `quota_policies` and `divisions` tables.
  - Adds index `CREATE INDEX idx_quota_policies_division ON quota_policies(division_id) WHERE scope = 'division'`.

---

### 1.2 Provider Circuit Breakers & Auto-Mitigation

* **Objective:** Prevent request pile-ups, thread pool exhaustion, and user wait-time degradation during upstream LLM outages (OpenAI, Anthropic, or Google 5xx / 429 surges).
* **Circuit State Machine:**
  - `CLOSED` (Normal): Requests pass through to the provider adapter.
  - `OPEN` (Tripped): Fails immediately with `503 provider_unavailable` (with `Retry-After`) without making upstream HTTP calls. Tripped when rolling error rate exceeds 50% over a 30-second window (minimum 10 requests).
  - `HALF-OPEN` (Probing): After a configurable cool-off (default 30 seconds), allows 3 trial requests. If all 3 succeed, transitions back to `CLOSED`; if any fail, resets cool-off in `OPEN`.
* **Implementation Details:**
  - Implemented in `src/providers/circuit-breaker.ts` implementing `ProviderPort`.
  - Trips write an entry to `error_events` (`category: 'circuit_breaker_tripped'`).
  - Logs circuit state transitions in structured Winston JSON logs and records an entry in `error_events`.

---

### 1.3 Provider Health & Latency Dashboard

* **Objective:** Provide internal ops and super admins with real-time insight into upstream provider performance.
* **API Endpoints:**
  - `GET /api/admin/providers/health`: Requires `role=super_admin`. Returns rolling 5-minute stats per provider:
    ```json
    {
      "status": "ok",
      "data": [
        {
          "providerKey": "anthropic",
          "circuitState": "closed",
          "successRate": 0.994,
          "p50LatencyMs": 420,
          "p95LatencyMs": 1850,
          "concurrency": 24,
          "maxConcurrency": 100
        }
      ]
    }
    ```
* **Implementation:** Read directly from rolling in-process window and `error_events`.

---

### 1.4 Admin Error Explorer & CSV Usage Exports

* **Objective:** Enable IT and finance super admins to inspect operational errors and export granular usage logs.
* **Endpoints:**
  - `GET /api/admin/errors`: Requires `role=super_admin`. Keyset-paginated search over `error_events` (filters: `category`, `providerId`, `modelId`, date range). Sensitive headers and body contents remain completely redacted.
  - `GET /api/admin/usage/export`: Requires `role=super_admin`. Streamed CSV generation from `usage_events` and `usage_daily` with standard columns (`date,user_email,division,provider,model,input_tokens,output_tokens,quota_tokens,cost_usd`).

---

### 1.5 ClamAV Antivirus Pipeline for File Uploads

* **Objective:** Ensure uploaded files (documents, images, archives) are free of malware before being exposed to parsers or other employees.
* **Execution:**
  - During the upload pipeline (`attachments/application/attachment-service.ts`), files enter `status = 'validating'`.
  - Dispatches scan stream via Unix domain socket `/var/run/clamav/clamd.ctl` (or clamd TCP socket `localhost:3310`).
  - Scan timeout: 5.0 seconds. If clean, transitions to `status = 'ready'`.
  - If malware signature matches: immediately deletes binary from storage, sets `status = 'rejected'`, sets `error_code = 'virus_detected'`, and logs to `audit_logs`.

---

### 1.6 Database Row-Level Security (RLS) Defense-in-Depth

* **Objective:** Guarantee that even if an application SQL query omitted a `user_id` predicate, PostgreSQL itself blocks cross-user data leakage.
* **Implementation:**
  - Enable RLS on user-owned tables:
    ```sql
    ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
    ALTER TABLE message_parts ENABLE ROW LEVEL SECURITY;
    ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

    CREATE POLICY conversations_owner_isolation ON conversations
      USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
    ```
  - In `db/withTransaction.ts`, set session setting automatically from `AuthContext`:
    ```typescript
    await tx.execute(sql`SET LOCAL app.user_id = ${auth.userId}`);
    ```

---

# Phase 2: Enterprise Identity, Storage & Alerting

**Goal:** Enable native corporate Single Sign-On (SSO), automated directory provisioning, migrate blob storage to high-durability cloud object storage, and configure automated quota threshold alerting.

---

### 2.1 Enterprise SSO / OIDC (Entra ID, Google Workspace, Okta)

* **Objective:** Enable passwordless corporate authentication via standard OpenID Connect (OIDC).
* **Architecture:**
  - New endpoints:
    - `GET /api/auth/oidc/login`: Generates PKCE code challenge and signed `state` cookie, redirects to Identity Provider (IdP).
    - `GET /api/auth/oidc/callback`: Validates `state`, exchanges authorization code for tokens, verifies ID token signature (JWKS).
  - Matches `sub` claim against `users.idp_subject`. If match found and `user.status == 'active'`, mints standard `__Host-session` cookie.
  - If `idp_subject` does not exist but email matches an existing active user, links `idp_subject` (subject to admin policy `AUTO_LINK_EMAIL=true`).
* **Session Persistence:** Uses the exact same stateful PostgreSQL `sessions` table—revocation and idle-time semantics remain identical.

---

### 2.2 SCIM 2.0 User & Division Directory Sync

* **Objective:** Automatically provision new employees, assign divisions, and disable departing employees in real time from Azure AD / Okta.
* **Standard Endpoints:**
  - `GET /scim/v2/Users`: Keyset pagination over active users.
  - `POST /scim/v2/Users`: Admin-level automated creation (sets `role = 'user'`, generates random password hash, sets `idp_subject`).
  - `PATCH /scim/v2/Users/:id`: Toggles `status = 'disabled'` when deactivated in corporate directory (instantly revoking all active sessions).
  - `GET /scim/v2/Groups`: Maps corporate AD security groups to internal `divisions`.

---

### 2.3 Multi-Factor Authentication (TOTP / MFA)

* **Objective:** Provide second-factor protection for local password-authenticated accounts.
* **Workflow:**
  - `POST /api/auth/mfa/setup`: Generates RFC 6238 TOTP secret, returns QR code data URI, encrypts secret in user record.
  - `POST /api/auth/mfa/verify`: Validates 6-digit TOTP token; issues recovery codes.
  - Login middleware flow: Valid email/password credentials set an intermediate `mfa_pending` session token (TTL: 5 minutes, restricted to MFA verification endpoint only). Successful TOTP exchange upgrades the cookie to a full session.

---

### 2.4 S3 / Object Storage Migration

* **Objective:** Seamlessly transition binary attachment storage from VPS local disk (`/var/lib/ai-chat/files`) to high-durability object storage (Amazon S3, Cloudflare R2, MinIO, or Google Cloud Storage).
* **Implementation:**
  - Create `src/storage/s3/s3-storage-provider.ts` implementing `StorageProviderPort`:
    ```typescript
    export class S3StorageProvider implements StorageProviderPort {
      async put(key: string, stream: ReadableStream, meta: StorageMetadata): Promise<void>;
      async get(key: string): Promise<ReadableStream>;
      async delete(key: string): Promise<void>;
      async exists(key: string): Promise<boolean>;
    }
    ```
  - **Zero-Downtime Migration Strategy:**
    1. Update environment to write new files to S3 (`STORAGE_DEFAULT_PROVIDER=s3`).
    2. Read path resolves provider via `attachments.storage_provider` column per row:
       - Old rows (`storage_provider = 'local'`) read from disk.
       - New rows (`storage_provider = 's3'`) read from S3.
    3. Run background migration job `jobs/handlers/storage-migrate.ts` to copy local files to S3 and update row to `storage_provider = 's3'`.
    4. Once all rows are migrated, decommission local storage volume.

---

### 2.5 Automated Quota Warning Alerts & Webhooks

* **Objective:** Warn users and division managers before their monthly quota hits hard exhaustion, avoiding work interruptions.
* **Mechanism:**
  - When `quota/settle` commits a token delta, it checks remaining tokens against the limit:
    - Crossing **80% threshold**: Enqueues job `quota.alert` with `{ userId, threshold: 80 }` (deduplicated per period).
    - Crossing **100% threshold**: Enqueues job `quota.alert` with `{ userId, threshold: 100 }`.
  - Job runner dispatches notification via configured transport:
    - Corporate Email (SMTP).
    - Corporate Webhook (Slack / Microsoft Teams incoming webhook).

---

### 2.6 Scanned Document OCR Extraction Pipeline

* **Objective:** Extract searchable text from scanned image-only PDFs and raw camera uploads so that document context can be indexed and preserved in long conversations.
* **Implementation:**
  - In `attachments/application/text-extraction.ts`: if PDF contains zero extractable text streams (pure scanned images), dispatches to the OCR worker.
  - Worker runs Tesseract OCR or OCR microservice with a 30-second cap.
  - Inserts extracted text into `file_extractions` (`extractor = 'tesseract'`, `truncated = boolean`).
  - Text survives binary TTL expiry (`RETAIN_EXTRACTIONS = true`), allowing conversations to recall scanned document content indefinitely.

---

# Phase 3: Distributed Scale & Multi-Tenant Infrastructure

**Goal:** Scale the backend across multiple stateless API nodes behind a load balancer, distribute real-time SSE streams via Redis, implement multi-tenant workspace isolation, and provide enterprise SIEM audit streaming.

---

### 3.1 Multi-Node Scale-Out with Redis Stream Relay

* **Objective:** Remove single-node in-process stream coupling (PRD A-4) so any API node in a cluster can stream an active generation to any reconnecting client.
* **Architecture:**
  ```text
  Client (SSE) ──► API Node B ──► Redis Channel / Stream (sub)
                                        ▲
                                        │ (publishes event deltas)
  Provider API ──► API Node A (Runner) ─┘
  ```
* **Event Pipeline:**
  - Node A (the generation runner) writes chunks to Redis Stream `gen:{generationId}:events`.
  - Node B (handling `GET /api/generations/:id/stream`) attaches to the Redis stream at `Last-Event-ID`.
  - Redis keeps a rolling 120-second buffer of stream deltas. If a client drops and reconnects to a different server instance, the stream continues smoothly without dropped tokens.

---

### 3.2 Distributed Redis Rate Limiting & Concurrency Control

* **Objective:** Enforce global concurrency limits (e.g., max 150 concurrent generations) and rate limits across a cluster of API nodes.
* **Mechanism:**
  - Replaces in-memory token bucket with a Redis Sliding Window Lua script (`src/http/middleware/rate-limit.ts`).
  - Redis keys: `ratelimit:{ip}:{window}` and `ratelimit:user:{userId}:{window}`.
  - Maintains strict fallback: If Redis is unavailable, falls back to the in-memory limiter without interrupting request handling.

---

### 3.3 Multi-Tenant Workspaces (Organizations)

* **Objective:** Transition from single-tenant internal deployment to multi-organization SaaS or separate subsidiary entities.
* **Schema Evolution:**
  - Add `organizations` table:
    ```sql
    CREATE TABLE organizations (
      id         uuid PRIMARY KEY,
      name       text NOT NULL UNIQUE,
      slug       text NOT NULL UNIQUE,
      status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ```
  - Add `organization_id uuid NOT NULL REFERENCES organizations(id)` to `users`, `conversations`, `attachments`, `quota_policies`, and `quota_accounts`.
  - Extend database RLS policies to enforce `organization_id = current_setting('app.organization_id')::uuid`.

---

### 3.4 Rolling Summaries & Context Compaction Hook

* **Objective:** Allow conversation threads to continue indefinitely without running into model context limits or dropping earlier conversation requirements.
* **Context Builder Hook (`src/context-builder/compaction.ts`):**
  - When total estimated tokens exceed 75% of model context window:
  - Selects messages from turns $1 \dots (N - 6)$ (retaining the 6 most recent turns uncompressed).
  - Runs a background summary prompt using a fast model (e.g. Haiku / GPT-4o-mini).
  - Emits a compacted context representation containing `[System summary of previous turns]` followed by the recent uncompressed messages.
  - Stores summary in `conversations.metadata.rollingSummary`.

---

### 3.5 SIEM & Enterprise Audit Log Streaming

* **Objective:** Stream security and administrative mutations to corporate security information and event management (SIEM) systems (Splunk, Datadog, Elastic, AWS CloudWatch).
* **Implementation:**
  - PostgreSQL transaction commits to `audit_logs` write an event to the outbox queue (`jobs` with `type = 'audit.export'`).
  - Background worker batches audit entries and posts them over mTLS / HTTPS to the enterprise SIEM ingest endpoint.
  - Ensures audit tamper-evidence and regulatory retention compliance beyond standard PostgreSQL backup cycles.

---

# Summary Roadmap & Phasing Timeline

```text
POST-MVP PHASE 1: Operational Governance (Weeks 1–3 post-launch)
├── Division-Scoped Model Access (quota_policies.allowed_model_ids)
├── Provider Circuit Breakers & Auto-Mitigation (half-open probing)
├── Provider Health & Latency Dashboard
├── Admin Error Explorer & CSV Usage Streaming
├── ClamAV Antivirus Pipeline
└── Database RLS Hardening (app.user_id isolation)

POST-MVP PHASE 2: Enterprise Identity & Storage (Weeks 4–7 post-launch)
├── Enterprise OIDC SSO (Entra ID, Okta, Google) via users.idp_subject
├── SCIM 2.0 User & Division Directory Sync
├── Multi-Factor Authentication (TOTP / MFA)
├── S3 / Object Storage Migration (StorageProviderPort zero-downtime)
├── Automated Quota Threshold Alerts (80% / 100% email & webhooks)
└── Scanned Document OCR Extraction Pipeline (Tesseract / file_extractions)

POST-MVP PHASE 3: Distributed Scale & Multi-Tenancy (Weeks 8–12 post-launch)
├── Multi-Node API Scale-Out with Redis Stream Relay
├── Distributed Redis Rate Limiting & Global Concurrency Control
├── Multi-Tenant Organizations & Workspace Isolation
├── Rolling Summaries & Context Compaction
└── Enterprise SIEM Audit Log Streaming
```
