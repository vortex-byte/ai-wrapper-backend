# Internal Office AI Chat Platform — Backend PRD

| | |
|---|---|
| **Document status** | Draft v1.4 for engineering review |
| **Date** | 2026-10-20 |
| **Scope** | Backend (Hono / TypeScript / PostgreSQL). Frontend is out of scope except for API contracts. |
| **Audience** | Backend engineers, tech lead, security reviewer, product owner, platform/infra |

## How to read this document

- **Assumptions** are labeled **[A-n]** and collected below. Where the brief was ambiguous, an assumption was made and work continued. Each can be overridden; the affected sections are noted.
- Major architecture decisions are written as **Decision blocks** (`D-n`) with: *Why*, *Problem solved*, *Implementation*, *Trade-offs*, *Scale path*.
- Requirement IDs (`FR-*`, `NFR-*`) are stable references for tickets and tests.
- Priority: **P0** = MVP must-have, **P1** = MVP should-have (cut first if schedule slips), **P2** = post-MVP.
- Model names, prices, and limits shown in examples are **illustrative**. Real values live in the database (model registry), never in code **[A-11]**.
- **Revision v1.1** (2026-10-08): authentication is email + password with a server-backed session (no OIDC); provider API keys come from the environment/`.env` (no secret manager); the quota period timezone defaults to UTC+7. Open Questions **Q-1, Q-7, Q-8, Q-9 are closed**; **Q-2, Q-5, Q-11** updated; **Q-14** added.
- **Revision v1.2** (2026-10-08): the product owner **approved the documented default assumption for every remaining Open Question**, so **Q-2 through Q-14 are all closed**. No behavioural changes — the assumptions already described in §11, §12, §15 and elsewhere are now decisions. Section 28 is retained as a record of the resolution.
- **Revision v1.3** (2026-10-08): the API is **unversioned** (the `/api` prefix carries no version; the SPA and API deploy atomically) and every JSON response uses a **uniform envelope** — success `{status,message,data}` and error `{status,code,message,retryable,details,trace?}` (see `docs/API_CONTRACTS.md` §1). A stack `trace` is returned in error envelopes **only when `NODE_ENV=development`** and is never present in staging or production (§15.10).
- **Revision v1.4** (2026-10-20): administrative role hierarchy revamp. The former `admin` role is revamped into `super_admin` (system-wide administrator with full control over all divisions, users, quotas, models, providers, system settings, and audit logs). The `admin` role is repurposed as a **division administrator** (admin per division), strictly bound to a single division (`division_id NOT NULL`) and restricted to CRUD user operations solely for their assigned division.

## Assumptions register

| ID | Assumption | Affects |
|---|---|---|
| A-1 | Single organization (single tenant). Employees sign in with **locally managed email + password accounts** (A-15). "Workspaces" are not built; **divisions** (org units) are the grouping used for quota, model access, and delegated division administration (`admin`). Multi-tenant `organization_id` can be added later by migration. | §10, §11, §15, §17, §20 |
| A-2 | Scale target: ≤ 1,000 registered users, ≤ 150 concurrent generations at peak, ≤ 30 API req/s average. | §7, §23 |
| A-3 | Runtime is Bun.js LTS. One container image runs in `api`, `worker`, or `all` role. | §8, §24 |
| A-4 | MVP runs **one active API node** (plus a standby for rolling deploys) with a shared persistent volume for local files. Generations are owned by a single process. Horizontal scale-out of streaming needs sticky routing or a Redis stream relay (Phase 4). | §8, §14, §24 |
| A-5 | Quota period is the calendar month in a configurable timezone (**default UTC+7 / `Asia/Jakarta`**, configured by IANA name, not a fixed offset). No rollover of unused tokens in MVP. | §11 |
| A-6 | "Quota token" = (provider-reported input + output tokens) × `models.quota_weight` (default 1.0), rounded up. Reasoning/thinking tokens count as output. | §11 |
| A-7 | Retention defaults: unattached uploads 1 h; attached/generated binaries 30 days; conversations until user deletes (soft-delete 30 days, then purge); usage + ledger 24 months; audit logs 24 months; request logs 30 days. All configurable. | §12, §21 |
| A-8 | PostgreSQL 15+. Query layer Drizzle and Zod validation are recommendations, not requirements. | §8, §17 |
| A-9 | Image/document **generation** is post-MVP as a user feature, but persistence, streaming, and storage are designed so enabling it needs only adapter work. | §13, §14 |
| A-10 | A separate SPA is the only client and talks only to this API. | §16 |
| A-11 | Super Admins enter model IDs, capabilities, limits, and prices through the admin API/UI. Nothing is seeded in code except a documented example seed file. | §6, §17, §20 |
| A-12 | **Client-disconnect policy:** generation continues server-side after the SSE connection drops; if no subscriber re-attaches within a 60 s grace period, it is cancelled and partial output is persisted. Explicit user "Stop" cancels immediately. | §14, §19 |
| A-13 | Super Admins and Division Admins **cannot read conversation content or file contents** by default. Break-glass access is a post-MVP, separately approved capability. | §15, §20 |
| A-14 | Extracted document text is retained with the conversation after the binary expires, so long conversations keep working (flag `RETAIN_EXTRACTIONS=true`). Confirmed by Q-4 (closed, v1.2). | §12 |
| A-15 | Authentication is **email + password with a server-backed, stateful session stored in PostgreSQL** (no OIDC/SSO in MVP; MFA is out of scope). Accounts are created by Super Admins (any division/role) or Division Admins (strictly `user` role within assigned division); there is no self-registration. `users.idp_subject` is kept (nullable) so OIDC can be re-attached later without a migration. | §6, §15, §17, §20, §28 |
| A-16 | Provider API keys are supplied through the **process environment / `.env` secret file** (never stored in the database, never in code or images). `providers.secret_ref` holds the **environment variable name**, not the key. Rotation is an operator action — update the env/secret file and restart the process (rolling restart; no code deploy). No secret manager in MVP. | §9, §15, §20, §24 |

---

## Table of contents

1. [Executive Summary](#1-executive-summary)
2. [Product Vision](#2-product-vision)
3. [Goals and Non-Goals](#3-goals-and-non-goals)
4. [Target Users](#4-target-users)
5. [User Stories](#5-user-stories)
6. [Functional Requirements](#6-functional-requirements)
7. [Non-Functional Requirements](#7-non-functional-requirements)
8. [System Architecture](#8-system-architecture)
9. [Provider Abstraction Architecture](#9-provider-abstraction-architecture)
10. [Conversation and Message Model](#10-conversation-and-message-model)
11. [Token Quota and Usage Architecture](#11-token-quota-and-usage-architecture)
12. [File and Artifact Storage Architecture](#12-file-and-artifact-storage-architecture)
13. [AI Response Persistence Architecture](#13-ai-response-persistence-architecture)
14. [Streaming Architecture](#14-streaming-architecture)
15. [Security Architecture](#15-security-architecture)
16. [API Specification](#16-api-specification)
17. [PostgreSQL Data Model](#17-postgresql-data-model)
18. [Error Handling](#18-error-handling)
19. [Retry / Timeout / Cancellation](#19-retry--timeout--cancellation)
20. [Admin Requirements](#20-admin-requirements)
21. [Observability](#21-observability)
22. [Background Processing](#22-background-processing)
23. [Testing Strategy](#23-testing-strategy)
24. [Deployment Architecture](#24-deployment-architecture)
25. [Production Readiness Checklist](#25-production-readiness-checklist)
26. [MVP vs Future Scope](#26-mvp-vs-future-scope)
27. [Risks and Mitigations](#27-risks-and-mitigations)
28. [Open Questions](#28-open-questions)
29. [Recommended Implementation Phases](#29-recommended-implementation-phases)

---

## 1. Executive Summary

The platform is an internal chat application where employees converse with models from several AI providers (OpenAI, Anthropic, Google Gemini, others later) through one interface. The backend's job is **centralized control**: one place that holds provider credentials, enforces per-user token quotas, validates and stores uploads, persists conversations (including non-text responses), and records usage.

Three principles shape every design choice:

1. **Three separate concerns** — *conversation persistence* (PostgreSQL), *AI provider execution* (adapters), and *binary artifact storage* (StorageProvider). They communicate through narrow interfaces and never share formats.
2. **Quota correctness over throughput** — tokens are *reserved* atomically before any provider call, *settled* with actual usage afterward, and *released* on failure. Concurrency cannot push a user past their limit except for a small, bounded and measured estimation overshoot.
3. **Simplicity first** — PostgreSQL is the single source of truth and also backs the job queue. Redis is for caching data and rate limiting. No S3, no message broker, no agent framework in MVP. Every future capability has a defined extension point but no MVP implementation.

**Primary deliverable:** a reliable multi-provider chat backend with one-model-per-conversation, SSE streaming, multimodal message parts, temporary local file storage, token quotas with a usage ledger, an admin API, and production-grade observability and security.

## 2. Product Vision

> Give every employee one trusted place to use the best AI model for the task, while giving the company control over cost, data handling, and access.

For users it should feel like a modern AI chat app: pick a model, chat, attach files, watch answers stream in, come back to history. For the company it replaces scattered personal subscriptions and unmanaged API keys with a governed channel: every request is attributable, limited, and auditable.

**Why a unified bridge:** providers change APIs, models, and prices frequently. Isolating provider specifics behind adapters means the company can add, retire, or reprioritize models by configuration without touching chat logic or the frontend.

## 3. Goals and Non-Goals

### Goals

| # | Goal | Success measure |
|---|---|---|
| G1 | Familiar chat experience | Streaming first token overhead ≤ 300 ms added by platform |
| G2 | Multiple providers behind one interface | New provider added with only a new adapter + registry rows, zero changes to orchestrator/API/DB schema |
| G3 | Configurable token quotas | Zero cases of settled usage exceeding limit by more than the defined overshoot bound (§11.7) |
| G4 | Image and document input | MVP file types (§12.3) accepted, validated, and delivered to capable models |
| G5 | Non-text responses & artifacts supported | A response with text + image + file parts persists, streams, and downloads correctly |
| G6 | Reliable persistence | Interrupted/failed generations never corrupt history; 100 % of generations end in a terminal state |
| G7 | Provider isolation | No provider SDK types outside `providers/<name>/` |
| G8 | Local storage now, S3 later | Migration needs a new StorageProvider + config only |
| G9 | Operational simplicity | MVP runs on: 1 app image, PostgreSQL, a volume (Redis optional) |
| G10 | Built-in provider tool execution | Toggleable built-in web search, web fetch, cloud code execution, skills, and image/doc generation mediated via PAL & ArtifactSink |

### Non-Goals (MVP)

- Autonomous multi-agent loops, custom user-defined tool plugins/MCP servers, custom RAG vector databases, local server-side code execution sandboxes, long-term memory (extension points only — §26). Native built-in provider cloud tools (search, fetch, code execution, skills) are supported directly.
- Permanent file library, file reuse across conversations, shared/collaborative conversations.
- Switching a conversation's model after messages exist, or **automatic fallback to another model** on failure.
- Conversation branching/editing of past messages (conversations are linear in MVP).
- Billing/chargeback integrations; tokens and estimated cost are *reported*, not invoiced.
- Multi-tenant SaaS isolation (A-1).
- SSO/OIDC and MFA (email + password only in MVP; `users.idp_subject` is the extension point) — A-15.
- Application-level end-to-end encryption of message content (disk/DB-level encryption is assumed).

## 4. Target Users

| Persona | Needs | Notes |
|---|---|---|
| **Employee (user)** | Chat with a chosen model, attach documents/images, see history, see own remaining quota | ~95 % of users; mostly non-technical |
| **Division administrator (admin)** | Manage user accounts within assigned division only (CRUD user, reset passwords, enable/disable) | Scoped strictly to assigned division (`division_id NOT NULL`); cannot access other divisions, models, providers, quotas, or platform settings |
| **Super administrator (super_admin)** | System-wide control: provision divisions, set quotas, enable/disable models, configure providers, manage all users/admins, investigate errors/usage, review audit logs | 2–5 people; cannot read chat content (A-13) |
| **Platform engineer** | Deploy, monitor, back up, rotate keys | Needs health checks, structured logs with stack traces, runbooks |

## 5. User Stories

| ID | As a… | I want… | So that… | Pri |
|---|---|---|---|---|
| US-1 | Employee | to sign in with the account my company issued me | my access is governed and revocable by the company | P0 |
| US-2 | Employee | to pick a model when I start a conversation | I can use the right tool for the task | P0 |
| US-3 | Employee | my conversation to stay on that model | answers are consistent and I know what I'm using | P0 |
| US-4 | Employee | to see answers stream in and stop generation | I get fast feedback and control | P0 |
| US-5 | Employee | to attach images, PDFs, and office documents | the model can work with my material | P0 |
| US-6 | Employee | to reload a conversation after refresh/disconnect and see everything intact | I never lose work | P0 |
| US-7 | Employee | to see my remaining monthly tokens and a clear message when exhausted | I can plan usage | P0 |
| US-8 | Employee | to click Send twice or have my network drop without duplicate answers or double charges | I'm not penalized for flaky connections | P0 |
| US-9 | Employee | to retry a failed generation | one provider hiccup doesn't ruin my conversation | P0 |
| US-10 | Employee | to download files and images the AI generated | I can use the output directly | P0 |
| US-11 | Super Admin | to set quotas per user, per division, or globally | I can control spend across the organization | P0 |
| US-12 | Super Admin | to disable a model or user instantly across the platform | I can respond to incidents/cost spikes | P0 |
| US-13 | Super Admin | to see usage by user/model/provider/day/division | I can report and forecast | P0 |
| US-14 | Super Admin | to see provider health and recent errors | I can diagnose problems quickly | P1 |
| US-15 | Super Admin | to review who changed what across the platform | I can satisfy compliance | P0 |
| US-16 | Platform engineer | traceable request IDs and structured logs with stack traces | I can debug production | P0 |
| US-17 | Employee | to toggle web search, web fetch, and cloud code/skills execution | I can access up-to-date facts and perform data calculations | P0 |
| US-18 | Employee | to prompt the model to generate images and office documents (XLSX, DOCX, charts) | I can produce visual and tabular artifacts directly in chat | P0 |
| US-19 | Division Admin | to create, list, view, and update user accounts within my assigned division | I can onboard and manage team members without waiting for super admins | P0 |
| US-20 | Division Admin | to reset passwords and disable accounts for users in my division | I can resolve access issues and offboard departing team members quickly | P0 |

## 6. Functional Requirements

### 6.1 Authentication & users
- **FR-AUTH-1 (P0)** Email + password authentication (locally managed credentials) with a **server-backed, stateful session stored in PostgreSQL**, delivered as an opaque `__Host-session` cookie. Passwords are hashed with **argon2id**.
- **FR-AUTH-2 (P0)** Accounts are **provisioned by administrators** (single create P0; CSV bulk import P1). A `super_admin` can provision accounts with any role (`user`, `admin`, `super_admin`) and assign any division (or leave unassigned). A division `admin` can provision accounts with role `user` strictly within their own assigned division. There is **no just-in-time provisioning and no self-registration**. The initial password is set by the admin (or auto-generated) and must be changed on first login.
- **FR-AUTH-3 (P0)** A `super_admin` can disable any user; a division `admin` can disable users strictly within their own division. Disabled users lose access on the next request and active sessions are revoked immediately.
- **FR-AUTH-4 (P0)** Roles: `user`, `admin`, `super_admin`.
  - `user`: standard employee; uses chat, attachments, history, quota self-view.
  - `admin`: division administrator; strictly bound to an assigned division (`division_id NOT NULL`), restricted to CRUD user operations solely for users within that division. Cannot manage divisions, quotas, models, providers, settings, or audit logs, and cannot view or mutate users of other divisions.
  - `super_admin`: system-wide administrator (revamped from former `admin` role); full administrative authority across all divisions, users, quotas, models, providers, system settings, and audit logs.
- **FR-AUTH-5 (P0)** Password policy and protection: minimum length 12, argon2id hashing, per-account lockout after 8 consecutive failures (15 min) plus a per-IP limit on the login route (§15.4); failures return a generic error (no user enumeration) and are audited.
- **FR-AUTH-6 (P0)** A signed-in user can change their own password; the change revokes all **other** sessions.
- **FR-AUTH-7 (P0)** Password reset: A `super_admin` can reset any user's password; a division `admin` can reset passwords solely for users within their own division (reason required). The reset revokes **all** of the target user's sessions, forces a change at next login, and is audited.
- **FR-AUTH-8 (P0)** The first super admin is created by a `bootstrap-admin` CLI/migration (`role = super_admin`, one-time password, `must_change_password = true`); there is no break-glass path beyond this.
- **FR-AUTH-9 (P1)** CSV bulk provisioning of users (super admin across any division; division admin within own division).
- **FR-AUTH-10 (P0)** Safeguards: The system prevents demoting or disabling the last active `super_admin`. Division admins cannot change their own division, escalate their own or others' roles, or access/modify accounts in other divisions.

### 6.2 Model & provider registry
- **FR-MODEL-1 (P0)** Providers and models are rows, editable at runtime by super admins (no deploy).
- **FR-MODEL-2 (P0)** Each model declares capabilities: streaming, vision, document types, image generation, document generation, system prompt support, tools (reserved), context window, max output tokens.
- **FR-MODEL-3 (P0)** Model states: `active`, `disabled`.
- **FR-MODEL-4 (P1)** Model visibility per division (allow-list rules).
- **FR-MODEL-5 (P0)** `GET /models` returns only models the caller may use, with capabilities in normalized form — no provider names required by the UI beyond a display label.

### 6.3 Conversations & messages
- **FR-CONV-1 (P0)** Create conversation with `modelId`; model is immutable once the first message exists (DB-enforced).
- **FR-CONV-2 (P0)** List (cursor-paginated), rename, soft-delete conversations; strictly per-user isolation.
- **FR-CONV-3 (P0)** Messages consist of ordered **parts** (text, image, document, generated_file; reserved: tool_call, tool_result, reasoning).
- **FR-CONV-4 (P0)** At most one active generation per conversation.
- **FR-CONV-5 (P0)** Retry a failed/cancelled generation for the same user message.
- **FR-CONV-6 (P0)** Auto-generated conversation title (from first user message, truncated; LLM-generated titles are P2 because they consume quota).

### 6.4 Generation & streaming
- **FR-GEN-1 (P0)** `POST /conversations/:id/messages` creates user message + generation atomically (idempotent) and returns immediately.
- **FR-GEN-2 (P0)** SSE stream per generation with sequence IDs, replay on reconnect, heartbeat.
- **FR-GEN-3 (P0)** Cancel generation; provider request is aborted.
- **FR-GEN-4 (P0)** States: `pending → generating → completed | cancelled | failed`.
- **FR-GEN-5 (P0)** Partial text checkpointed to PostgreSQL during streaming.
- **FR-GEN-6 (P0)** Never fall back to a different model on provider failure.

### 6.5 Files
- **FR-FILE-1 (P0)** Upload images, PDF, DOCX, XLSX, CSV, TXT, MD (MVP list in §12.3) with signature validation, size/count limits, sanitized names.
- **FR-FILE-2 (P0)** Files are temporary, scoped to a user (and conversation once attached), auto-expired.
- **FR-FILE-3 (P0)** Authenticated, authorized download of uploaded and generated files.
- **FR-FILE-4 (P0)** Generated binaries are stored *before* they are exposed to the client.
- **FR-FILE-5 (P2)** OCR for scanned PDFs/images (extension point defined).

### 6.6 Quota & usage
- **FR-QUOTA-1 (P0)** Monthly token quota per user, resolved from user override → division policy → global default.
- **FR-QUOTA-2 (P0)** Atomic reservation before provider call; settlement with actual usage; release on failure.
- **FR-QUOTA-3 (P0)** Per-request max input / max output limits; optional concurrent-generation limit.
- **FR-QUOTA-4 (P0)** Append-only usage ledger; super admin adjustments are ledger entries.
- **FR-QUOTA-5 (P0)** Users can view their quota and usage; super admins can view everyone's usage across all divisions.
- **FR-QUOTA-6 (P2)** Provider- and model-specific token caps (schema-ready, §11.9).
- **FR-QUOTA-7 (P0)** Token estimation uses the tokenizer designated for each provider: `tiktoken` for OpenAI-compatible adapters, a local port of `dhamaniasad/claude-tokenizer` for Anthropic, and the adapter's own local tokenizer/BPE heuristic (with safety margin) elsewhere. Estimation is offline by default and never blocks request intake on network I/O.

### 6.7 Admin
See §20. Two administrative roles:
1. **Division Admin (`admin`):** Delegated user administration strictly within their assigned division (CRUD user in own division, password reset, account status).
2. **Super Admin (`super_admin`):** System-wide administration: divisions, all users/admins, quota policies and adjustments, models, providers, provider health, usage reporting, system error explorer, audit logs, platform settings.

### 6.8 Operations
- **FR-OPS-1 (P0)** Request IDs on every request/generation; structured Winston JSON logs with daily rotation and stack traces; health endpoints (/healthz, /readyz).
- **FR-OPS-2 (P0)** Background cleanup of files, reservations, stale generations.

## 7. Non-Functional Requirements

| ID | Category | Requirement (measurable) | Assumption |
|---|---|---|---|
| NFR-AV-1 | Availability | Platform API availability ≥ **99.5 %/month** (excluding provider outages and announced maintenance ≤ 2 h/month) | A-2 |
| NFR-AV-2 | Availability | Provider outage affects only conversations on that provider; other models stay usable | |
| NFR-REL-1 | Reliability | 100 % of generations reach a terminal state (`completed/cancelled/failed`) within `max_generation_duration + 2 min` even across process crashes | |
| NFR-REL-2 | Reliability | No duplicate generation or double quota charge for any retried request carrying the same idempotency key | |
| NFR-REL-3 | Reliability | Reservations never remain `active` beyond `expires_at + 2 min` | |
| NFR-SEC-1 | Security | All endpoints authenticated except health and login; object-level authorization on every resource; zero provider secrets and zero password material in responses/logs (verified by tests and log scanning) | |
| NFR-SEC-2 | Security | Passes dependency audit with no critical vulnerabilities at release; secrets injected via env/secret files (never in code or images) and rotatable without rebuilding or redeploying code (a rolling process restart is acceptable — A-16) | |
| NFR-PERF-1 | Performance | Non-generation API p95 ≤ **200 ms**, p99 ≤ 500 ms at peak | A-2 |
| NFR-PERF-2 | Performance | Platform-added time-to-first-token (request accepted → first `text.delta` emitted, minus provider latency) p95 ≤ **300 ms** | |
| NFR-PERF-3 | Performance | Load conversation with 100 messages p95 ≤ **300 ms** | |
| NFR-PERF-4 | Performance | Upload 10 MB p95 ≤ 3 s (internal network); extraction of ≤ 20-page PDF p95 ≤ 10 s | |
| NFR-SCALE-1 | Scalability | One node sustains 150 concurrent streams with CPU < 60 %; DB pool never saturates because streams hold no DB connection | A-2/A-4 |
| NFR-SCALE-2 | Scalability | Path to ≥ 2 API nodes documented and tested (stream relay, shared/S3 storage) | |
| NFR-MAINT-1 | Maintainability | Adding a provider requires changes only under `providers/<name>/` plus registry rows; enforced by lint rule (no provider SDK imports elsewhere) and contract test suite | |
| NFR-MAINT-2 | Maintainability | ≥ 80 % line coverage on `quota`, `orchestrator`, `context`, `providers` modules; 100 % of error mappings tested | |
| NFR-RET-1 | Data retention | Retention windows per A-7 enforced by jobs; deletion verified by tests | A-7 |
| NFR-AUD-1 | Auditability | 100 % of admin mutations and security events produce an immutable audit row within the same transaction | |
| NFR-REC-1 | Recoverability | **RPO ≤ 5 min** (WAL archiving / PITR), **RTO ≤ 1 h**; quarterly restore test | |
| NFR-QA-1 | Quota accuracy | Nightly reconciliation finds **0** mismatches between `quota_periods` counters and ledger sums; overshoot per request ≤ 10 % of reservation, tracked as a metric | |

---

## 8. System Architecture

### 8.1 Logical architecture

```
                         ┌──────────────────────────────────────────────┐
  Browser (SPA)          │                 Hono API (Node)              │
  ───────────────  HTTPS │  Auth/Session · RBAC · Rate limit · Validation│
  REST + SSE  ─────────► │  Routes: /me /models /conversations /files … │
                         └───────┬──────────────────────────┬───────────┘
                                 │                          │
                    ┌────────────▼──────────┐     ┌─────────▼──────────┐
                    │   Chat Orchestrator   │     │  Admin / Usage /   │
                    │ (generation runner)   │     │  File services     │
                    └──┬────────┬────────┬──┘     └─────────┬──────────┘
                       │        │        │                  │
        ┌──────────────▼─┐ ┌────▼─────┐ ┌▼───────────────┐  │
        │ Context Builder│ │  Quota   │ │ ArtifactSink / │  │
        │ (history→req)  │ │ Service  │ │ FileService    │  │
        └──────┬─────────┘ └────┬─────┘ └───────┬────────┘  │
               │                │               │           │
   ┌───────────▼──────────┐     │      ┌────────▼────────┐  │
   │ Provider Abstraction │     │      │ StorageProvider │  │
   │  ┌────────┐┌───────┐ │     │      │ Local │ S3(fut.)│  │
   │  │OpenAI  ││Claude │…│     │      └─────────────────┘  │
   │  └────────┘└───────┘ │     │                           │
   └──────────────────────┘     │                           │
                          ┌─────▼───────────────────────────▼─────┐
                          │ PostgreSQL (source of truth + job queue)│
                          └────────────────────────────────────────┘
        Worker role (same image): job runner · reapers · cleanup · rollups
        Optional: Redis (rate limiting; later stream relay)
```

### 8.2 The three separated concerns

| Concern | Owner module | Stores | Knows about | Must NOT know about |
|---|---|---|---|---|
| **Conversation persistence** | `conversations/`, `messages/` | conversations, messages, message_parts, generations | normalized parts, file IDs | provider formats, filesystem paths |
| **AI provider execution** | `providers/*`, `orchestrator/` | nothing durable (emits events) | `NormalizedChatRequest`, `GenerationEvent`, resolved attachment bytes | DB tables, storage paths, HTTP |
| **Binary artifact storage** | `storage/`, `files/` | blobs + `files` metadata rows | `storage_key`, bytes/streams | conversations, providers |

Glue lives only in the **Orchestrator** (runs a generation), **Context Builder** (DB rows → normalized request), and **ArtifactSink** (provider-emitted bytes → storage → `files` row → message part).

### 8.3 Request lifecycle for one chat turn

1. `POST /conversations/:id/messages` (with `Idempotency-Key`). Auth → authorize ownership → validate body and file IDs (all `ready`, owned by caller, unattached).
2. **Outside any DB transaction:** build context, estimate tokens (§11.2), compute reservation.
3. **Single short transaction:** insert idempotency row → reserve quota → create user message + parts → create assistant placeholder message (`streaming`) → create generation (`pending`) → attach files → commit. Return `202 {message, assistantMessage, generation}`.
4. Orchestrator picks up the generation in-process (`pending → generating`), calls the adapter with an `AbortSignal`, converts provider events to normalized events, appends to the ring buffer, checkpoints text to PostgreSQL.
5. Client opens `GET /generations/:id/stream` (SSE), replays from `Last-Event-ID` if reconnecting.
6. **Finalizer** (always runs, exactly once): persists final parts, sets message/generation terminal state, **settles or releases** the reservation, writes `usage_records`, emits the terminal SSE event, structured logging.

> **Decision D-1 — Create and stream are separate calls**
> - *Why:* A POST that both creates and streams cannot be safely retried: the client may not know whether it was created.
> - *Problem solved:* Duplicate generations on retry/reconnect; clean idempotency; reconnect without re-submitting.
> - *Implementation:* `POST` returns `202` with IDs; `GET /generations/:id/stream` is a pure, replayable read.
> - *Trade-offs:* One extra round trip (~10–30 ms) before streaming starts.
> - *Scale path:* The stream endpoint can be served by whichever node holds (or relays) the generation.

> **Decision D-2 — Generations are decoupled from the HTTP connection**
> - *Why:* Mobile/VPN connections drop; tying provider calls to the socket wastes tokens and loses answers.
> - *Problem solved:* Interrupted streams never corrupt history; reconnect resumes; settlement always occurs.
> - *Implementation:* `GenerationRunner` owns an `AbortController`; the SSE response is just one subscriber (A-12).
> - *Trade-offs:* In-process state (buffer, handle) → single-owner generations in MVP (A-4).
> - *Scale path:* Redis Streams/pub-sub relay keyed by `generation_id`; `runner_id` column already identifies the owner.

> **Decision D-3 — PostgreSQL is the only required stateful dependency**
> - *Why:* Fewer moving parts is the dominant reliability factor for a small team.
> - *Problem solved:* Quota correctness (transactions), jobs (SKIP LOCKED), idempotency (unique index), audit — all in one consistent store.
> - *Implementation:* Redis is optional and used only for rate limiting; **sessions are stored in PostgreSQL too**, so losing Redis degrades rate limits to in-memory, never correctness or sign-in.
> - *Trade-offs:* Postgres-backed queue has lower throughput than a broker (ample for A-2).
> - *Scale path:* `JobQueue` interface allows pg-boss/BullMQ/SQS later.

---

## 9. Provider Abstraction Architecture

### 9.1 Why / what
The orchestrator and API must not contain OpenAI/Claude/Gemini message formats. Each provider has its own roles, content block shapes, attachment mechanics, token accounting, streaming protocol, and error vocabulary. A **Provider Abstraction Layer (PAL)** defines one internal vocabulary; **adapters** translate to and from it.

### 9.2 Normalized domain types (TypeScript)

```ts
// ---------- Parts (shared by persistence and requests) ----------
export type NormalizedPart =
  | { type: 'text'; text: string }
  | { type: 'image'; file: ResolvedFile }                 // bytes available lazily
  | { type: 'document'; file: ResolvedFile; extractedText?: string; preferNative: boolean }
  | { type: 'generated_file'; file: ResolvedFile }        // assistant output replayed as context (rare)
  // Reserved for future; adapters MUST ignore/reject unknown types explicitly:
  | { type: 'tool_call'; callId: string; name: string; args: unknown }
  | { type: 'tool_result'; callId: string; content: NormalizedPart[]; isError?: boolean };

export interface ResolvedFile {
  fileId: string;
  mimeType: string;
  name: string;
  sizeBytes: number;
  width?: number; height?: number; pageCount?: number;
  read(): Promise<Uint8Array>;                 // adapter calls only if it needs bytes
  stream(): Promise<ReadableStream<Uint8Array>>;
}

export interface NormalizedMessage {
  role: 'user' | 'assistant';
  parts: NormalizedPart[];
}

// ---------- Request ----------
export interface NormalizedChatRequest {
  requestId: string;
  generationId: string;
  model: ModelRuntimeConfig;        // from registry: apiModelId, capabilities, limits, provider config
  system?: string;                  // platform system instructions (assembled by ContextBuilder)
  messages: NormalizedMessage[];    // already truncated to fit
  maxOutputTokens: number;          // already clamped by quota + model limits
  temperature?: number; topP?: number;
  responseModalities: Array<'text' | 'image' | 'file'>;   // MVP: ['text']
  tools?: never;                    // reserved
  metadata: { userIdHash: string }; // opaque; never raw email
}

// ---------- Streaming events (adapter output) ----------
export type GenerationEvent =
  | { type: 'started'; providerRequestId?: string }
  | { type: 'part_started'; index: number; partType: 'text' | 'image' | 'file'; mimeType?: string; name?: string }
  | { type: 'text_delta'; index: number; text: string }
  | { type: 'artifact_chunk'; index: number; bytes: Uint8Array }      // for binary outputs
  | { type: 'part_done'; index: number }
  | { type: 'progress'; stage: string; percent?: number }             // job-style generations
  | { type: 'usage'; usage: TokenUsage; final: boolean }
  | { type: 'finished'; reason: 'stop' | 'length' | 'content_filter' | 'tool_use' | 'other' }
  | { type: 'error'; error: ProviderError };                          // terminal

export interface TokenUsage {
  inputTokens: number; outputTokens: number;
  cachedInputTokens?: number; reasoningTokens?: number;
  source: 'provider' | 'estimated';
}

export interface ProviderError {
  category: AppErrorCategory;         // normalized (see §18)
  retryable: boolean;
  retryAfterMs?: number;
  providerStatus?: number;            // internal only
  providerCode?: string;              // internal only
  providerRequestId?: string;         // internal only
  safeMessage: string;                // user-safe
  internalMessage?: string;           // logs only, redacted
}

export interface ModelCapabilities {
  streaming: boolean;
  vision: boolean;
  documents: { pdf: boolean; maxPages?: number; /* others are text-extracted by platform */ };
  imageGeneration: boolean;
  documentGeneration: boolean;
  systemPrompt: boolean;
  tools: boolean;                     // reserved, false in MVP
  maxImagesPerRequest?: number;
  contextWindow: number; maxOutputTokens: number;
}
```

### 9.3 Adapter contract

```ts
export interface ProviderAdapter {
  readonly adapterKey: 'openai' | 'anthropic' | 'gemini' | string;

  /** Pure transform used by tests and by token estimation. No network. */
  toProviderRequest(req: NormalizedChatRequest): unknown;

  /** Estimate input tokens. MUST use the adapter's designated tokenizer (see §11.2);
   *  may use a provider count endpoint only when latency allows. No network by default. */
  estimateInputTokens(req: NormalizedChatRequest): Promise<{ tokens: number; confidence: 'exact' | 'approx' }>;

  /** Execute and stream normalized events. MUST honor signal; MUST emit exactly one terminal event
   *  ('finished' or 'error'); MUST NOT throw provider-specific errors out of the iterator. */
  execute(req: NormalizedChatRequest, ctx: { signal: AbortSignal; deadline: number }): AsyncIterable<GenerationEvent>;

  /** Translate any thrown/HTTP error into ProviderError. */
  translateError(err: unknown): ProviderError;

  /** Lightweight check for admin health page; must be cheap and not consume meaningful tokens. */
  healthCheck(ctx: { signal: AbortSignal }): Promise<{ ok: boolean; latencyMs: number; detail?: string }>;
}
```

Rules:
- Adapters receive **configuration and secrets by injection** (`ProviderRuntimeConfig` resolved from `providers` + the environment — `secret_ref` names an env var, A-16); they never read env or DB themselves.
- Non-streaming models (or job-style image/doc generation) still return `AsyncIterable` — they emit `started → part_* → usage → finished` in one burst. The orchestrator has one code path.
- Adapters never persist anything and never touch storage; binary output arrives as `artifact_chunk` events and is stored by the **ArtifactSink**.
- Provider-specific knobs (e.g., safety settings, reasoning effort, beta headers) live in `providers.config` / `models.config` JSON, validated by a Zod schema owned by the adapter.
- **Tokenizer library per provider.** The `openai` adapter uses `tiktoken` (WASM, offline); the `anthropic` adapter uses a local port of `dhamaniasad/claude-tokenizer`; other adapters use their own local tokenizer/BPE heuristic. Every tokenizer dependency resides inside the adapter folder (`src/providers/adapters/<name>/`) and **must be lazily initialized** (see R19) because encoding initialization consumes tens of megabytes and tens of milliseconds on cold start.

### 9.4 Provider registry & model registry (runtime, DB-driven)

- `providers`: key, display name, `adapter` key, base URL override, `secret_ref` (**the name of the environment variable holding the API key — never the key itself** — A-16), status, timeouts, `config` JSON.
- `models`: FK provider, `api_model_id` (provider's identifier), display name, status (`active` | `disabled`), capabilities JSON, `context_window`, `max_output_tokens`, `default_max_output_tokens`, `quota_weight`, `config` JSON.
- `model_pricing`: effective-dated input/output/cached prices (for cost *estimates*).
- Registry is cached in-process (TTL 30 s + invalidation on admin write) so a disabled model stops accepting new generations within seconds. In-flight generations keep the runtime config they started with; `usage_records` captures `model_id` so later registry edits don't rewrite history.

**Model lifecycle behavior**

| State | New conversation | Existing conversation: read | Existing: new message | UI hint |
|---|---|---|---|---|
| `active` | ✅ | ✅ | ✅ | — |
| `disabled` (admin kill-switch) | ❌ | ✅ | ❌ `model_unavailable` | "Model temporarily unavailable" |

> **Decision D-4 — Capability flags, not provider checks**
> - *Why:* Orchestrator/ContextBuilder must ask "can this model take images?" not "is this OpenAI?".
> - *Problem solved:* Conditional provider logic spreading through the codebase.
> - *Implementation:* Capabilities JSON in registry; ContextBuilder and upload validation consult it; mismatches yield `422 unsupported_for_model` *before* quota reservation.
> - *Trade-offs:* Capability data must be maintained by admins; wrong data causes provider 400s (mapped, alerted).
> - *Scale path:* Add new capability keys without schema migrations (JSON), versioned by `capabilities.schemaVersion`.

### 9.5 Adding a new provider (checklist)

1. Create `providers/<name>/adapter.ts` implementing `ProviderAdapter`; add a Zod config schema.
2. Implement `translateError` mapping **every** documented HTTP status/error code to `AppErrorCategory` (table-tested).
3. Implement `toProviderRequest` for text, image, and document parts; unsupported parts throw `UnsupportedPartError` (caught earlier by capability checks).
4. Register the adapter key in `providers/registry.ts`.
5. Run the **contract test suite** (§23.3) against the adapter with recorded fixtures; add provider fixtures.
6. Insert the `providers` row (its `secret_ref` names the environment variable holding the key — A-16) and a `models` row per model (disabled); verify via the admin health check; enable.
7. No changes to: orchestrator, context builder, quota, API, DB schema, frontend.

---

## 10. Conversation and Message Model

### 10.1 Entities

```
User ──< Conversation (model_id fixed) ──< Message (user | assistant) ──< MessagePart (ordered)
                         │                      │                           │
                         └──< Generation >──────┘ (1 generation ↔ 1 assistant message)
                                                                            └── file_id → File (blob in StorageProvider)
```

- **Conversation:** owner, `model_id`, title, timestamps, soft-delete flag. `model_id` is immutable once `message_count > 0` (trigger, §17).
- **Message:** `role`, monotonically increasing `seq` per conversation, `status` (`streaming | complete | incomplete | failed`), `finish_reason`, optional `superseded_by` (for retried failures).
- **MessagePart:** `(message_id, position)` unique; `type`; `status`; `text_content` for text; `data` JSONB for type-specific metadata; `file_id` FK for binary-backed parts.
- **Generation:** execution record for an assistant message: state, request ID, attempts, heartbeat, runner, error, usage link.

### 10.2 Part types

| `type` | Role | Backed by | `data` (JSONB) example | Notes |
|---|---|---|---|---|
| `text` | user / assistant | `text_content` | `{"format":"markdown"}` | Assistant text streams into this |
| `image` | user (upload) / assistant (generated) | `file_id` | `{"width":1024,"height":768,"alt":null}` | |
| `document` | user | `file_id` | `{"pages":12,"nativeToModel":true}` | Extracted text kept in `file_extractions` |
| `generated_file` | assistant | `file_id` | `{"name":"report.pdf","mime":"application/pdf"}` | Any non-image artifact |
| `structured` *(optional P2)* | assistant | `data` | `{"schema":"table.v1", …}` | For JSON/table outputs |
| `tool_call` / `tool_result` / `reasoning` | assistant | `data` | reserved | Not produced in MVP; the `type` CHECK allows them so no migration is needed |

Every part's `data` carries `schemaVersion`. Unknown types render as a placeholder in clients (forward compatibility).

**Example**

```
Message #12 (user)       parts: [0 text "Summarize and chart this"] [1 document report.pdf] [2 image chart.png]
Message #13 (assistant)  parts: [0 text "…summary…"] [1 image (generated)] [2 generated_file summary.pdf]
```

> **Decision D-5 — Message parts instead of a content column**
> - *Why:* Responses can be multi-output; provider formats differ; future part types (tools, reasoning) must not need migrations.
> - *Problem solved:* "One assistant response = one text column" breaks for images/documents and tool use.
> - *Implementation:* Ordered `message_parts` table; text in a real `text` column (cheap append during streaming), everything else in `data` JSONB + `file_id`.
> - *Trade-offs:* More rows and a join when loading a conversation (mitigated by one query with `ORDER BY message_id, position`).
> - *Scale path:* Add part types by code + CHECK constraint update; partition `message_parts` by month if volume demands.

### 10.3 Context Builder

Converts persisted rows → `NormalizedChatRequest`.

**Inputs:** conversation, model runtime config, new user message (parts), history, system prompt settings.

**System instructions (layered, concatenated in order):**
1. Platform policy prompt (from `system_settings`, admin-editable, versioned).
2. Model-specific addendum (`models.config.systemAddendum`).
3. Per-conversation custom instructions (P2).
Models without `systemPrompt` capability: the builder prepends the system text to the first user message.

**Token budget**

```
available_input = context_window
                  − reserved_output          (= effective max_output_tokens)
                  − safety_margin            (= max(1,000, 3 % of context_window))
```

**Selection algorithm (deterministic, testable)**

1. Always include: system instructions and the **new user message with its attachments**. If this alone exceeds `available_input` or the policy `max_input_tokens_per_request` → fail `context_too_large` (never silently cut the user's current message).
2. Walk history **newest → oldest in whole turns** (user+assistant pair; incomplete/failed assistant messages are skipped, and the orphan user message is merged by adapter normalization). Add each turn while it fits.
3. Attachment degradation for older turns, in order: (a) keep text + native attachment; (b) replace native image/PDF with extracted text (docs) or a stub `[image omitted: name]`; (c) drop the turn.
4. **Block truncation:** drop history in blocks (e.g., ~20 % of budget) instead of one turn at a time so the prompt prefix stays stable between turns (improves provider prompt-cache hit rates and predictability).
5. If anything was dropped, record `context_truncated {droppedMessages, droppedAttachments}` on the generation and emit an SSE `context.truncated` event so the UI can show "Earlier messages are not included."
6. Normalize roles: merge consecutive same-role messages; ensure first message is `user` (adapter-specific rules live in adapters).

**Long conversation strategy**
- MVP: sliding window with block truncation + notice (above).
- P2: rolling summary (`conversation_summaries` table, produced by the same model, charged to the user's quota, triggered when truncation first occurs, summary inserted as a system-context block). Not in MVP because it adds cost, failure modes, and quota complexity.

**Untrusted content handling:** extracted document text is wrapped as

```
<attached_document name="report.pdf" untrusted="true">
…text…
</attached_document>
```
with a system instruction that content inside is data, not instructions (§15.8).

**Model-specific transformations** (owned by adapters, not the builder): role naming, content block shapes, image encoding (base64 vs file API), PDF native vs text, max images, system prompt placement.

---

## 11. Token Quota and Usage Architecture

### 11.1 Vocabulary (the five distinct things)

| Term | Meaning | When | Persisted as |
|---|---|---|---|
| **Estimation** | Best guess of input tokens (and worst-case output) *before* calling the provider | Request intake | `generations.est_input_tokens` |
| **Reservation** | Quota *held* so concurrent requests cannot oversubscribe | Same transaction that creates the generation | `quota_reservations` row + `quota_periods.reserved_tokens` + ledger `reserve` |
| **Actual usage** | Tokens the provider reports | End of generation (or best available) | `usage_records` |
| **Settlement** | Convert reservation → consumed: `reserved −= R; used += actual` | Finalizer | ledger `settle` |
| **Release** | Give back the reservation without consumption | Failure before provider accepted the request | ledger `release` |

### 11.2 Estimation

```
est_input     = adapter.estimateInputTokens(request).tokens × margin
margin        = 1.00 (local provider tokenizer / exact count endpoint) | 1.10 (approximate tokenizer / approx text) | 1.25 (when images/PDFs present)   // calibrate with real data
worst_output  = effective_max_output_tokens
reserve_raw   = est_input + worst_output
reserve       = ceil(reserve_raw × model.quota_weight)
```

- **Tokenizer per provider (selected by adapter; no network calls):**

  | Provider | Tokenizer | Margin default |
  |---|---|---|
  | `openai` (ChatGPT) | **`tiktoken`** (`@dqbd/tiktoken` / `js-tiktoken`, WASM, offline) | `1.00` — local encoding identical to provider; deviation arises only from message overhead (`<im_start>`/`<im_end>`, ~3–4 tokens/message) added explicitly by the adapter |
  | `anthropic` (Claude) | **Port of [`dhamaniasad/claude-tokenizer`](https://github.com/dhamaniasad/claude-tokenizer)** to TypeScript (BPE package in `src/providers/adapters/anthropic/tokenizer/`) | `1.10` — Claude does not publish an official encoding library; this reference is the best available approximation |
  | others (e.g. `gemini`) | **Local tokenizer / BPE heuristic** owned by the adapter, without network calls | `1.10` pure text; `1.25` when images/PDFs present |

- An adapter may use the provider's official count endpoint **only when additional latency is acceptable**; if used, `confidence: 'exact'` applies and the margin in the table above may be reduced to `1.00`. If not used, `confidence: 'approx'`.
- Image/PDF token costs are estimated from dimensions/pages using per-provider formulas inside the adapter (**calibrate against real usage reports during Phase 3; track `estimation_error_ratio` metric**).
- `effective_max_output_tokens = min(request.max_output, policy.max_output_per_request, model.max_output_tokens)`, further clamped so `est_input + output ≤ remaining_quota` when remaining quota is lower than a full reserve and at least `MIN_USEFUL_OUTPUT` (default 256) remains; otherwise reject with `quota_exceeded`. This lets users spend their last tokens without overshoot.
- Rejections before reservation: `est_input > policy.max_input_tokens_per_request` → `context_too_large`.

### 11.3 Policy resolution

`quota_policies` exist at three scopes: `global` (default), `division`, `user`. Each field is nullable; **resolution is per field**: user → division → global. Resolved values are copied into the user's `quota_periods` row at period creation, and re-applied when an admin changes a policy ("apply to current period" default = yes, via ledger `adjust`-style recompute of `base_limit_tokens`).

Fields: `monthly_tokens`, `max_input_tokens_per_request`, `max_output_tokens_per_request`, `max_concurrent_generations`, `allowed_model_ids` (P1).

### 11.4 Atomic reservation (race-safe)

Counters live in one row per user per period. A single conditional `UPDATE` is the concurrency control: PostgreSQL row-locks the row, and under `READ COMMITTED` re-evaluates the `WHERE` after the lock is released, so concurrent reservations serialize and each sees the other's effect.

```sql
-- inside the "create generation" transaction
UPDATE quota_periods
   SET reserved_tokens = reserved_tokens + $reserve,
       updated_at = now()
 WHERE id = $period_id
   AND used_tokens + reserved_tokens + $reserve <= base_limit_tokens + adjustment_tokens
RETURNING used_tokens, reserved_tokens, base_limit_tokens + adjustment_tokens AS limit_tokens;
-- 0 rows  => ROLLBACK, return 429 quota_exceeded (with remaining tokens and resetAt)

-- still in the same txn; the row lock above serializes this per user:
SELECT count(*) FROM generations
 WHERE user_id = $user AND status IN ('pending','generating');
-- >= max_concurrent_generations => ROLLBACK, 429 concurrency_limit

INSERT INTO quota_reservations (generation_id, user_id, period_id, reserved_tokens, expires_at, status) …;
INSERT INTO quota_ledger (user_id, period_id, generation_id, entry_type, tokens, balance_after_used, balance_after_reserved) …;
```

**Worked example (the brief's scenario):** limit 100,000. A and B each reserve 20,000 concurrently → both succeed (`reserved = 40,000`). A settles at 8,000 actual: `reserved = 20,000`, `used = 8,000`. B settles at 12,000: `reserved = 0`, `used = 20,000`. A third and fourth concurrent 50,000 reservation: only one can pass the `WHERE` (80,000 + 50,000 > 100,000 for the second). Without the conditional UPDATE both would have read "80,000 remaining" and passed.

### 11.5 Settlement and release (finalizer, idempotent)

Single transaction, keyed by `generation_id`:

```sql
SELECT * FROM quota_reservations WHERE generation_id = $g FOR UPDATE;
-- if status <> 'active' → no-op (already settled/released/expired): idempotent

UPDATE quota_periods
   SET reserved_tokens = reserved_tokens - $reserved,
       used_tokens     = used_tokens + $actual_quota_tokens     -- 0 for release
 WHERE id = $period_id;

UPDATE quota_reservations SET status = 'settled'|'released', settled_tokens = $actual WHERE generation_id = $g;
INSERT INTO usage_records (…);   -- only on settle
INSERT INTO quota_ledger (entry_type = 'settle'|'release', …);
```

**Outcome policy table**

| Outcome | Provider accepted request? | Usage known? | Action |
|---|---|---|---|
| Completed | yes | yes (provider) | **Settle** actual |
| Completed, usage missing | yes | no | **Settle** `estimated_input + counted_output` (`usage_source='estimated'`) |
| Failed before provider accepted (DNS/connect error, 4xx, 429, 5xx pre-stream) | no | — | **Release** full reservation |
| Failed/timeout after stream started | yes | maybe | Settle provider usage if received; else estimated input + output counted from emitted text |
| Cancelled by user | yes (usually) | maybe | Same as above (usage is often not reported on abort) |
| Client disconnect → detach timeout cancel | yes | maybe | Same |
| Server crash / lost owner | unknown | no | **Reaper** settles `estimated_input + persisted_output_estimate` if generation had `started_at`, else releases |
| Provider error mid-retry | — | — | Reservation **reused** across retries (one reservation per generation); never double-reserved |

### 11.6 Reaper & expiry
Each reservation has `expires_at = created_at + max_generation_duration + grace`. A worker job (every 60 s) finds `active` reservations past expiry (and `generating` generations with stale heartbeat), finalizes the generation as `failed(interrupted)`, and settles/releases per the table. **No reservation may stay active indefinitely** (NFR-REL-3).

### 11.7 Overshoot bound
Max output is capped via the provider's `max_tokens`, so output cannot exceed reservation. Input *can* exceed the estimate. Settlement records the true value even if `actual > reserved` (`overshoot_tokens` on `usage_records`). Future requests are blocked because `used + reserved` is checked against the limit. Margin factors (§11.2) keep overshoot small; metric `quota_overshoot_ratio` is alerted at p95 > 10 % (NFR-QA-1).

### 11.8 Period handling & monthly reset
- Periods are created lazily: `INSERT … ON CONFLICT (user_id, scope_type, scope_id, period_start) DO NOTHING` on the first request of a new month — **no reset cron is required for correctness**. A daily job pre-creates periods for active users purely for reporting.
- **Period boundaries are the calendar month in the configured quota timezone (default UTC+7 / `Asia/Jakarta`, `QUOTA_TIMEZONE`; A-5).** Boundaries are computed in that zone (from the IANA name, correctly handling DST for zones that have it) and stored as UTC `timestamptz`. With the default, a month starts at `17:00Z` on the last day of the previous month; the `quota.precreate_periods` and reconciliation schedules (§22.3) run against UTC but must not assume a UTC-midnight boundary.
- A reservation settles into the period it was reserved against, even if the generation crosses midnight of month end.
- Policy `carryover` is P2.

### 11.9 Extensibility: provider/model-specific limits (schema-ready, P2)
`quota_periods` is keyed by `(user_id, scope_type, scope_id, period_start)` with `scope_type ∈ {total, provider, model}`. MVP only creates `total`. To enable model caps later: reservation locks every applicable period row **in a fixed order** (total first, then provider, then model, to avoid deadlocks) and applies the same conditional `UPDATE` to each.

### 11.10 Usage ledger
- `quota_ledger` is **append-only** (DB role has INSERT but no UPDATE/DELETE). Entry types: `reserve`, `settle`, `release`, `expire_release`, `adjust` (super admin ±), `grant`, `period_open`.
- Every entry stores `tokens` (signed delta semantic by type), `generation_id?`, `actor_user_id?` (super admin adjustments), `reason`, balances after. Corrections are new entries, never edits.
- **Nightly reconciliation job:** recompute `used`/`reserved`/`adjustment` per period from the ledger and compare to counters; any mismatch pages the on-call and writes an audit event.

### 11.11 Admin quota adjustment
Super admin endpoints (§16.9) can: change policy (global/division/user), grant extra tokens for the current period (`adjust +N`, reason required), or claw back (`adjust −N`). Never "reset used to zero" — use a compensating ledger entry so history stays truthful. Every action also writes `audit_logs`.

### 11.12 Idempotency & retries interplay
`quota_reservations.generation_id` is unique and the generation is created under an idempotency key (§16.5), so a retried request returns the existing generation and cannot reserve twice. Provider-level retries (§19) reuse the same reservation.

### 11.13 Usage reporting
- **Source of truth:** `usage_records` (one per settled generation) + ledger.
- **Rollups:** `usage_daily(date, user_id, division_id, provider_id, model_id, requests, failed_requests, input_tokens, output_tokens, quota_tokens, est_cost_micros)` maintained incrementally every 5 min and rebuilt for the previous day nightly (rollups are disposable and reproducible).
- **Cost:** `cost_micros = tokens × price_at(created_at)` from `model_pricing` (effective-dated), stored at write time with `cost_source = 'estimated'` (platform price list) — "actual provider invoice" reconciliation is a manual/CSV import post-MVP.
- Users see: remaining tokens, used this period, reset date (in the configured quota timezone — A-5), last-30-day daily usage. Super admins see all dimensions in §20.

> **Decision D-6 — Reserve worst case, settle actual**
> - *Why:* Output length is unknowable in advance; checking "remaining ≥ 0" before the call allows concurrent overspend.
> - *Problem solved:* Race-condition overspend; unbounded single-request cost.
> - *Implementation:* Conditional `UPDATE` reservation; hard `max_tokens` on every call; settlement with provider usage.
> - *Trade-offs:* Temporarily "locks" more quota than used (a user near the limit may be refused a long request they could have afforded); mitigated by output clamping to remaining quota.
> - *Scale path:* Same row-level mechanism works across many API nodes because the lock is in PostgreSQL. If a hot-row bottleneck ever appears (it won't at per-user granularity), shard counters per user.

---

## 12. File and Artifact Storage Architecture

### 12.1 Principles
- Files are **temporary conversation artifacts**, not a library. Every file belongs to one user and (once attached) one message and conversation.
- The database stores **metadata and an opaque storage reference**; blobs live behind `StorageProvider`. No filesystem path appears in any table, API response, or business logic.
- Input uploads and AI-generated outputs use the **same `files` table and storage path**, distinguished by `role` (`input` | `generated`).

### 12.2 File lifecycle

```
              upload                validate           extract (async)           attach
  (none) ───────────► uploading ───────────► validating ───────────► processing ───────► ready ──(send message)──► attached
                          │ fail                 │ reject                │ fail                     │ unattached TTL 1h
                          ▼                      ▼                       ▼                          ▼
                        failed               rejected                 failed                    expired
                                                                                                    │ (30d after upload for attached;
                                                                                                    │  30d after creation for generated)
                                                       expired ──► blob deleted ──► deleted (row kept as tombstone)
```

States: `uploading, validating, processing, ready, rejected, failed, expired, deleted`. `attached` is derived from `message_id IS NOT NULL`.

| Stage | Sync/Async | Detail |
|---|---|---|
| Auth, size/count/ext/signature checks, filename sanitization, hashing, blob write | **Sync** (in upload request) | Reject early; nothing durable on failure |
| Image decode/dimension check, metadata strip | **Sync** (≤ 2 s budget) | Uses `sharp`/libvips with pixel limit |
| Text extraction (PDF/DOCX/XLSX/CSV/TXT/MD) | **Async job**, with a 5 s "fast path" wait in the upload request | Returns `201 ready` if finished in time, else `202 processing`; client polls `GET /attachments/:id` |
| Malware scan (ClamAV, optional P1) | Async job before `ready` | Skipped if scanner not configured |
| Expiry & deletion | Async cleanup job | Two-phase (§12.8) |

### 12.3 MVP file types and limits (all configurable in `system_settings`)

| Type | Extensions | Detected MIME (signature) | Max size | Handling |
|---|---|---|---|---|
| Image | `.png .jpg/.jpeg .webp .gif`(static only) | `image/png`, `image/jpeg`, `image/webp`, `image/gif` | 10 MB; ≤ 8000×8000 px (≤ 40 MP) | Sent natively to vision models |
| PDF | `.pdf` | `application/pdf` | 20 MB; ≤ 100 pages | Native if model supports PDF, **plus** extracted text fallback |
| Word | `.docx` (**not** `.doc`, `.docm`) | OOXML zip | 10 MB | Text extracted; embedded images ignored in MVP |
| Excel | `.xlsx` (**not** `.xls`, `.xlsm`) | OOXML zip | 10 MB | Each sheet → bounded CSV/markdown table text (≤ 5,000 rows & 200k chars/file; truncation flagged) |
| CSV | `.csv` | `text/csv`/`text/plain` + UTF-8/16 sniff | 5 MB | Text, row cap as above |
| Text / Markdown | `.txt .md` | `text/plain` | 2 MB | Text as-is |

**Limits:** ≤ 5 files per message, ≤ 30 MB total per message, ≤ 20 unexpired files per user-conversation. Rejected by `413 file_too_large`, `415 unsupported_file_type`, `422 file_processing_failed`. OCR is P2 (extension point: extractor interface `Extractor { supports(mime): boolean; extract(file, signal): Promise<Extraction> }`; an OCR extractor registers like any other).

### 12.4 Validation & hardening pipeline

1. **Stream with a byte cap** — abort the request body as soon as the limit is exceeded (do not buffer unbounded in memory); use `Content-Length` as an early hint only.
2. **Extension allow-list**, then **magic-byte detection** (e.g., `file-type`); declared MIME must be compatible with detected MIME; mismatch → `unsupported_file_type`.
3. **Filename sanitization:** keep the original name only as *display metadata*: normalize Unicode, strip path separators/control/bidi characters, collapse whitespace, cap 120 chars. Storage key never includes it.
4. **Hash** (SHA-256) while streaming; stored for integrity and dedupe analytics.
5. **Image validation:** decode with pixel limit, reject animated/multi-frame, reject SVG, strip EXIF/GPS metadata, reject decompression-bomb dimensions.
6. **OOXML (docx/xlsx):** zip entry count ≤ 2,000; total uncompressed ≤ 100 MB and ratio ≤ 100:1 (zip-bomb guard); reject encrypted, reject macro payloads (`vbaProject.bin`), external relationships ignored (no fetching of remote resources).
7. **PDF:** reject encrypted/password-protected; page limit; text extraction only — **no JavaScript execution, no form actions, no external fetch**.
8. **Isolation:** extraction runs in a **child process / worker thread** with timeout (30 s) and memory cap; crash → file `failed`, API unaffected.
9. **Optional AV scan** (ClamAV via clamd socket) before `ready`.
10. **CSV/Excel formula injection:** extracted text is data only; any *export* of tabular data prefixes cells starting with `= + - @` with `'`.

### 12.5 File ↔ message relationships

- **Upload:** `POST /attachments` creates a `files` row (`role=input`, `conversation_id` set, `message_id` NULL). Owner = caller.
- **Attach:** `POST /messages` lists `fileId`s; in the creation transaction the server verifies `owner = caller`, `conversation_id` matches, `status = ready`, `message_id IS NULL`, not expired — then sets `message_id` and creates `image`/`document` message parts pointing at them. A file can be attached **once** (no reuse — consistent with the non-library requirement).
- **Generated:** the ArtifactSink creates `files` rows with `role=generated`, `message_id` = assistant message, `message_part_id` = the part.
- **Extraction:** `file_extractions(file_id, text, …)` one-to-one with input documents.

### 12.6 Retention

| Class | Default TTL | Starts | After expiry |
|---|---|---|---|
| Unattached upload (orphan) | 1 h | upload | Blob + row marked `deleted` |
| Attached input | 30 d | upload | Blob deleted; row tombstone (`expired→deleted`); message part shows `status: "expired"`; extracted text kept (A-14) |
| Generated output | 30 d | creation | Same |
| Rejected/failed | 24 h | creation | Blob deleted immediately if any |

Conversation deletion (soft) schedules its files for deletion in the next cleanup; purge deletes rows.

> **Decision D-7 — Binary TTL with metadata tombstones**
> - *Why:* Matches the requirement that files are temporary, limits storage growth and data exposure.
> - *Problem solved:* Unbounded disk growth; stale sensitive files; the UI breaking when blobs vanish.
> - *Implementation:* Expiry sets `expires_at`; cleanup job deletes blobs; parts render an explicit "expired" state; context builder substitutes extracted text or a stub.
> - *Trade-offs:* Users cannot re-download after 30 days or re-run old native attachments (documents fall back to extracted text; images become stubs).
> - *Scale path:* Longer TTL or "pin" flag (P2 permanent library extension point: `files.pinned_at`, no schema change needed beyond that column).

### 12.7 Storage abstraction

```ts
export interface StorageProvider {
  readonly kind: 'local' | 's3' | string;

  put(input: {
    key: string;                          // opaque, app-generated
    body: ReadableStream<Uint8Array> | Uint8Array;
    contentType: string;
    sizeHint?: number;
  }): Promise<{ key: string; sizeBytes: number; sha256: string; etag?: string }>;

  get(key: string, opts?: { range?: { start: number; end?: number } }):
    Promise<{ body: ReadableStream<Uint8Array>; sizeBytes: number; contentType?: string }>;

  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;                   // idempotent: missing key is success
  list?(prefix: string, opts?: { limit: number; cursor?: string }):
    Promise<{ keys: Array<{ key: string; sizeBytes: number; modifiedAt: Date }>; next?: string }>; // reconciliation

  /** Returns a short-lived direct-download URL, or null if the provider cannot (local). */
  getSignedUrl?(key: string, opts: { expiresInSec: number; disposition: 'inline' | 'attachment'; filename?: string; contentType?: string }):
    Promise<string | null>;
}
```

**Key scheme:** `files/{yyyy}/{mm}/{fileUuid}` — opaque, no user data, no original name, date prefix aids bulk cleanup and S3 lifecycle rules later.

**`LocalStorageProvider`:** root `STORAGE_LOCAL_ROOT` (e.g., `/var/lib/aichat/files`). Writes go to `tmp/` then `fsync` + atomic `rename` into place; resolves final path and verifies it stays under the root (path-traversal guard); directories `0700`, files `0600`, owned by the app user; free-space check + metric; disk-full → `503 storage_unavailable`.

**Application rule:** only `FileService`, `ArtifactSink`, and cleanup jobs import `StorageProvider`. Everyone else uses `FileService`. `files` stores `storage_provider`, `storage_bucket` (nullable), `storage_key`; a `StorageRegistry` resolves the provider **per row**, which is what makes mixed local+S3 operation and gradual migration possible.

### 12.8 Cleanup (two-phase, crash-safe)

1. **Mark:** `UPDATE files SET status='expired' WHERE expires_at < now() AND status NOT IN ('expired','deleted')` (batch 500).
2. **Delete blob:** `storage.delete(key)` (idempotent).
3. **Finalize:** `UPDATE files SET status='deleted', deleted_at=now()`.
A crash between steps is repaired by the next run (step 2 is idempotent). A **weekly reconciliation** job lists the storage prefix and (a) deletes blobs with no `files` row older than 24 h, (b) flags `ready` rows whose blob is missing as `status='missing'` (e.g., after a restore) so the UI shows "unavailable".

### 12.9 Secure exposure
- Clients never receive paths. API returns `downloadUrl: /api/files/{id}/content`.
- `GET /files/:id/content` authenticates the session, checks `owner_user_id = caller` (super admins and division admins **not** exempt, A-13), `status = ready`, not expired; streams with `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` for everything except validated images (`inline`), and `Content-Security-Policy: sandbox; default-src 'none'`. Supports `Range` for large files.
- Access to files in a soft-deleted conversation → `404`.
- `FileAccessService.getDownloadTarget()` returns `{kind:'stream'}` (local) or `{kind:'redirect', url}` (S3 signed URL, 60 s). Route code handles both, so the S3 migration doesn't alter the API contract.

### 12.10 S3 migration path (no redesign)
1. Implement `S3StorageProvider` (same interface; `put` multipart for large; `getSignedUrl` via presign).
2. Add provider to `StorageRegistry`; set `STORAGE_WRITE_PROVIDER=s3` — **new** files go to S3; **old** rows keep `storage_provider='local'` and keep working.
3. Because files are short-lived (≤ 30 d), the simplest cutover is *let local files expire*. If faster is needed, run a backfill job: copy blob → verify SHA-256 → single `UPDATE files SET storage_provider='s3', storage_bucket=…, storage_key=…` → delete local.
4. Enable bucket lifecycle rules as defense-in-depth for TTL; encryption at rest (SSE-KMS); private bucket + VPC endpoint.
5. Multi-node API becomes possible (no shared volume needed).
Zero changes to: message parts, chat logic, adapters, frontend contract (`downloadUrl` unchanged).

---

## 13. AI Response Persistence Architecture

### 13.1 What goes where

| Data | PostgreSQL | Storage (local temp) |
|---|---|---|
| Assistant message envelope (status, finish_reason, seq, timestamps) | `messages` | — |
| Ordered parts | `message_parts` (position, type, status) | — |
| Text / markdown | `message_parts.text_content` | — |
| Structured content (JSON, tables) | `message_parts.data` | — (large > 256 KB → treated as `generated_file`) |
| Images, PDFs, other binaries | `files` row (metadata: mime, size, sha256, dims, key) + `message_parts.file_id` | blob at `storage_key` |
| Generation state, errors, retries, usage | `generations`, `usage_records` | — |
| Document extraction text | `file_extractions` | — |

### 13.2 Representation example

```
messages #13 (assistant, status=complete, finish_reason=stop, generation_id=g1)
 ├─ part pos 0  text           text_content="Here is the summary …"       status=complete
 ├─ part pos 1  image          file_id=f_a (role=generated, 1024×1024)     status=complete
 └─ part pos 2  generated_file file_id=f_b (summary.pdf, 84 KB)            status=complete
```

**Ordering:** `position` is assigned by the orchestrator in the order parts *start* in the event stream (`part_started.index` → `position`), unique per message. Clients render by `position`.

### 13.3 Persisting partial / streaming output

1. On `part_started(text)`: insert part row `status='streaming'`, `text_content=''`.
2. On `text_delta`: append to an in-memory buffer; the **checkpointer** flushes every **1 s or 2 KB**, whichever first, using `UPDATE message_parts SET text_content = text_content || $chunk WHERE id=$id` (append-only, small writes; HOT-friendly with fillfactor 80) and updates `generations.heartbeat_at`/`last_event_seq`.
3. On `part_done`: final flush, `status='complete'`.
4. **On crash:** at most ~1 s / 2 KB of tail text is lost; the reaper marks the part `incomplete`, the message `incomplete`, the generation `failed(interrupted)`. The partial text remains visible with an "interrupted" indicator.

### 13.4 Failed / interrupted generations

| Terminal state | Message `status` | `finish_reason` | Parts | UI semantics |
|---|---|---|---|---|
| completed | `complete` | `stop`/`length`/`content_filter` | all `complete` | normal (`length` → "truncated by limit" hint) |
| cancelled | `incomplete` | `cancelled` | partial text kept, `status=incomplete` | "Stopped" + retry |
| failed (provider/timeout) | `failed` if no content else `incomplete` | `error`/`timeout` | partial kept | error banner + retry |
| interrupted (server crash/shutdown) | `incomplete` | `interrupted` | partial kept | "Interrupted" + retry |

Rules for later context building: only `complete` assistant messages are included. `incomplete` and `failed` ones are **excluded** in MVP to keep context clean (the user can retry; including partial answers is a P2 option). Retry creates a new generation + new assistant message and sets `superseded_by` on the old one (hidden from default listing, retained for audit).

### 13.5 Generated binaries (image/document outputs)

ArtifactSink flow (**store before expose**):
1. `part_started(image|file)` → create part `status='streaming'` (not announced to the client as downloadable).
2. `artifact_chunk` bytes stream into `StorageProvider.put()` (spooled to tmp, size-capped at `MAX_GENERATED_FILE_BYTES`, e.g., 25 MB).
3. `part_done` → validate (same pipeline as uploads: signature, image decode, pixel limits, AV optional); compute SHA-256.
4. **Transaction:** insert `files` row (`role=generated`, status `ready`, `expires_at`), set part `file_id` + `status='complete'`.
5. **Only then** emit SSE `part.completed {partId, fileId, downloadUrl}`. If any step fails → part `failed`, error event `file_processing_failed`, blob deleted, quota still settled for tokens actually used.

### 13.6 Retrieval
`GET /conversations/:id/messages` returns parts with normalized metadata and `downloadUrl` (or `status:"expired"`). Binary retrieval via §12.9. Generated and uploaded files are indistinguishable to the client except `origin: "user" | "assistant"`.

### 13.7 Cleanup
Same TTL job as §12.8; generated files have `role=generated`, so analytics can report storage by class. Conversation purge cascades to parts/files tombstones.

### 13.8 Future S3 support
Because parts reference `file_id` (not keys), and `files.storage_*` columns are the only place that know the backend, §12.10 applies unchanged to generated artifacts.

> **Decision D-8 — Persist before expose, checkpoint while streaming**
> - *Why:* History must be correct after any interruption; clients must never hold links to blobs that don't exist.
> - *Problem solved:* Lost partial answers; dangling file references; corrupted history.
> - *Implementation:* Append-only text checkpoints; ArtifactSink transaction; terminal-state finalizer that always runs.
> - *Trade-offs:* Up to ~1 s of tail text lost on a hard crash; extra DB writes (~1/s per active stream, trivial at A-2).
> - *Scale path:* Increase flush interval or batch checkpoints across streams if write volume rises.

---

## 14. Streaming Architecture

### 14.1 Transport
Server-Sent Events via Hono's `streamSSE` (`hono/streaming`). Rationale: one-way server→client stream, works through corporate proxies, automatic reconnection with `Last-Event-ID`, simpler than WebSockets. Client commands (send, cancel) are normal REST calls.

Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, `Connection: keep-alive`. Reverse proxy must disable buffering and allow ≥ 5 min read timeout (§24).

### 14.2 Generation state machine

```
pending ──start──► generating ──► completed
   │                  ├──────────► cancelled   (user cancel | detach timeout)
   │                  └──────────► failed      (shutdown-drain-expiry*: interrupted; provider error | timeout | interrupted | file processing)
   └──────────cancel/fail before start──────► cancelled | failed
```
\*Shutdown: drain first (§24.6); anything still running at drain expiry becomes `failed(interrupted)`.

| Transition | Trigger | Side effects |
|---|---|---|
| `pending → generating` | Runner claims generation (`runner_id`, `started_at`) | SSE `generation.state` |
| `generating → completed` | Terminal `finished` event + all parts persisted | Settle quota; usage record |
| `generating → cancelled` | `POST /cancel`, or no subscriber for 60 s (A-12) | Abort provider call; settle/release per §11.5 |
| `generating → failed` | Non-retryable error, retries exhausted, timeout, reaper | Settle/release per §11.5; error stored (sanitized) |

Terminal states are final and set exactly once with a conditional update (`WHERE status IN ('pending','generating')`) so cancel/complete races resolve deterministically.

### 14.3 Event protocol

Each SSE frame: `id: <seq>` (per-generation monotonically increasing), `event: <type>`, `data: <json>`.

| Event | Payload | Purpose |
|---|---|---|
| `generation.state` | `{state: "pending"\|"generating"\|…}` | Lifecycle |
| `message.created` | `{userMessageId, assistantMessageId}` | First event on stream |
| `context.truncated` | `{droppedMessages, droppedAttachments}` | UI notice |
| `part.started` | `{partId, position, type, mimeType?, name?}` | New part |
| `text.delta` | `{partId, delta}` | Text chunk (coalesced ≤ 20 events/s) |
| `part.completed` | `{partId, status, fileId?, downloadUrl?}` | Part finished (binary only after stored) |
| `progress` | `{stage, percent?}` | Job-style generations |
| `usage.updated` | `{inputTokens, outputTokens}` (optional, if provider streams usage) | Live meter |
| `generation.completed` | `{finishReason, usage:{input,output,quotaTokens}, remainingQuota}` | Terminal ✅ |
| `generation.cancelled` | `{reason}` | Terminal |
| `generation.failed` | `{error:{code,message,retryable}}` | Terminal ❌ |
| `snapshot` | `{message with parts so far}` | Sent when replay from buffer is impossible |
| `:heartbeat` (comment) | — | Every 15 s to defeat idle timeouts |
| *(extensibility)* `tool.*`, `reasoning.delta` | reserved | Unknown events must be ignored by clients |

### 14.4 Server-side mechanics
- `GenerationHandle` (in-process): `AbortController`, ring buffer of recent events (cap 2,000 events / 1 MB), subscriber set, `lastSubscriberAt`, current partial text.
- **Subscribe:** if `Last-Event-ID` is within the buffer → replay then go live. If not (buffer rolled, process restarted, or generation owned elsewhere/finished) → emit `snapshot` from PostgreSQL then continue live or emit the terminal event.
- **Detach timer:** when the subscriber count hits 0, start a 60 s timer; any re-attach clears it; expiry triggers cancel with reason `detached`.
- **Backpressure:** each subscriber has a bounded outbound queue; a client that cannot keep up (queue > 1 MB) is disconnected (it can reconnect and receive a snapshot) rather than stalling memory.
- **Streams hold no DB connection.** DB is touched only by the checkpointer and finalizer.
- **Concurrency guard:** per-node cap (`MAX_ACTIVE_GENERATIONS`, default 200); beyond it, new generations return `503 service_busy` with `Retry-After` *before* reserving quota.

### 14.5 Cancellation
- **Client cancel:** `POST /generations/:id/cancel` (idempotent, `202`). Handle's `AbortController.abort('user_cancel')` is passed to the adapter, which aborts the HTTP request/SDK stream. Finalizer persists partial text, marks `cancelled`, settles per §11.5.
- **Client disconnect without cancel:** see detach timer (A-12).
- **Provider cancellation caveat:** providers may bill tokens already generated; usage may not be reported on abort → estimated-output settlement (§11.5).

### 14.6 Non-text generation (image/document)

| Situation | Behavior |
|---|---|
| Provider call completes in ≤ ~60 s | Treated as a normal generation; stream shows `progress` then `part.completed` |
| Longer-running | Same `generation` entity in `generating`; stream shows `progress`; client may disconnect and later `GET /generations/:id` or reattach; timeouts extended per model (`models.config.timeoutMs`, default 180 s) |
| Provider offers async job API | Adapter polls internally and emits `progress`; persistence/quota unchanged |
| Artifact exposure | Always after storage + validation (§13.5) |
No second job system is needed: the generation record **is** the job record.

> **Decision D-9 — SSE with replayable events and snapshot fallback**
> - *Why:* Reliable UX on unreliable networks without a WebSocket stack.
> - *Problem solved:* Lost chunks on reconnect; duplicated text in UI; stuck spinners.
> - *Implementation:* Sequence IDs, ring buffer replay, DB snapshot fallback, heartbeats.
> - *Trade-offs:* Single-owner in-memory buffers (A-4).
> - *Scale path:* Redis Streams as the buffer (`XADD/XREAD` by `generation_id`) enables any node to serve any stream with the same event protocol.

---

## 15. Security Architecture

### 15.1 Authentication
- **Email + password** (locally managed credentials — A-15). `POST /api/auth/login {email, password}`; passwords hashed with **argon2id** (`Bun.password`, memory ≥ 64 MiB) and never logged or returned. Comparison is constant-time and failures return a generic `unauthenticated` (no user enumeration).
- Session: opaque random ID in a `__Host-session` cookie (`HttpOnly; Secure; SameSite=Lax; Path=/`), stored **server-side in PostgreSQL** (`sessions`, keyed by `sha256(cookie value)`) — idle timeout 8 h, absolute 24 h, **rotated on login and on password change**. Revocation = delete/mark row.
- **Disabled/deleted users:** every request joins `sessions → users`; `status != 'active'` → `401` and the session is revoked (effective immediately, no cache).
- **Account protection:** per-account lockout after 8 consecutive failures (15 min) plus a per-IP limit on the login route (§15.4). `login`, `logout`, `failed_login`, `password_change`, and admin `password_reset` are audit events.
- **Provisioning:** administrators create accounts (FR-AUTH-2). A `super_admin` can provision accounts for any role and any division; a division `admin` can provision accounts with role `user` strictly within their assigned division. First login forces a password change via `must_change_password`. While that flag is set, every endpoint except `GET /me`, `POST /me/password`, and `DELETE /auth/session` returns `403 password_change_required`. No self-registration and no email delivery in MVP (self-service reset is P2).
- **Bootstrap:** the first super admin is created by a `bootstrap-admin` CLI/migration with a one-time password and `role = super_admin` (FR-AUTH-8) — this replaces the break-glass question (Q-7, closed).
- **CSRF:** SameSite=Lax cookie **plus** a signed CSRF token. The SPA and API are served from **different subdomains of the same registrable site** (e.g. `app.corp.example` + `api.corp.example`), so the session cookie is still sent by the browser on same-site requests. `POST /auth/login` (and every session rotation) returns a `csrfToken` in the response body: `nonce . base64url(HMAC-SHA256(SESSION_SECRET, nonce + ":" + issuedAt))`, verified statelessly with a **12 h** max age. The SPA keeps it in memory and sends it as `X-CSRF-Token` on every non-GET `/api` request; the server also validates `Origin` against `ALLOWED_ORIGINS`. A missing/invalid token or origin → `403 forbidden`. `POST /auth/login` itself is the exception — it is validated by `Origin` alone, because it is the call that issues the token; the `SameSite=Lax` cookie and the strict origin allow-list bound the resulting login-CSRF risk.
- **SSO/OIDC is P2** (extension point: `users.idp_subject`, retained nullable). MFA is out of MVP scope (Q-14, closed v1.2).

### 15.2 Authorization & RBAC

| Capability | user | admin (division) | super_admin |
|---|---|---|---|
| Own conversations, messages, files, quota usage | ✅ | ✅ (own) | ✅ (own) |
| Other users' conversation content or file contents | ❌ (A-13) | ❌ (A-13) | ❌ (A-13) |
| List / search users | ❌ | ✅ (own division only) | ✅ (all / any division) |
| Create user (`role = 'user'`) | ❌ | ✅ (in own division only) | ✅ (any division) |
| Create admin / super_admin | ❌ | ❌ | ✅ |
| View user detail / profile | ❌ | ✅ (own division only) | ✅ (all) |
| Update user `displayName`, `status` (`active`/`disabled`) | ❌ | ✅ (own division only) | ✅ (all) |
| Update user `role` or `division_id` | ❌ | ❌ | ✅ |
| Reset user password (`/admin/users/:id/password/reset`) | ❌ | ✅ (own division only) | ✅ (all) |
| Manage divisions (`/admin/divisions`) | ❌ | ❌ | ✅ |
| Manage quota policies & user quota adjustments | ❌ | ❌ | ✅ |
| Manage models, providers, and pricing | ❌ | ❌ | ✅ |
| View provider health, circuit state, and run tests | ❌ | ❌ | ✅ |
| View aggregated usage analytics across all divisions | ❌ | ❌ | ✅ |
| View system error explorer (`error_events`) | ❌ | ❌ | ✅ |
| Search system-wide audit logs (`audit_logs`) | ❌ | ❌ | ✅ |
| Manage platform system settings | ❌ | ❌ | ✅ |

**Division-scoped authorization rules (`admin` role):**
1. **Division binding:** A user with `role = 'admin'` must have `division_id IS NOT NULL` (enforced at both DB schema and application layer).
2. **User CRUD isolation:** When a division admin interacts with `/api/admin/users*`:
   - `GET /api/admin/users`: Query results are strictly filtered to `division_id = caller.division_id`. Any client-supplied `divisionId` filter that does not match the caller's division is rejected or overridden.
   - `POST /api/admin/users`: The new user's `divisionId` is forced to `caller.division_id`. The requested `role` must be `'user'`; any attempt to set `admin` or `super_admin` returns `403 forbidden`.
   - `GET /api/admin/users/:id` & `PATCH /api/admin/users/:id`: The target user is checked for `target.division_id === caller.division_id`. If the target user belongs to a different division (or has no division), the repository returns **404** (not 403) to prevent leaking account existence across divisions.
   - `PATCH /api/admin/users/:id`: Division admins can only modify `displayName` and `status` (`active` | `disabled`). Attempts to supply `role` or `divisionId` return `403 forbidden`.
   - `POST /api/admin/users/:id/password/reset`: Permitted only if `target.division_id === caller.division_id`; otherwise returns `404`.
3. **Privilege escalation prevention:** Division admins cannot modify their own role, cannot reassign their own division, and cannot demote or disable themselves.
4. **Super Admin privileges:** Callers with `role = 'super_admin'` have unrestricted platform-wide access. The system enforces **last-super-admin protection**: an update or deactivation that would leave zero active `super_admin` accounts is rejected with `409 conflict`.

**Object-level authorization is structural:** repositories require an `AuthContext` and always filter on `user_id` (or `division_id` for division admin user queries); accessing another user's resource returns **404** (not 403) to avoid existence leaks. A lint/test asserts no repository method for user-owned entities is callable without an `AuthContext`.

### 15.3 Isolation
- User isolation as above (conversations, messages, parts, files, generations, usage self-view).
- Divisions serve two distinct purposes:
  1. Quota policy resolution and model access visibility.
  2. Administrative boundary for delegated division administrators (`admin`).
- Org/workspace isolation: not applicable in single-tenant MVP (A-1); `organization_id` would be added to root tables with row-level security later.
- Defense in depth: PostgreSQL **RLS** on `conversations/messages/message_parts/files` keyed on `current_setting('app.user_id')` is a **P1 hardening** step (set per transaction); application filters remain primary.

### 15.4 Rate limiting & abuse control
Separate from token quota; protects the service and providers.

| Scope | Default | Notes |
|---|---|---|
| Per IP (unauthenticated + auth endpoints) | 60 req/min | login endpoint stricter (10/min); account lockout after 8 consecutive failures (FR-AUTH-5) |
| Per user — general API | 300 req/min | |
| Per user — `POST messages` | 20/min | plus concurrency limit §11.4 |
| Per user — uploads | 30/min, 100 MB/10 min | |
| Global — per provider concurrent calls | configurable (`providers.config.maxConcurrency`) | protects provider rate limits; excess → queued ≤ 10 s then `provider_rate_limited` |

Implementation: `RateLimiter` interface; in-memory token bucket (single node) or Redis (`INCR`+TTL / Lua token bucket) when ≥ 2 nodes or already available. Responses include `Retry-After` and `RateLimit-*` headers.

### 15.5 Request validation
Zod schemas on every route (params, query, body, headers); reject unknown fields on mutations; body size limits (JSON 1 MB; message text ≤ 100k chars; multipart per §12.3); UUID format checks; strict content-type enforcement; pagination caps.

### 15.6 Secrets & provider keys
- Provider API keys are supplied through the **process environment / `.env` secret file** (A-16). They are never stored in the database, code, or images: `providers.secret_ref` holds the **environment variable name** (e.g. `OPENAI_API_KEY`), resolved at boot. `GET /admin/providers/:id` exposes the `secretRef` name and health status, never the key.
- **Rotation** is an operator action: update the env/secret file and restart the process. A rolling restart (standby node, §24.6) avoids downtime; this satisfies NFR-SEC-2 (no code rebuild or redeploy). Keys are separated per environment.
- `.env`/secret files are excluded from version control, mounted `0600`, owned by the app user, and **not** included in database backups.
- Winston log redaction paths for `authorization`, `apiKey`, `x-api-key`, `password`, cookies; CI secret scanning; provider-console spend caps as a backstop.
- **Egress allow-list** from the API host to provider domains only.
- Browser never contacts providers; no provider URLs/IDs are exposed except display names.

### 15.7 CORS & headers
- The SPA and API are served from **different subdomains of the same site** (e.g. `app.corp.example` + `api.corp.example`), so CORS is required with an **exact-origin allow-list** (`ALLOWED_ORIGINS`, no `*`), `credentials: true`, `Vary: Origin`, and `Access-Control-Max-Age: 600`. Allowed request headers: `Content-Type`, `X-CSRF-Token`, `Idempotency-Key`, `X-Request-Id`. Because it is same-*site*, `SameSite=Lax` is sufficient and `__Host-session` remains valid.
- `hono/secure-headers`: `Strict-Transport-Security` (1 y, includeSubDomains), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` / `frame-ancestors 'none'`, API CSP `default-src 'none'`; `Cache-Control: no-store` for API JSON.

### 15.8 Prompt-injection and malicious-document considerations
- **Blast radius is small by design:** MVP has no tools, no browsing, no code execution; a poisoned document can at worst influence the text answer.
- Extracted text is wrapped in explicit untrusted-content delimiters and the system prompt states that instructions inside attachments must be ignored (best-effort mitigation, not a guarantee).
- **Exfiltration via rendering:** the frontend contract requires that assistant Markdown is sanitized (no raw HTML) and that **remote images in assistant output are not auto-loaded** (or are proxied/allow-listed) to prevent data leakage through image URLs.
- When tools/RAG/MCP arrive (P2), each requires a design review: per-tool authorization, user confirmation for side effects, output filtering, and egress control.
- Documents are untrusted binaries: mitigations in §12.4 (zip-bomb limits, macro rejection, no JS execution, sandboxed extraction, optional AV, rendering never executed server-side).

### 15.9 Audit logging
- `audit_logs` is append-only (DB role lacks UPDATE/DELETE; optional hash chain `prev_hash` for tamper evidence).
- Events: login/logout/failed login, password change, admin password reset, user create/disable/role change, quota policy change/adjustment/grant, model/provider create/update/enable/disable, `secret_ref` change (reference only — the key itself is never an audit value), admin reads of other users' usage, export actions, file download denials (security), settings changes, break-glass (future).
- Each row: `actor_user_id`, `action`, `target_type/id`, `before/after` (secrets redacted), `request_id`, `ip`, `user_agent_hash`, `created_at`. Written **in the same transaction** as the change.

### 15.10 Sensitive data handling
- Conversation text and file contents are **not logged** (`LOG_CONTENT=false`); debug capture requires an explicit, time-boxed flag with audit entry.
- Error responses and stored `error_detail` are sanitized (no stack traces, provider bodies, or keys); raw provider errors go to restricted logs with redaction. A stack `trace` may appear in API error envelopes **only when `NODE_ENV=development`** (sanitized of keys/provider bodies/SQL parameters) and is never returned in staging or production.
- Encryption in transit everywhere (TLS to DB if remote, TLS to providers); encryption at rest via full-disk/volume encryption and managed-DB encryption (infrastructure requirement).
- User-initiated deletion honored (§12.6); backups age out per retention policy.
- Data-sharing with providers: use enterprise/API terms that exclude training on data; document per provider (Q-3, closed v1.2). Users see a notice that content is sent to the selected provider.
- Minimize PII sent upstream: `metadata.userIdHash` is a keyed hash, not email.

---

## 16. API Specification

### 16.1 Conventions
- Base path `/api` (**unversioned**); JSON (`application/json`), `camelCase` fields; IDs are UUIDv7 strings; timestamps ISO-8601 UTC.
- Auth: session cookie (§15.1). Every response carries `X-Request-Id` (client-supplied value is accepted only if it matches `^[A-Za-z0-9_-]{8,64}$`, else replaced). The request id is **not** repeated in response bodies.
- Pagination: cursor-based `?limit=50&cursor=…` → `data` is `{ items: [...], nextCursor: string | null }`.
- Mutations that create generations require `Idempotency-Key` (UUID).
- **Success envelope** (all 2xx with a body):
```json
{ "status": "ok", "message": "Signed out.", "data": { "…": "…" } }
```
`message` is display text and may be empty; the `data` key is **omitted** when the operation returns nothing.
- **Error envelope** (all non-2xx):
```json
{ "status": "error", "code": "quota_exceeded", "message": "Your monthly token quota is exhausted.",
  "retryable": false, "details": { "resetAt": "2026-11-01T00:00:00Z", "remainingTokens": 0 } }
```
`trace` is present **only when `NODE_ENV=development`** (sanitized), never in staging/production.
- **Envelope exemptions** (raw bodies): `GET /api/files/:id/content`, SSE frames (§14.3), `/healthz`, `/readyz`.
- **No provider-specific fields** appear in any contract; models are described by normalized capabilities.

### 16.2 Endpoint overview

| Group | Method & path | Description | Role |
|---|---|---|---|
| **Auth** | `POST /auth/login` | Email + password login; sets the `__Host-session` cookie (`401` on bad credentials; lockout-aware) | public |
| | `DELETE /auth/session` | Logout; destroy the current session | user |
| **Me** | `GET /me` | Profile, role, division, `mustChangePassword` | user |
| | `POST /me/password` | Change own password (revokes other sessions) | user |
| | `GET /me/quota` | Current period limits, used, reserved, remaining, resetAt | user |
| | `GET /me/usage?from&to&groupBy=day\|model` | Own usage | user |
| **Models** | `GET /models` | Models available to caller | user |
| **Conversations** | `POST /conversations` | Create (with `modelId`) | user |
| | `GET /conversations` | List own | user |
| | `GET /conversations/:id` | Detail | user |
| | `PATCH /conversations/:id` | Rename | user |
| | `DELETE /conversations/:id` | Soft-delete | user |
| **Messages** | `GET /conversations/:id/messages` | Messages + parts (cursor by `seq`) | user |
| | `POST /conversations/:id/messages` | Send message → generation (idempotent) | user |
| | `POST /conversations/:id/messages/:mid/retry` | Retry failed/cancelled generation | user |
| **Generations** | `GET /generations/:id` | State, usage, error | user |
| | `GET /generations/:id/stream` | SSE stream (replayable) | user |
| | `POST /generations/:id/cancel` | Cancel | user |
| **Attachments** | `POST /conversations/:id/attachments` | Multipart upload (≤5 files) | user |
| | `GET /attachments/:id` | Status (processing/ready/…) | user |
| | `DELETE /attachments/:id` | Delete unattached upload | user |
| | `GET /files/:id/content` | Download/inline view | user (owner) |
| **Admin – users** | `GET /admin/users` | List/search users (`admin` scoped to own division; `super_admin` all) | admin, super_admin |
| | `POST /admin/users` | Create/pre-provision user (`admin` in own division with `role=user`; `super_admin` any role/division) | admin, super_admin |
| | `GET /admin/users/:id` | Detail (`admin` own division only; `super_admin` any) | admin, super_admin |
| | `PATCH /admin/users/:id` | Update profile / status (`admin` displayName/status in own division; `super_admin` role/division/status/profile) | admin, super_admin |
| | `POST /admin/users/:id/password/reset` | Reset a user's password (`admin` own division only; `super_admin` any) | admin, super_admin |
| **Admin – divisions** | `GET/POST /admin/divisions`, `PATCH /admin/divisions/:id` | Manage divisions | super_admin |
| **Admin – quota** | `GET/PUT /admin/quota-policies/:scope/:id?` | Policy by `global`/`division`/`user` | super_admin |
| | `POST /admin/users/:id/quota/adjustments` | Grant/claw back with reason | super_admin |
| | `GET /admin/users/:id/quota` | Period state + ledger | super_admin |
| **Admin – models** | `GET/POST /admin/providers`, `PATCH /admin/providers/:id` | Provider config including `secretRef` (the env var name; the key itself is never accepted or returned — A-16) | super_admin |
| | `GET/POST /admin/models`, `PATCH /admin/models/:id` | Registry, capabilities, status, pricing | super_admin |
| | `GET /admin/providers/health` | Latest health + circuit state | super_admin |
| | `POST /admin/providers/:id/test` | Run health check now | super_admin |
| **Admin – reporting** | `GET /admin/usage?from&to&groupBy=user\|model\|provider\|day\|month\|division` | Aggregated usage | super_admin |
| | `GET /admin/errors?from&to&category` | Sanitized system errors | super_admin |
| | `GET /admin/audit-logs?…` | Audit log search | super_admin |
| **Admin – settings** | `GET/PUT /admin/system-settings/:key` | Platform system settings | super_admin |
| **Ops** | `GET /healthz`, `GET /readyz` | Liveness, readiness | internal |

### 16.3 Models

`GET /api/models` →
```json
{ "items": [
  { "id": "0192…", "displayName": "Claude (Sonnet class)", "providerLabel": "Anthropic",
    "status": "active", "deprecation": null,
    "capabilities": { "streaming": true, "vision": true, "documents": { "pdf": true },
                      "imageGeneration": false, "documentGeneration": false,
                      "contextWindow": 200000, "maxOutputTokens": 8192 },
    "limits": { "maxFilesPerMessage": 5, "maxImagesPerMessage": 10 } } ] }
```

### 16.4 Conversations

`POST /api/conversations`
```json
{ "modelId": "0192…", "title": null }
```
`201`
```json
{ "id": "0192…", "modelId": "0192…", "title": "New conversation", "createdAt": "…", "modelLocked": false }
```
`modelLocked` becomes `true` after the first message. Errors: `422 model_unavailable`, `404`.

### 16.5 Send message (idempotent)

`POST /api/conversations/:id/messages`
Headers: `Idempotency-Key: 3f2b…` (required)
```json
{
  "parts": [
    { "type": "text", "text": "Summarize the attached contract and list risks." },
    { "type": "file", "fileId": "0192…" }
  ],
  "options": { "maxOutputTokens": 4000 }
}
```
`202 Accepted`
```json
{
  "userMessage": { "id": "…", "seq": 12, "role": "user", "status": "complete", "parts": [ … ] },
  "assistantMessage": { "id": "…", "seq": 13, "role": "assistant", "status": "streaming", "parts": [] },
  "generation": { "id": "…", "status": "pending", "streamUrl": "/api/generations/…/stream" },
  "quota": { "reservedTokens": 24310, "remainingTokens": 475690 }
}
```
Server-side rules: validates file ownership/readiness/capability match (`vision`/`pdf`), `est_input ≤ maxInput`, reserves quota, creates records, starts the runner.
Errors: `409 generation_in_progress`, `409 file_not_ready`, `422 unsupported_for_model`, `422 context_too_large`, `422 idempotency_key_reuse`, `429 quota_exceeded | concurrency_limit | rate_limited`, `503 service_busy`.

**Idempotency design**

- Table `idempotency_keys(user_id, key, endpoint, request_hash, response_status, response_body, created_at, expires_at)` with **PRIMARY KEY (user_id, key)**; TTL 24 h.
- `request_hash = sha256(canonical JSON of {conversationId, parts, fileIds, options})`.
- The idempotency insert, quota reservation, message/generation creation, and file attachment happen in **one transaction**. A concurrent duplicate blocks on the unique index until the first commits, then reads the stored response — there is no "in-progress limbo" state.
- Same key + same hash → return the original response (`Idempotency-Replayed: true`), including the same `generation.id` (client then simply attaches to the stream). Same key + different hash → `422 idempotency_key_reuse`.
- Provider call starts **after** commit; if the process dies between commit and start, the generation is `pending` and picked up by the reaper/resumer (`pending` older than 30 s with no runner → `failed(interrupted)` + release, user retries safely).

| Scenario | Behavior |
|---|---|
| User clicks Send repeatedly | Frontend reuses the same key per user action → one generation; additional calls replay the same response. Even without key reuse, `generation_in_progress (409)` blocks a second concurrent generation in the conversation (partial unique index). |
| Browser retries POST (timeout/5xx) | Same key → same response; no second reservation. |
| Network drops after server accepted | Client retries POST with the same key → learns IDs → `GET stream` with `Last-Event-ID` if known, else full snapshot. |
| Reconnect mid-generation | `GET /generations/:id/stream` replays missing events or sends `snapshot`; generation never restarted. |
| Provider replies after client left | Generation continues (A-12), persisted and settled; if nobody re-attaches within 60 s it's cancelled with partial saved. User sees result on reload. |
| Page reload while generating | `GET /conversations/:id/messages` shows streaming assistant message with persisted partial text; client attaches to stream via `generation.id`. |

### 16.6 Stream

`GET /api/generations/:id/stream` (header `Last-Event-ID` optional)
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

…

id: 87
event: generation.completed
data: {"finishReason":"stop","usage":{"inputTokens":18250,"outputTokens":1190,"quotaTokens":19440},"remainingQuota":455920}
```

### 16.7 Messages listing

`GET /api/conversations/:id/messages?limit=50&before=<seq>` →
```json
{ "items": [
  { "id":"…","seq":13,"role":"assistant","status":"complete","finishReason":"stop","createdAt":"…",
    "generationId":"…",
    "parts":[
      {"id":"…","position":0,"type":"text","format":"markdown","text":"…"},
      {"id":"…","position":1,"type":"image","origin":"assistant","file":{"id":"…","mimeType":"image/png","width":1024,"height":1024,"status":"available","downloadUrl":"/api/files/…/content"}},
      {"id":"…","position":2,"type":"generated_file","file":{"id":"…","name":"summary.pdf","mimeType":"application/pdf","sizeBytes":84211,"status":"expired"}}
    ] } ], "nextCursor": null }
```

### 16.8 Attachments

`POST /api/conversations/:id/attachments` (`multipart/form-data`, field `files`)
`201 | 202`
```json
{ "items": [
  { "id":"…","name":"contract.pdf","kind":"document","mimeType":"application/pdf","sizeBytes":1048576,
    "status":"processing","pageCount":null,"expiresAt":"2026-10-08T15:00:00Z" } ] }
```
Per-file failures are reported per item (`status:"rejected", error:{code:"unsupported_file_type"}`) with overall `207`-style semantics expressed in the body (HTTP `201` if at least one accepted, `4xx` if all failed).

### 16.9 Quota & usage (user and super admin)

`GET /api/me/quota`
```json
{ "period": {"start":"2026-10-01T00:00:00Z","end":"2026-11-01T00:00:00Z"},
  "limitTokens": 500000, "usedTokens": 20000, "reservedTokens": 24310, "remainingTokens": 455690,
  "limits": { "maxInputTokensPerRequest": 100000, "maxOutputTokensPerRequest": 8000, "maxConcurrentGenerations": 2 } }
```

`PUT /api/admin/quota-policies/user/:userId`
```json
{ "monthlyTokens": 1000000, "maxInputTokensPerRequest": 150000, "maxOutputTokensPerRequest": 16000,
  "maxConcurrentGenerations": 3, "applyToCurrentPeriod": true, "reason": "Legal team pilot" }
```
Fields set to `null` inherit from division/global. Requires `role = 'super_admin'`.

`POST /api/admin/users/:id/quota/adjustments`
```json
{ "tokens": 200000, "reason": "Incident follow-up", "expiresAtPeriodEnd": true }
```
Requires `role = 'super_admin'`.

`GET /api/admin/usage?from=2026-10-01&to=2026-10-08&groupBy=model` →
```json
{ "items":[ { "key":{"modelId":"…","displayName":"…","provider":"anthropic"},
              "requests":1523,"failedRequests":12,"inputTokens":8123412,"outputTokens":912331,
              "quotaTokens":9035743,"estimatedCostUsd":41.27,"usageSource":{"provider":0.998,"estimated":0.002} } ] }
```
Requires `role = 'super_admin'`.

### 16.10 Super Admin: models/providers

`PATCH /api/admin/models/:id`
```json
{ "status": "disabled",
  "capabilities": { "vision": true, "documents": { "pdf": true }, "contextWindow": 200000, "maxOutputTokens": 8192 },
  "defaultMaxOutputTokens": 4096, "quotaWeight": 1.0 }
```
Requires `role = 'super_admin'`. Every admin mutation returns the updated resource and writes `audit_logs`.

## 17. PostgreSQL Data Model

### 17.1 Overview (ERD, abbreviated)

```
divisions ─< users ─< sessions
   │           │
   │           ├─< conversations >─ models >─ providers
   │           │        │               └─< model_pricing
   │           │        ├─< messages ─< message_parts >─ files ─ file_extractions
   │           │        └─< generations ─ quota_reservations ─ usage_records
   │           ├─< quota_periods ─< quota_ledger
   │           └─< idempotency_keys
quota_policies (global|division|user)      jobs      audit_logs      error_events      system_settings      usage_daily
```

### 17.2 Core DDL (condensed; enums as `text` + `CHECK` for easy evolution)

```sql
CREATE EXTENSION IF NOT EXISTS citext;

-- Identity ------------------------------------------------------------------
CREATE TABLE divisions (
  id uuid PRIMARY KEY, name text NOT NULL UNIQUE, external_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  idp_subject text UNIQUE,                     -- NULL in MVP; reserved for future OIDC (A-15)
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,                 -- argon2id
  password_updated_at timestamptz NOT NULL DEFAULT now(),
  must_change_password boolean NOT NULL DEFAULT true,
  failed_login_attempts int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','super_admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  division_id uuid REFERENCES divisions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  CONSTRAINT users_admin_division_check CHECK (role <> 'admin' OR division_id IS NOT NULL)
);

CREATE TABLE sessions (
  id text PRIMARY KEY,                       -- sha256(cookie value)
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  ip inet, user_agent_hash text
);
CREATE INDEX ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_active_exp ON sessions (expires_at) WHERE revoked_at IS NULL;

-- Registry ------------------------------------------------------------------
CREATE TABLE providers (
  id uuid PRIMARY KEY, key text NOT NULL UNIQUE, display_name text NOT NULL,
  adapter text NOT NULL,                       -- 'openai' | 'anthropic' | 'gemini' | …
  base_url text, secret_ref text NOT NULL,     -- env var NAME holding the API key (A-16); never the key
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  config jsonb NOT NULL DEFAULT '{}',          -- timeouts, maxConcurrency, adapter-specific
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE models (
  id uuid PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES providers(id),
  key text NOT NULL UNIQUE,                    -- internal slug
  api_model_id text NOT NULL,                  -- provider identifier (admin-entered)
  display_name text NOT NULL, description text,
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('active','disabled')),
  capabilities jsonb NOT NULL,                 -- see §9.2 ModelCapabilities (+schemaVersion)
  context_window int NOT NULL CHECK (context_window > 0),
  max_output_tokens int NOT NULL CHECK (max_output_tokens > 0),
  default_max_output_tokens int NOT NULL,
  quota_weight numeric(8,3) NOT NULL DEFAULT 1.000 CHECK (quota_weight > 0),
  config jsonb NOT NULL DEFAULT '{}',
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_pricing (
  id uuid PRIMARY KEY, model_id uuid NOT NULL REFERENCES models(id),
  effective_from timestamptz NOT NULL,
  input_micros_per_mtok bigint NOT NULL, output_micros_per_mtok bigint NOT NULL,
  cached_input_micros_per_mtok bigint, currency char(3) NOT NULL DEFAULT 'USD',
  UNIQUE (model_id, effective_from)
);

-- Conversations --------------------------------------------------------------
CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  model_id uuid NOT NULL REFERENCES models(id),
  title text NOT NULL DEFAULT 'New conversation',
  message_count int NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX conversations_user_recent ON conversations (user_id, COALESCE(last_message_at, created_at) DESC, id)
  WHERE deleted_at IS NULL;

-- Enforce "one model per conversation" once messages exist
CREATE FUNCTION forbid_model_switch() RETURNS trigger AS $$
BEGIN
  IF NEW.model_id <> OLD.model_id AND OLD.message_count > 0 THEN
    RAISE EXCEPTION 'conversation model is immutable after first message' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER conversations_model_lock BEFORE UPDATE OF model_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION forbid_model_switch();

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  status text NOT NULL CHECK (status IN ('streaming','complete','incomplete','failed')),
  finish_reason text CHECK (finish_reason IN ('stop','length','content_filter','cancelled','error','timeout','interrupted')),
  superseded_by uuid REFERENCES messages(id),
  metadata jsonb NOT NULL DEFAULT '{}',        -- e.g. contextTruncated
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE (conversation_id, seq)
);

CREATE TABLE message_parts (
  id uuid PRIMARY KEY,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position int NOT NULL,
  type text NOT NULL CHECK (type IN ('text','image','document','generated_file','structured','tool_call','tool_result','reasoning')),
  status text NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming','complete','incomplete','failed')),
  text_content text,                           -- for 'text'
  data jsonb NOT NULL DEFAULT '{}',            -- type-specific + schemaVersion
  file_id uuid,                                -- FK added after files table
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, position)
) WITH (fillfactor = 80);

-- Files ----------------------------------------------------------------------
CREATE TABLE files (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  message_part_id uuid,
  role text NOT NULL CHECK (role IN ('input','generated')),
  kind text NOT NULL CHECK (kind IN ('image','document','other')),
  display_name text NOT NULL,                  -- sanitized original name (display only)
  declared_mime text, detected_mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 char(64) NOT NULL,
  storage_provider text NOT NULL,              -- 'local' | 's3'
  storage_bucket text,
  storage_key text NOT NULL,                   -- opaque
  status text NOT NULL CHECK (status IN ('uploading','validating','processing','ready','rejected','failed','missing','expired','deleted')),
  error_code text,
  width int, height int, page_count int,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
ALTER TABLE message_parts ADD FOREIGN KEY (file_id) REFERENCES files(id);
CREATE INDEX files_owner_conv ON files (owner_user_id, conversation_id);
CREATE INDEX files_expiry ON files (expires_at) WHERE status NOT IN ('expired','deleted');
CREATE INDEX files_message ON files (message_id);

CREATE TABLE file_extractions (
  file_id uuid PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','done','failed','unsupported')),
  extractor text, text text, char_count int, token_estimate int,
  truncated boolean NOT NULL DEFAULT false, page_count int, error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Generations ----------------------------------------------------------------
CREATE TABLE generations (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  model_id uuid NOT NULL REFERENCES models(id),
  user_message_id uuid NOT NULL REFERENCES messages(id),
  assistant_message_id uuid NOT NULL REFERENCES messages(id),
  request_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','generating','completed','cancelled','failed')),
  runner_id text, attempt_count int NOT NULL DEFAULT 0,
  est_input_tokens int, max_output_tokens int,
  context_info jsonb NOT NULL DEFAULT '{}',    -- truncation details
  provider_request_id text,
  error_code text, error_detail jsonb,         -- sanitized
  cancel_reason text, cancel_requested_at timestamptz,
  heartbeat_at timestamptz, last_event_seq int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
);
-- At most one active generation per conversation:
CREATE UNIQUE INDEX one_active_generation_per_conversation
  ON generations (conversation_id) WHERE status IN ('pending','generating');
CREATE INDEX generations_active_user ON generations (user_id) WHERE status IN ('pending','generating');
CREATE INDEX generations_stale ON generations (heartbeat_at) WHERE status = 'generating';

-- Quota ----------------------------------------------------------------------
CREATE TABLE quota_policies (
  id uuid PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('global','division','user')),
  division_id uuid REFERENCES divisions(id), user_id uuid REFERENCES users(id),
  monthly_tokens bigint, max_input_tokens_per_request int, max_output_tokens_per_request int,
  max_concurrent_generations int, allowed_model_ids uuid[],
  updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope='global' AND division_id IS NULL AND user_id IS NULL)
      OR (scope='division' AND division_id IS NOT NULL AND user_id IS NULL)
      OR (scope='user' AND user_id IS NOT NULL AND division_id IS NULL))
);
CREATE UNIQUE INDEX quota_policy_scope_uq ON quota_policies (scope, COALESCE(division_id, user_id, '00000000-0000-0000-0000-000000000000'));

CREATE TABLE quota_periods (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  scope_type text NOT NULL DEFAULT 'total' CHECK (scope_type IN ('total','provider','model')),
  scope_id uuid,                                -- NULL for total
  period_start timestamptz NOT NULL, period_end timestamptz NOT NULL,
  base_limit_tokens bigint NOT NULL CHECK (base_limit_tokens >= 0),
  adjustment_tokens bigint NOT NULL DEFAULT 0,
  used_tokens bigint NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  reserved_tokens bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  limits jsonb NOT NULL DEFAULT '{}',           -- snapshot: max input/output, concurrency
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quota_periods_uq
  ON quota_periods (user_id, scope_type, COALESCE(scope_id,'00000000-0000-0000-0000-000000000000'), period_start);

CREATE TABLE quota_reservations (
  id uuid PRIMARY KEY,
  generation_id uuid NOT NULL UNIQUE REFERENCES generations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  period_id uuid NOT NULL REFERENCES quota_periods(id),
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens > 0),
  settled_tokens bigint,
  status text NOT NULL CHECK (status IN ('active','settled','released','expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), finalized_at timestamptz
);
CREATE INDEX quota_res_active_exp ON quota_reservations (expires_at) WHERE status = 'active';

CREATE TABLE quota_ledger (                     -- append-only
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL, period_id uuid NOT NULL, generation_id uuid,
  entry_type text NOT NULL CHECK (entry_type IN ('period_open','reserve','settle','release','expire_release','adjust','grant')),
  tokens bigint NOT NULL,                       -- magnitude; semantics per entry_type
  used_after bigint NOT NULL, reserved_after bigint NOT NULL,
  actor_user_id uuid, reason text, request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_ledger_user_time ON quota_ledger (user_id, created_at DESC);
CREATE INDEX quota_ledger_period ON quota_ledger (period_id, id);

-- Usage ----------------------------------------------------------------------
CREATE TABLE usage_records (
  id uuid PRIMARY KEY,
  generation_id uuid NOT NULL UNIQUE REFERENCES generations(id),
  user_id uuid NOT NULL, division_id uuid, provider_id uuid NOT NULL, model_id uuid NOT NULL,
  period_id uuid NOT NULL,
  input_tokens int NOT NULL, output_tokens int NOT NULL,
  cached_input_tokens int, reasoning_tokens int,
  quota_tokens bigint NOT NULL, overshoot_tokens bigint NOT NULL DEFAULT 0,
  usage_source text NOT NULL CHECK (usage_source IN ('provider','estimated')),
  est_cost_micros bigint, cost_currency char(3) DEFAULT 'USD',
  outcome text NOT NULL CHECK (outcome IN ('completed','cancelled','failed')),
  error_category text, duration_ms int, time_to_first_token_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_user_time ON usage_records (user_id, created_at DESC);
CREATE INDEX usage_model_time ON usage_records (model_id, created_at DESC);

CREATE TABLE usage_daily (
  day date NOT NULL, user_id uuid NOT NULL, division_id uuid, provider_id uuid NOT NULL, model_id uuid NOT NULL,
  requests int NOT NULL, failed_requests int NOT NULL,
  input_tokens bigint NOT NULL, output_tokens bigint NOT NULL, quota_tokens bigint NOT NULL, est_cost_micros bigint,
  PRIMARY KEY (day, user_id, model_id)
);

-- Platform ---------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL, key text NOT NULL, endpoint text NOT NULL, request_hash char(64) NOT NULL,
  response_status int NOT NULL, response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY, type text NOT NULL, payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead')),
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 5,
  locked_by text, locked_at timestamptz, last_error text, dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX jobs_due ON jobs (run_at) WHERE status = 'queued';

CREATE TABLE audit_logs (                        -- append-only
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid, action text NOT NULL, target_type text, target_id text,
  before jsonb, after jsonb, request_id text, ip inet, user_agent_hash text,
  prev_hash char(64), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_time ON audit_logs (created_at DESC);
CREATE INDEX audit_actor ON audit_logs (actor_user_id, created_at DESC);

CREATE TABLE error_events (                      -- sanitized system errors for admin view
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(), request_id text, component text NOT NULL,
  category text NOT NULL, provider_id uuid, model_id uuid, generation_id uuid,
  message text NOT NULL, context jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX error_events_time ON error_events (occurred_at DESC, category);

CREATE TABLE system_settings (
  key text PRIMARY KEY, value jsonb NOT NULL, version int NOT NULL DEFAULT 1,
  updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
```

### 17.3 Indexing & query notes
- Conversation list: `conversations_user_recent` (keyset pagination on `(sort_ts, id)`).
- Message load: `UNIQUE (conversation_id, seq)`; load parts with `WHERE message_id = ANY($ids) ORDER BY message_id, position` (one query, no N+1); files fetched with one `IN` query.
- `message_count`/`seq` assignment: `UPDATE conversations SET message_count = message_count + 2 … RETURNING` inside the send transaction (serialized per conversation; also guarded by the one-active-generation index).
- Hot rows: `quota_periods` (per-user, low contention), `message_parts` streaming appends (fillfactor 80, HOT updates; autovacuum threshold lowered on this table).
- Large tables to watch: `message_parts`, `quota_ledger`, `usage_records`, `audit_logs`; partition by month (declarative) when > ~50 M rows or retention purges become heavy.
- Append-only enforcement: application DB role has `INSERT, SELECT` only on `quota_ledger`, `audit_logs`; a separate migration role has DDL.
- Migrations: forward-only, expand/contract, reviewed; seed file for example providers/models is **not** auto-applied in production.

---

## 18. Error Handling

### 18.1 Normalized error categories

All errors surface as the envelope in §16.1. `AppErrorCategory` is the single vocabulary shared by API, SSE events, `error_events`, and logs.

| Code | HTTP | Retryable (client) | Meaning / user-facing guidance |
|---|---|---|---|
| `invalid_request` | 400/422 | no | Validation failed; `details.fields` lists problems |
| `unauthenticated` | 401 | no (re-login) | No/expired session, user disabled, or invalid login credentials (generic; no user enumeration; also returned when an account is temporarily locked) |
| `forbidden` | 403 | no | Role lacks permission |
| `password_change_required` | 403 | no | The user must change their password before using the API (A-15, FR-AUTH-2) |
| `not_found` | 404 | no | Also used for other users' resources |
| `conflict` / `generation_in_progress` | 409 | after finish | Another generation is active in this conversation |
| `idempotency_key_reuse` | 422 | no | Same key, different payload |
| `model_unavailable` | 409 | later | Model disabled or not permitted |
| `unsupported_for_model` | 422 | no | e.g., image sent to a non-vision model |
| `provider_unavailable` | 503 | yes | Provider down/overloaded/misconfigured (details hidden) |
| `provider_rate_limited` | 503 | yes (`Retry-After`) | Upstream throttling (distinct from user's own `rate_limited`) |
| `rate_limited` | 429 | yes (`Retry-After`) | Platform rate limit hit |
| `quota_exceeded` | 429 | after reset / admin grant | `details.resetAt`, `remainingTokens` |
| `concurrency_limit` | 429 | after a generation ends | Too many concurrent generations |
| `context_too_large` | 422 | no | Message + attachments exceed limits; suggest removing attachments or starting new conversation |
| `content_filtered` | 200 (terminal event) | no | Provider safety system blocked output |
| `file_too_large` | 413 | no | |
| `unsupported_file_type` | 415 | no | |
| `file_not_ready` | 409 | yes (poll) | Still processing |
| `file_processing_failed` | 422 | no | Corrupt/encrypted/unsafe file |
| `generation_timeout` | terminal event | yes (manual retry) | Provider didn't finish in time |
| `generation_cancelled` | terminal event | — | User/system cancel |
| `service_busy` | 503 | yes | Node at generation capacity |
| `storage_unavailable` | 503 | yes | Disk full/unavailable |
| `internal_error` | 500 | maybe | Always includes `requestId` for support |

### 18.2 Provider error translation
Each adapter implements `translateError` with an exhaustively tested mapping. Reference mapping (adapters refine per provider documentation):

| Upstream condition | → Category | Retryable | Side effects |
|---|---|---|---|
| Network error, DNS, connection reset, TLS | `provider_unavailable` | yes | metric + error_event |
| HTTP 408 / client-side timeout | `generation_timeout` | yes (pre-output) | |
| HTTP 429 | `provider_rate_limited` | yes, honor `Retry-After` | feeds circuit breaker |
| HTTP 500/502/503/504, "overloaded" | `provider_unavailable` | yes | |
| HTTP 400 – context/prompt too long | `context_too_large` | no | log estimation error ratio |
| HTTP 400 – other / schema errors | `internal_error` | no | alert (our adapter bug) |
| HTTP 401/403 (bad/expired key, no access) | shown as `provider_unavailable` | no | **page on-call**; mark provider `degraded` |
| HTTP 404 model not found | `model_unavailable` | no | auto-flag model unhealthy; alert |
| Safety/content block | `content_filtered` | no | counted separately |
| Malformed/truncated stream | `provider_unavailable` | yes (pre-output) | |

Users never receive provider messages, request IDs, keys, or stack traces. Internal details go to redacted logs and `error_events` (sanitized, admin-visible).

### 18.3 Error propagation in streams
Errors after the stream starts cannot change the HTTP status; they are delivered as `generation.failed` events with the same `{code, message, retryable}` payload, and persisted on `generations.error_code/error_detail`. The same state is retrievable via `GET /generations/:id`.

## 19. Retry / Timeout / Cancellation

### 19.1 Timeouts (all configurable per provider/model; defaults)

| Timeout | Default | Behavior on expiry |
|---|---|---|
| API request (non-streaming routes) | 30 s | `503/504`, logged |
| Upload request | 120 s | abort, cleanup temp |
| Provider connect | 10 s | retryable `provider_unavailable` |
| Tokenizer cold init + estimation (first request in a process) | 250 ms (once warm: 20 ms for 200 KB text) | local failure, non-retryable `internal_error` (not sent to client as a provider error) |
| Time to first provider event | 45 s (120 s for reasoning-heavy/doc generation) | retryable (pre-output) |
| Idle gap between provider events | 60 s | `generation_timeout`, partial kept |
| Max generation duration | 300 s (180 s typical text; up to 900 s for job-style models) | `generation_timeout` |
| Detach grace (no SSE subscriber) | 60 s | cancel (A-12) |
| Reservation `expires_at` | max duration + 120 s | reaper |

### 19.2 Retry policy

- **Retryable:** network errors, connect/first-byte timeouts, HTTP 429, 5xx/overloaded, malformed stream **only if no output has been emitted yet**.
- **Non-retryable:** 4xx validation errors, `context_too_large`, content filter, auth errors, any failure **after** the first output event (no mid-stream resume/stitching — it would corrupt answers and double-bill).
- **Backoff:** full-jitter exponential: `delay = random(0, min(8 s, 500 ms × 2^attempt))`; if the provider returns `Retry-After`, `delay = max(delay, retryAfter)` but never beyond the remaining generation deadline.
- **Max attempts:** 3 total (2 retries). `generations.attempt_count` records attempts.
- **Budget:** all attempts share one overall deadline; retries stop if the remaining time is insufficient.
- **Quota:** one reservation per generation reused across attempts; usage only recorded for attempts that actually produced billable output.
- **Circuit breaker (P1):** per provider+model; opens after 5 retryable failures in 60 s, fails fast with `provider_unavailable` for 30 s, then half-open probe. Prevents retry storms and reduces latency during outages.
- **Provider concurrency cap:** semaphore per provider (`maxConcurrency`) to stay within upstream rate limits.
- **User retry** (explicit) is a *new* generation (new reservation), not an automatic retry.

### 19.3 No cross-model fallback
On provider failure the conversation stays on its model. The UI receives `provider_unavailable`/`model_unavailable` and may offer **Retry**. The orchestrator has no code path that selects a different model.

### 19.4 AbortController behavior

```
GenerationHandle.abortController          (owned by runner)
        │ signal
        ├─► adapter.execute(req, { signal })  → provider HTTP/SDK request is aborted
        ├─► retry backoff sleeps               → abort interrupts wait
        └─► ArtifactSink / extraction          → abort stops writes, cleans temp
```
Abort sources and reasons: `user_cancel`, `detached` (grace expired), `timeout`, `shutdown`, `admin_disable_model` *(P1: optionally cancel in-flight on kill-switch)*.
**The inbound HTTP request's abort signal is deliberately *not* wired to the provider call** (D-2). It only removes the SSE subscriber.
After abort, the finalizer always runs: persist partial parts → set terminal state → settle/release (§11.5) → emit terminal event (if any subscriber) → structured log.

### 19.5 Client disconnect (summary)
Subscriber removed → detach timer (60 s) → continue or cancel. Reconnect within grace restores the stream seamlessly (§14.4). Provider responses arriving after a disconnect are processed normally and persisted.

## 20. Admin Requirements

### 20.1 Administrative roles & capabilities (MVP = backend API + minimal UI; UI may be a thin SPA section)

The platform implements a **two-tier administrative model**:
1. **Super Administrator (`super_admin`):** Full, system-wide governance over all platform resources, divisions, models, providers, quotas, audit logs, and user accounts.
2. **Division Administrator (`admin`):** Scoped administrator bound to a specific division (`division_id NOT NULL`), restricted to CRUD user operations strictly for employees within their assigned division.

| Area | Scope & capabilities | Division Admin (`admin`) | Super Admin (`super_admin`) | Pri |
|---|---|---|---|---|
| **Users (own division)** | List/search users within caller's division | ✅ (own division only) | ✅ (all / any division) | P0 |
| | Create/provision user with `role = 'user'` in division | ✅ (own division only) | ✅ (any division) | P0 |
| | View user detail, update `displayName` and `status` (`active`/`disabled`) | ✅ (own division only) | ✅ (all) | P0 |
| | **Reset password** (revokes all sessions, forces change on next login) | ✅ (own division only) | ✅ (all) | P0 |
| **Users (platform-wide)** | Manage users across all divisions or unassigned | ❌ | ✅ | P0 |
| | Assign or change user `role` (`user`, `admin`, `super_admin`) | ❌ | ✅ | P0 |
| | Assign or change user `division_id` | ❌ | ✅ | P0 |
| **Divisions** | Create/rename divisions; assign external references | ❌ | ✅ | P0 |
| **Quotas** | Set global, division, or user policies; grant/claw back quota with reason; view ledger | ❌ | ✅ | P0 |
| **Models** | Create/edit registry rows; enable/disable; edit capabilities, limits, pricing, config | ❌ | ✅ | P0 |
| **Providers** | Create/edit; set `secretRef` (env var name — A-16); enable/disable; set concurrency/timeouts | ❌ | ✅ | P0 |
| **Provider health** | View health checks, latency, error rate, circuit state; execute on-demand test | ❌ | ✅ | P1 |
| **Usage** | Aggregated usage analytics across users, divisions, models, providers | ❌ | ✅ | P0 |
| **Errors** | View sanitized system `error_events` across all providers and components | ❌ | ✅ | P1 |
| **Audit** | Search platform-wide `audit_logs` | ❌ | ✅ | P0 |
| **Settings** | Edit system prompt, file limits, retention windows, `quota.timezone` (versioned) | ❌ | ✅ | P1 |

**Safeguards & privilege boundaries:**
- **Last super admin protection:** The system strictly blocks disabling, demoting, or soft-deleting the last active `super_admin` (`409 conflict`).
- **Division admin isolation:**
  - A user with `role = 'admin'` must have `division_id IS NOT NULL` (enforced by DB check constraint `users_admin_division_check`).
  - Division admins cannot view, create, edit, or reset passwords for users in other divisions or unassigned users; attempting to access a user outside the caller's division returns **404** (not 403, preventing account existence discovery).
  - Division admins cannot escalate their own or others' roles, cannot modify user roles, and cannot reassign user divisions.
  - Division admins cannot access division management, quota policies, model/provider registry, usage reporting, system error explorer, audit logs, or platform settings (`403 forbidden`).
- **Content privacy:** Neither super admins nor division admins can access conversation contents or file contents (A-13).
- **Auditability:** Every administrative mutation produces an `audit_logs` entry in the same transaction with before/after snapshots (secrets redacted); destructive actions require an operational `reason`.

### 20.2 Usage analytics (from `usage_records` / `usage_daily`)
- **Dimensions:** user, division, model, provider, day, month, outcome.
- **Measures:** requests, failed requests (by error category), input/output/quota tokens, estimated cost (from effective-dated pricing), **actual provider-reported usage share** (`usage_source`), quota utilization %, quota exhaustion events, top consumers, overshoot ratio.
- Exports: CSV download (audited) — P1.

## 21. Observability

### 21.1 Request identity
Each inbound request gets `requestId` (UUID). Each generation inherits it and also has `generationId`. IDs propagate through Winston logs, SSE events, `error_events`, and (where the provider supports metadata) as an opaque tag. Provider request IDs are stored on `generations.provider_request_id` for support tickets.

### 21.2 Structured logs (JSON via Winston with daily rotation and stack trace)
The platform uses conventional **Winston structured JSON logging** with daily file rotation (`winston-daily-rotate-file`) and automated retention:
- **Output files:**
  - Combined application log: `/var/log/ai-chat/app-%DATE%.log` (info, warn, error).
  - Dedicated error log: `/var/log/ai-chat/error-%DATE%.log` (error-level only).
  - Console transport active for development and systemd journal inspection (`journalctl -u ai-chat@blue -f`).
- **Rotation & retention:**
  - Daily rotation (`datePattern: 'YYYY-MM-DD'`), max chunk size before rotation (`maxSize: '20m'`), file retention 14–30 days (`maxFiles: '14d'` or `'30d'`), and automatic gzip compression (`zippedArchive: true`).
- **Required fields on lifecycle logs:** `ts, level, requestId, userId, conversationId, messageId, generationId, provider, model, status, startedAt, durationMs, ttftMs, inputTokens, outputTokens, quotaTokens, usageSource, errorCategory, attempt`.
- **Error stack trace serialization:**
  - For all logged errors, Winston formats and includes full error stack traces (`err: { name, message, stack, code, status, details }`) directly in the JSON output.
  - Enables instant, actionable root-cause debugging directly from log files without requiring interactive debuggers or separate telemetry agents.
- **Strict central content redaction:**
  - **No message text, file contents, prompts, or provider bodies** by default (`LOG_CONTENT=false`).
  - No passwords, session tokens, or API keys may appear in log fields or serialized error stack traces.
  - User emails are logged as `userId` only.
  - Redaction list enforced centrally; CI tests scan log fixtures for leak patterns.

### 21.3 Metrics policy (No Prometheus / No `/metrics` endpoint)
In accordance with operational simplification decisions, **Prometheus metric exposition (`/metrics`), metric registries, and metric scrapers are excluded from the platform**.

Operational visibility is fulfilled through:
1. **Conventional Winston daily rotating JSON logs with stack traces.**
2. **PostgreSQL reporting tables (`usage_daily`, `usage_events`, `error_events`):** High-level token counts, request totals, latencies, cost estimates, and error categories are persisted transactionally and queried via super admin APIs (`GET /api/admin/usage`, `GET /api/admin/errors`).
3. **Log-based alerting & log tailing:** SREs and platform engineers monitor application health by inspecting `error-%DATE%.log` and running log analysis on rotating log files.

### 21.4 Tracing & correlation
Request and generation context (`requestId`, `generationId`) is injected into every Winston log entry, SSE frame, and `error_events` record, providing end-to-end trace correlation across HTTP middleware, orchestrator execution, and background worker jobs without the overhead of external OTLP collectors.

### 21.5 Alerts (log-based & health probes)
Alert rules are driven by log monitoring on `error-%DATE%.log`, health probes, and database job reconciliation:
- Generation failure rate > 10 % over 10 min (per provider) or provider circuit trip.
- Provider authentication errors (401/403) > 0.
- Reservations active past expiry or quota ledger reconciliation mismatch > 0.
- Storage disk free < 20 % or attachment cleanup job failing.
- Database pool saturation > 80 %.
- Readiness flapping on `/readyz`.

### 21.6 Health endpoints
- `/healthz` — process alive (liveness probe, no dependencies).
- `/readyz` — DB reachable and migrations current, storage writable with free space (readiness probe). **Provider health is *not* part of readiness** (a provider outage must not take the API out of rotation); it is exposed in admin health APIs and structured logs.
- The `/metrics` endpoint is removed.

## 22. Background Processing

### 22.1 Sync vs async decisions

| Operation | Mode | Reason |
|---|---|---|
| Auth, validation, authorization | Sync | Needed for response |
| Idempotency + reservation + creation txn | Sync (short txn) | Correctness; < 50 ms |
| Provider execution & streaming | **In-process async task** (decoupled from request, not a queued job) | Lowest latency; owner-process model (D-2) |
| Text checkpointing | In-process timer | Cheap |
| Finalization (settle, usage record) | In-process, **must complete** | Correctness; reaper is backstop |
| File signature/size/image checks | Sync | Fail fast |
| Document text extraction, OCR (P2), AV scan | **Async job** (5 s fast-path wait) | CPU-bound/variable duration; sandboxed |
| Generated-file post-processing | Sync within generation (before part completes) | Must precede exposure |
| Temporary file cleanup, orphan reaper | Scheduled job | Housekeeping |
| Reservation/generation reaper | Scheduled job (60 s / 30 s) | Safety net |
| Usage rollups, quota period pre-create, reconciliation, analytics | Scheduled job | Off the hot path |
| Idempotency/session/soft-deleted purge | Scheduled job | Housekeeping |

### 22.2 Job runner (no external queue in MVP)
- `jobs` table with `SELECT … FOR UPDATE SKIP LOCKED` polling (1 s when busy, 5 s idle), `attempts`, exponential retry, `dead` state after `max_attempts`, `dedupe_key` for idempotent scheduling.
- Runs in the same image with `ROLE=worker|all`. Scheduler (cron-like) runs under `pg_try_advisory_lock` so only one instance schedules.
- Handlers are idempotent; each logs duration and failures in structured logs.
- **Heavy work isolation:** extraction handlers fork a child process (timeout, memory limit) so a malicious file cannot stall the event loop.
- **Future queue:** `JobQueue { enqueue(type, payload, opts); registerHandler(type, fn) }` hides the implementation → swap to pg-boss/BullMQ/SQS without touching handlers. Introduce when: > 1 worker node needed, jobs > ~50/s, or cross-service workflows appear.

### 22.3 Schedules

| Job | Cadence | Notes |
|---|---|---|
| `generation.reaper` | 30 s | Stale heartbeat (> 45 s) or pending > 30 s without runner → `failed(interrupted)` |
| `quota.reservation_reaper` | 60 s | Expired reservations → settle/release |
| `files.expire_and_delete` | 10 min | Two-phase (§12.8) |
| `files.orphan_reaper` | 10 min | Unattached uploads > 1 h |
| `usage.rollup` | 5 min (+ nightly rebuild of yesterday) | Reproducible |
| `quota.precreate_periods` | daily + 1st of month | Reporting only |
| `quota.reconcile` | nightly | Counters vs ledger |
| `idempotency.purge`, `sessions.purge` | hourly | |
| `conversations.purge_soft_deleted` | daily | After 30 d |
| `storage.reconcile` | weekly | Orphan blobs / missing blobs |
| `providers.health_check` | 60 s | Lightweight probes (no meaningful tokens) |

## 23. Testing Strategy

### 23.1 Pyramid & tooling
Vitest (unit/integration), Testcontainers for real PostgreSQL (and Redis if used), `FakeProvider` with fault injection, k6 for load, Playwright for E2E with the SPA. **Database behavior is never mocked** for quota/idempotency/transaction tests.

| Level | Scope | Examples | Gate |
|---|---|---|---|
| Unit | Pure logic | Context truncation, token estimation margins, per-provider tokenizer estimation (tiktoken fixtures, Claude tokenizer fixtures), error mapping, filename sanitizer, state-machine transitions, idempotency hashing | PR |
| Integration | Services + real DB | Reserve/settle/release, ledger invariants, migrations, repositories' isolation filters, file pipeline with real storage dir | PR |
| **Provider adapter contract** | Each adapter vs shared suite | See §23.3 | PR (fixtures) + nightly (live, capped) |
| API | Hono `app.request()` | AuthN/Z matrix, validation, error envelope, pagination | PR |
| DB transaction | Rollback/atomicity | Failure mid-"create generation" leaves no partial rows or reservation | PR |
| **Quota concurrency** | Parallel clients | See §23.2 | PR + nightly stress |
| Streaming | SSE | Ordering, replay from `Last-Event-ID`, snapshot fallback, heartbeats, backpressure | PR |
| File upload | Multipart | Size/count limits, spoofed MIME, polyglot, zip bomb, macro docx, encrypted PDF, huge image, traversal names | PR |
| Security | Negative tests | IDOR on every ID route, CSRF, CORS, header presence, secret-/password-leak scan of responses/logs, rate limits, login lockout, password hashing round-trip, session rotation & revocation | PR + pre-release pentest |
| Auth & sessions | Integration + API | Login success/failure (generic error), lockout after N failures, session rotation on login and password change, disabled-user immediate revocation, admin/super admin reset revokes all sessions, division-scoped admin isolation (cross-division 404), last-super-admin protection, `must_change_password` gate | PR |
| Idempotency | Duplicate requests | See §23.4 | PR |
| Load | k6 | 150 concurrent SSE streams on `FakeProvider`; 20 uploads/s; sustained 30 min | Pre-release |
| E2E | Browser | Login → select model → chat → attach → stream → reload → quota display | Pre-release |
| Chaos/recovery | Fault injection | `kill -9` mid-stream; DB failover; disk full; provider hang | Pre-release |

### 23.2 Quota concurrency tests (critical)
1. **Oversubscription:** limit 100,000; fire 50 parallel reservations of 20,000 → **exactly 5 succeed**, 45 get `quota_exceeded`; `reserved_tokens = 100,000`; invariant `used + reserved ≤ limit` holds at every observation (sampled by a watcher).
2. **Settle/release races:** concurrent settle + reaper + cancel on the same generation → exactly one finalization; counters equal ledger sums.
3. **Property-based:** random sequences of reserve/settle/release/adjust/expire across N users; assert `reserved ≥ 0`, `used ≥ 0`, counters = ledger folds, idempotent re-settlement is a no-op.
4. **Overshoot:** actual > reserved settles the true value, flags `overshoot_tokens`, blocks subsequent reservations.
5. **Concurrency limit:** `max_concurrent_generations = 2` with 10 parallel sends → exactly 2 accepted.
6. **Month boundary:** reservation made in month M settles in M; first request in M+1 creates its own period lazily; parallel first-requests create exactly one period row.
7. **Crash recovery:** kill process after reservation but before provider call/after partial output → reaper restores correct balances.
8. **Retry:** provider retries do not create additional reservations or ledger rows beyond one settle.

### 23.3 Provider adapter contract suite
Run for every adapter against recorded HTTP fixtures (and live nightly with a hard spend cap):
- Text-only, multi-turn, system prompt, image part, PDF part, long output (`length` finish).
- Streaming event ordering: `started → part_started → text_delta* → part_done → usage → finished`; exactly one terminal event; usage present or flagged.
- **Abort mid-stream** terminates the upstream request within 1 s, emits no further events.
- Every documented error status/code → expected `AppErrorCategory` + retryable flag + `retryAfterMs`.
- Unsupported part types rejected cleanly; no secrets in thrown errors; deterministic `toProviderRequest` snapshot tests.

### 23.4 Idempotency tests
Same key twice (sequential + 20 parallel) → one message pair, one generation, one reservation; replay header present; different payload with same key → 422; crash between commit and provider start → resumer fails/releases safely; retried POST after timeout returns the same IDs; key expiry after 24 h permits new request.

### 23.5 Streaming & provider-failure scenarios (FakeProvider knobs)
Latency, mid-stream disconnect, 429 with `Retry-After`, 5xx burst (circuit breaker), hang (timeout), malformed event, missing usage, content filter, huge delta bursts, abort ignoring (adapter must still be cut off by the runner). Assertions: terminal state always reached; history intact; quota settled per §11.5; no duplicate parts; SSE reconnect yields identical final text.

### 23.6 Environments
Local (docker compose: Postgres, optional Redis, FakeProvider) → CI → staging with real provider keys limited by quota → production. Test data never uses real documents.

## 24. Deployment Architecture

### 24.1 Topology (MVP)

```
 Users ──HTTPS──► Reverse proxy / LB (TLS, SSE-friendly, request limits)
                         │
              ┌──────────┴───────────┐
              ▼                      ▼
        API container (active)   API container (standby / rolling deploy)
        ROLE=all                   ROLE=api
              │  shared volume (RWX) or single-node volume for /var/lib/aichat/files
              ├──────────► PostgreSQL (managed or HA pair, PITR, TLS)
              ├──────────► Redis (optional; rate limits)
              └──────────► Provider APIs (egress allow-list)
        Worker (ROLE=worker, 1 instance) – may be the same container as the active API in the smallest setup
```
**A-4 caveat:** with generations owned in-process, run **one** streaming-capable node (sticky routing if two). Scale-out path: shared/S3 storage + Redis stream relay (§14).

### 24.2 Configuration (environment / secret files; validated at boot with Zod — fail fast)
`DATABASE_URL`, `DB_POOL_MAX`, `REDIS_URL?`, `STORAGE_LOCAL_ROOT`, `STORAGE_WRITE_PROVIDER`, `QUOTA_TIMEZONE=Asia/Jakarta`, `SESSION_SECRET?` (CSRF token signing), `ALLOWED_ORIGINS?`, `ROLE`, `MAX_ACTIVE_GENERATIONS`, `LOG_LEVEL`, `LOG_CONTENT=false`, `RETAIN_EXTRACTIONS`, `PASSWORD_MIN_LENGTH=12`, `LOGIN_MAX_FAILURES=8`, `LOGIN_LOCKOUT_MINUTES=15`, and **provider API keys as env vars** (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) referenced by `providers.secret_ref` (A-16).

Provider-key rotation: update the env/secret file and restart the process; with the standby node this is a rolling restart with no downtime (§24.6). No secret manager is required in MVP (A-16).

### 24.3 Reverse proxy requirements
TLS 1.2+; `proxy_buffering off` for `/api/generations/*/stream`; read timeout ≥ 330 s; idle keepalive tuned; `client_max_body_size` ≈ 35 MB for attachments; forward `X-Request-Id`, real client IP (trusted proxy list); HTTP/2 enabled; request body timeout.

### 24.4 Database
Managed PostgreSQL 15+ preferred; PITR/WAL archiving (RPO ≤ 5 min); daily base backup; connection pooling via app pool (`max` 20/node) — add PgBouncer (transaction mode; avoid session-level features, use `SET LOCAL`) when nodes multiply; migrations run as a **pre-deploy job** (expand/contract, one migrator, advisory-locked), never concurrently on every container boot.

### 24.5 Storage & backups
The file volume holds **temporary** data and is **not backed up** by design (D-7). After a restore, blobs may be missing → reconciliation marks them `missing` and the UI shows "unavailable"; conversations/text/usage remain intact. Volume: encrypted, monitored for free space, ≥ 2× expected peak (users × 30 d × avg MB).

### 24.6 Graceful shutdown (SIGTERM)
1. Readiness → fail (stop receiving new traffic); stop accepting new generations (`503 service_busy`, `Retry-After`).
2. **Drain** active generations up to `SHUTDOWN_DRAIN_SECONDS` (default 120). SSE clients stay connected.
3. At expiry: abort remaining with reason `shutdown`; finalizer persists partial text, marks `failed(interrupted)`, settles/releases; terminal SSE event emitted.
4. Flush logs, close DB pool, exit. Orchestrator's stop-grace must be > drain (e.g., 150 s).
Rolling deploys therefore normally interrupt nothing; worst case the user sees "Interrupted — Retry".

### 24.7 Rollback
Image rollback by tag; migrations are backward-compatible (expand/contract) so N-1 code runs on N schema; destructive migrations only after a full release cycle; feature flags (env/`system_settings`) for risky features; config changes audited.

### 24.8 Environments & CI/CD
dev/staging/prod; CI: lint (incl. provider-import rule), typecheck, unit/integration/contract/quota tests, dependency audit, container scan, migration dry-run on a prod-like snapshot; deploy: staging auto, production manual approval.

## 25. Production Readiness Checklist

**Security**
- [ ] Password hashing (argon2id) parameters verified; lockout + generic login errors tested; session cookie flags and rotation verified
- [ ] RBAC matrix tests green; IDOR tests for every ID-bearing route
- [ ] CSRF/Origin checks, security headers, CORS policy verified in staging
- [ ] Pen test / security review completed; findings triaged
- [ ] Dependency & container vulnerability scan: no criticals
- [ ] Secrets: none in repo/images/logs; `.env`/secret files `0600` and excluded from VCS and DB backups; rotation procedure rehearsed; provider spend caps set
- [ ] Egress allow-list active; DB not publicly reachable; TLS everywhere
- [ ] Log redaction verified (keys, passwords, cookies, content off)

**Authentication & authorization**
- [ ] Disabled-user immediate lockout tested · session revocation on disable and on password reset tested · `must_change_password` gate tested · super-admin vs division-admin RBAC routes enforced · division admin cross-division isolation (404 on access, forbidden on role/division modification) · last-super-admin protection
- [ ] Bootstrap-admin procedure (`role = super_admin`) documented and rehearsed on a fresh database

**Database & data**
- [ ] Migrations tested forward on production-size snapshot; rollback/N-1 compatibility verified; `users_admin_division_check` constraint verified
- [ ] Append-only grants on `quota_ledger`/`audit_logs` confirmed
- [ ] Indexes verified with `EXPLAIN` on top queries; autovacuum settings applied
- [ ] **Backups running; PITR tested; full restore drill passed (RTO ≤ 1 h, RPO ≤ 5 min)**
- [ ] Retention jobs verified (messages, files, ledger, audit, logs)

**Files & storage**
- [ ] Upload hardening tests (zip bomb, macro, spoofed MIME, encrypted PDF) pass
- [ ] Cleanup job running; orphan/missing-blob reconciliation verified; disk alerts set
- [ ] Download authorization & headers verified (no admin/super admin exemption, A-13); extraction sandbox limits enforced

**Quota accuracy**
- [ ] Concurrency/property tests green in CI · nightly reconciliation = 0 mismatches for 14 days in staging
- [ ] Reaper recovers crashed generations (kill -9 test) · overshoot ratio within budget
- [ ] Super admin quota adjustments produce ledger + audit rows

**Provider reliability**
- [ ] Contract tests green for each adapter; live smoke test per provider
- [ ] Timeouts/retries/backoff configured; circuit breaker verified with fault injection
- [ ] Provider keys valid; alerts on 401/403; per-provider concurrency caps set
- [ ] Error translation verified: no provider detail leaks to clients

**Rate limiting / abuse**
- [ ] Per-IP, per-user, upload, and message limits active; headers returned

**Monitoring, logging, error handling**
- [ ] Winston daily rotating JSON logs configured (`app-%DATE%.log`, `error-%DATE%.log`) with automatic compression and retention; error stack traces captured in structured JSON format
- [ ] Alerts wired to on-call with runbooks (error log frequency, provider outage, disk space, reconciliation mismatch, reaper)
- [ ] Request ID traceable from API response → Winston logs → provider request ID
- [ ] Error envelope consistent; full stack traces captured in error logs while omitted from HTTP responses (outside `NODE_ENV=development`)

**Deployment & operations**
- [ ] Health/readiness endpoints verified (provider outage does not fail readiness)
- [ ] Graceful shutdown drains and finalizes (tested under load)
- [ ] Rollback rehearsed; feature flags documented; config validated at boot
- [ ] Reverse proxy SSE settings validated end-to-end (no buffering, long timeouts)
- [ ] Load test: 150 concurrent streams, 30 min, SLOs met; soak test 24 h

**Disaster recovery**
- [ ] Runbooks: DB restore, secret rotation, provider outage, disk full, quota reconciliation mismatch
- [ ] DR drill performed; ownership and on-call rota defined; communication plan for users

## 26. MVP vs Future Scope

### 26.1 Must Have for MVP (P0)
Authentication (email/password + PostgreSQL sessions, lockout, super admin & division-scoped admin provisioning & password reset) · user management (roles: user, admin, super_admin; divisions, enable/disable, last-super-admin protection) · model registry + selection · **one model per conversation** (DB-enforced) · multi-provider abstraction (≥ 2 adapters live, third proves the abstraction) · text chat · SSE streaming with cancel/reconnect · conversation persistence · token quota (reserve/settle/release, ledger, monthly periods) · usage tracking & super admin usage views · image upload · document upload (PDF, DOCX, XLSX, CSV, TXT, MD) · multimodal message-part model · multimodal **response persistence** (text, images, and binary generated files) · **toggleable built-in provider tools** (web search, web fetch, provider cloud code execution, built-in skills) · **image and document generation** (ArtifactSink download and persistence) · temporary local storage with TTL cleanup · idempotent send · retry of failed generations · basic security (two-tier administrative RBAC, rate limiting, validation, headers, audit) · basic observability (structured Winston JSON logs with daily rotation, stack traces, health) · production runbook basics.

### 26.2 Should have (P1, cut first)
Model visibility per division · circuit breaker · provider health page · error explorer · CSV exports · RLS hardening · AV scanning · editable settings UI · provider-specific token caps.

### 26.3 Future (P2) and the extension point that keeps MVP simple

| Future feature | MVP extension point (already present, nothing built) |
|---|---|
| S3 migration | `StorageProvider` interface, per-row `storage_provider`, opaque keys |
| Custom MCP servers & external agent frameworks | `tool_call`/`tool_result` part types, PAL provider hooks |
| OCR (offline/scanned documents) | Extractor interface + `file_extractions` |
| Rolling summaries / long-term memory | Context builder strategy hook, `conversation_summaries` (not created) |
| Voice | New modalities + part types; adapters |
| Shared conversations / team collaboration | `conversations.user_id` ownership + new `conversation_members` (not created); RLS policy extension |
| Provider/model token caps | `quota_periods.scope_type/scope_id` |
| Multi-tenant / workspaces | Add `organization_id`, RLS |
| SSO / OIDC (Entra ID, Google, Okta) | `users.idp_subject` (nullable) + an auth-provider interface behind the session layer (A-15) |
| MFA / TOTP | Additional login step in the session layer; no schema change required beyond a user-secret column |
| Enterprise integrations (SCIM, SIEM, ticketing) | Audit log stream, IdP-claim provisioning |
| Redis stream relay / multi-node streaming | Event protocol with sequence IDs, `runner_id`, `JobQueue` abstraction |

**Guardrail:** no future feature may add tables, queues, or services to the MVP; each is enabled by *adding* modules behind the interfaces above.

## 27. Risks and Mitigations

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Token estimation inaccurate (esp. images/PDFs) → over-reservation (user frustration) or overshoot | High | Medium | Tokenizer per provider (`tiktoken` for OpenAI, `claude-tokenizer` port for Anthropic — §11.2); local tokenizer/BPE + margin for other providers; calibrated margins; output clamping; actual-usage settlement; `estimation_error_ratio` metric; revisit margins monthly |
| R2 | Provider outage/rate limits | High | High | Timeouts, bounded retries, circuit breaker, concurrency caps, clear UX, status page; no silent fallback (by requirement) |
| R3 | Provider usage not reported on abort/failure | Medium | Medium | Estimated settlement policy; document as known inaccuracy; measure delta |
| R4 | Single-node in-process generation ownership limits scale/HA | Medium | Medium | A-4 explicit; fast recovery via reaper; Redis relay path designed; load tested |
| R5 | Local disk loss/exhaustion | Medium | Medium | TTL, disk alerts, quotas on upload; blobs are non-critical by design; `missing` state |
| R6 | Malicious/oversized documents (DoS, parser exploits) | Medium | High | Hardening pipeline, sandboxed extraction, limits, AV option, dependency scanning |
| R7 | Prompt injection / data exfiltration through output rendering | Medium | Medium | No tools in MVP; untrusted delimiters; frontend sanitization contract; later tool review gate |
| R8 | Sensitive company data sent to third-party providers | Medium | High | Enterprise API terms, user notice, per-model/division allow-lists, admin kill-switch, content not logged |
| R9 | Quota bug causes wrong charges | Low | High | DB-level constraints, ledger, nightly reconciliation, concurrency tests, alerts |
| R10 | Provider API changes break adapters | High | Medium | Contract tests (nightly live), pinned SDK versions, adapter isolation, capability flags |
| R11 | Long-running streams exhaust connections/memory | Medium | Medium | Per-node cap, backpressure, no DB connection per stream, load tests |
| R12 | Misconfigured proxy buffers SSE | Medium | Medium | Documented settings, readiness e2e check in staging |
| R13 | Cost spikes from big contexts | Medium | Medium | Max input/output limits, quota weights, provider spend caps, usage alerts |
| R14 | Admin abuse/insider risk | Low | High | Two-tier administrative RBAC, division admin isolation, no content access (A-13), immutable audit, last-super-admin protection |
| R15 | Scope creep toward agents/RAG | Medium | Medium | Explicit non-goals, guardrail in §26.3 |
| R16 | Provider API key leak (`.env`/secret file, logs, repo, or a compromised host) | Medium | High | Keys only in env/secret files (`0600`, not in VCS/images/DB backups), Winston redaction + CI secret scanning, egress allow-list, provider-console spend caps, documented rotate-and-restart runbook, separate keys per environment |
| R17 | Password attacks (credential stuffing, spraying) and account takeover; no MFA | Medium | High | argon2id hashing, per-account lockout + per-IP login limit, generic errors (no enumeration), full audit of login failures, admin reset revokes sessions; MFA out of MVP (Q-14, closed v1.2) |
| R18 | Provider-key rotation requires a process restart (A-16) | Low | Medium | Rolling restart with the standby node (§24.6) so rotation causes no downtime; spend caps limit exposure during the window |
| R19 | Tokenizer initialization cost: `tiktoken` (WASM) loads tens of MBs of encodings and takes tens of ms on cold start; Claude tokenizer port loads its BPE table; risk of memory/RSS spikes and first-request latency on a node | Medium | Low | **Lazy `init()` per adapter** (memoized `Promise`, not imported at boot); a single encoding instance is cached per process (keyed by encoding name); WASM is offloaded to a worker thread if observed blocking the event loop on large (~200 KB) contexts; measured as part of Phase 5 load testing |
| R20 | Claude tokenizer accuracy is approximate (no official encoding published by Anthropic) → input misestimation may increase overshoot or over-reservation | Medium | Medium | `1.10` margin buffer; verification against **actual provider usage** (recorded in structured logs) per model, with per-model margin overrides via `models.config` if deviation is consistent; settlement always uses actual usage so the risk is limited to temporary quota locks |

## 28. Open Questions

(All questions below are **closed**; the recorded resolution is in force. No open questions remain for the MVP.)

| # | Question | Default assumption | Owner |
|---|---|---|---|
| Q-1 | ~~Which IdP (Entra ID, Google Workspace, Okta) and how are divisions represented in claims?~~ **Closed (v1.1)** — no IdP in MVP; email + password accounts (A-1, A-15). OIDC reserved via `users.idp_subject`. | Closed | IT / Security |
| Q-2 | ~~Expected users, peak concurrency, and data volumes?~~ **Closed (v1.2)** — A-2 numbers (≤ 1,000 users, ≤ 150 concurrent generations, ≤ 30 req/s); global default 500,000 quota tokens/user/month. | Closed | Product |
| Q-3 | ~~Approved provider contracts/tiers: zero-retention / no-training terms; which divisions may use which providers?~~ **Closed (v1.2)** — all active models are visible to all users; use enterprise/API terms that exclude training on data and document them per provider; compliance review before launch. | Closed | Legal / Security |
| Q-4 | ~~Should extracted document text persist after the file expires?~~ **Closed (v1.2)** — yes; extracted text is retained with the conversation after the binary expires (`RETAIN_EXTRACTIONS=true`, A-14). | Closed | Security / Product |
| Q-5 | ~~Quota semantics: raw tokens vs weighted by model price? Rollover? Warning thresholds (e.g., 80 %)?~~ **Closed (v1.2)** — weighted via `quota_weight` (default 1); no rollover; default limit 500,000 tokens/user/month; warning thresholds/notifications are P2. | Closed | Product / Finance |
| Q-6 | ~~Required message/conversation retention and legal hold needs?~~ **Closed (v1.2)** — the A-7 retention defaults apply; no legal hold in MVP. | Closed | Legal |
| Q-7 | ~~Break-glass local admin if IdP is down?~~ **Closed (v1.1)** — no IdP; the first super admin is created by the `bootstrap-admin` CLI/migration with `role = super_admin` (FR-AUTH-8). | Closed | Security |
| Q-8 | ~~Secret manager available (Vault/cloud)? If not, accept envelope-encrypted provider keys in DB?~~ **Closed (v1.1)** — provider keys come from the process environment/`.env` (A-16); no secret manager and no DB storage; rotation = update env + restart. | Closed | Platform |
| Q-9 | ~~Quota period timezone?~~ **Closed (v1.1)** — configurable, default **UTC+7 (`Asia/Jakarta`)**. | Closed | Product |
| Q-10 | ~~Do admins ever need content access (investigations)? Approval process?~~ **Closed (v1.2)** — no; neither super admins nor division admins ever receive content access, including for investigations (A-13). | Closed | Security |
| Q-11 | ~~Initial model list and per-model prices for cost estimates?~~ **Closed (v1.2)** — first adapters OpenAI + Anthropic, Gemini third (Phase 4); the model list/prices are entered by a super admin at launch. | Closed | Product |
| Q-12 | ~~Is single-region, single-node acceptable for the availability target (99.5 %)?~~ **Closed (v1.2)** — yes; one active node plus a standby for rolling deploys (A-4). | Closed | Platform |
| Q-13 | ~~Language/localization of server-side error messages?~~ **Closed (v1.2)** — English human-readable messages plus stable machine-readable error codes. | Closed | Product |
| Q-14 | ~~Is MFA (TOTP) required for admins, or any user, by policy?~~ **Closed (v1.2)** — not in MVP (email + password only); admin/super_admin MFA is the first candidate if policy later requires it. | Closed | Security / Product |

## 29. Recommended Implementation Phases

| Phase | Duration (est., 3–4 engineers) | Deliverables | Exit criteria |
|---|---|---|---|
| **0 — Foundations** | 1–1.5 wks | Repo, CI, config validation, DB migrations baseline (including `users_admin_division_check`), Hono skeleton, request IDs, error envelope, Winston JSON logging, **email/password auth (argon2id, lockout, PostgreSQL sessions), bootstrap-admin CLI (super_admin), two-tier user administration (super admin platform-wide, division-scoped admin with cross-division 404 isolation), password reset, last-super-admin protection**, RBAC, audit writer, FakeProvider | Auth + RBAC tests green; deploy to staging |
| **1 — Registry & conversations** | 1.5 wks | Providers/models registry + super admin APIs, conversations/messages/parts schema, model-lock trigger, list/load APIs, context builder (text), system settings | Create conversation with model; history loads; model immutability enforced |
| **2 — Generation core** | 2 wks | Orchestrator/runner, adapter interface, **2 adapters** (OpenAI + Anthropic), SSE stream, checkpointing, finalizer, cancel, reaper, idempotent send, retry/timeouts, error translation, contract suite | Streaming works E2E; kill -9 recovery; contract tests green |
| **3 — Quota & usage** | 2 wks | Policies, periods, reservation/settlement/release, ledger, reaper, estimation + per-provider tokenizer (`tiktoken` / `claude-tokenizer` port) + margins, usage records/rollups, `/me/quota`, super admin quota APIs, reconciliation | Concurrency/property tests green; 14-day staging reconciliation clean (starts here, finishes in Phase 5) |
| **4 — Files & multimodal** | 2 wks | StorageProvider + Local impl, upload pipeline + hardening, extraction jobs, multimodal context/adapters, download endpoint, cleanup jobs, generated-artifact path (ArtifactSink tested with FakeProvider), **third adapter (Gemini)** | Upload/attach/answer flows work for MVP types; hardening tests green; third adapter needed zero core changes |
| **5 — Admin, observability, hardening** | 1.5–2 wks | Super admin usage/health/errors/audit APIs, division admin & super admin permission verification, Winston daily rotation & stack trace logging, log-based alerting, rate limiting, security headers/CORS, pen-test fixes, load/soak tests, runbooks, backup/restore drill | Production readiness checklist (§25) fully checked |
| **6 — Pilot & launch** | 2 wks | Pilot with one division, calibrate estimation margins & tokenizer per provider, tune limits, fix issues, go-live | SLOs met 2 weeks; no P1 defects |
| **Post-MVP** | — | P1 items, S3 migration, multi-node streaming, then P2 features (§26.3) | — |

**Total to production-ready MVP: ~11–13 weeks** (estimate; depends on team size and legal/security review lead times; no external IdP integration is required — v1.1).

---

*End of document.*
