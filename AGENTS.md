# AGENTS.md — Internal Office AI Chat Platform (Backend)

> Engineering guide for humans and coding agents working in this repository.
> **Source of truth: [`docs/PRD.md`](docs/PRD.md) (Draft v1.3).** Where this file and the PRD
> disagree, the PRD wins — then fix this file.
> **API surface:** [`docs/API_CONTRACTS.md`](docs/API_CONTRACTS.md).
> **Build & deploy:** [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) (phases → VPS, no Docker).

Current repo state: **docs only.** No code yet. Implementation follows PRD §29 (Phase 0 →
Foundations first). Anything described below as a command or path is the **target convention**
to adopt as the code lands.

---

## 1. What this system is

A multi-provider AI chat backend. One Hono API holds provider credentials, enforces per-user
token quotas, validates and stores uploads, persists conversations (including non-text parts),
and records usage. Clients talk REST + SSE; the browser never contacts a provider directly.

Three concerns are kept strictly apart (PRD §8.2):

| Concern | Owner modules | Must not know about |
|---|---|---|
| Conversation persistence | `conversations/`, `messages/` | provider formats, storage paths |
| Provider execution | `providers/*`, `orchestrator/` | DB tables, storage paths, HTTP |
| Binary artifact storage | `storage/`, `attachments/` | conversations, providers |

Glue lives only in the **Orchestrator**, **Context Builder**, and **ArtifactSink**.

## 2. Target stack (PRD A-3, A-8)

- **Runtime:** Bun.js LTS. One image, `ROLE = api | worker | all`.
- **HTTP:** Hono (`streamSSE` for `/api/generations/*/stream`). API is **unversioned** (`/api` prefix, no version segment).
- **Language:** TypeScript, strict.
- **Database:** PostgreSQL 15+ (single source of truth **and** job queue).
- **Query layer:** Drizzle ORM (recommended) + Zod at every boundary (routes, env, adapter config).
- **Cache / rate limit:** Redis **optional** — never required for correctness or sign-in.
- **Tests:** Vitest; Testcontainers for a real PostgreSQL; `FakeProvider` with fault injection.

## 3. Architecture

**Style: feature-first modular monolith with hexagonal boundaries.** In one line — a modular
monolith, *layered inside each feature*, *hexagonal at the three external seams*. This is the
concrete implementation of PRD §8.2's three separated concerns and decisions D-1–D-3. It is
deliberately **not** microservices (D-3, A-2), **not** horizontal layers
(`controllers/ services/ models/`), and **not** full Clean Architecture (no per-layer projects,
no mapper between every layer, no generic `IRepository<T>`).

### 3.1 Why this shape

| Project trait | Architectural consequence |
|---|---|
| Three concerns must not share formats (PRD §8.2) | Ports + adapters at exactly those seams |
| Quota, idempotency and `seq` share one short transaction (T1) | One explicit **Unit of Work**; the use case owns the transaction — not the repository |
| Streaming holds in-process state (D-2, A-4) | All long-lived state isolated in the **Orchestrator**, swappable for a Redis relay |
| Provider SDKs stay in `src/providers/` (NFR-MAINT-1) | Dependency rule enforced by lint, not convention |
| Single PostgreSQL, optional Redis, one deployable (D-3, A-2) | Modular **monolith**; Postgres-backed jobs act as the outbox |
| Small team — fewer moving parts is the reliability win | Pragmatic: no DI framework, no repository abstraction over Drizzle, no entity-mirrors-table |

### 3.2 The dependency rule

```text
http ──► application ──► domain
              │
              └──► ports ◄── infrastructure
domain ──► (nothing)
```

Allowed: `http → application → domain`; `application → ports`; `infrastructure → ports + domain`.
The composition root (§3.7 `app.ts`/`server.ts`) wires infrastructure implementations into ports.

Forbidden (checked in CI — this is also where the provider-import rule lives):

- `domain/` importing Drizzle, Hono, `pg`, `node:*`, or anything outside its own module.
- `providers/*` importing `db/`; `storage/` importing `conversations/`; `attachments/` importing `providers/`.
- Any module reaching into another module's `infrastructure/` or `domain/` internals.
- Routes (`http/`) containing business logic or touching repositories directly.
- A repository opening its own transaction.

Enforce with `dependency-cruiser` (or ESLint `import/no-restricted-paths`); the ruleset is part of
the lint gate alongside the provider-import rule.

### 3.3 Modules, and the layers inside each

**Feature modules:** `auth/`, `conversations/`, `generations/`, `providers/`, `quota/`,
`attachments/`, `storage/`, `admin/`, `jobs/`, `reporting/`, `audit/`.
**Platform (cross-cutting):** `config/`, `db/`, `http/`, `observability/`, `clock/`, plus the
root-level `errors.ts` (error vocabulary / `AppError`), `crypto.ts` (session-token & hash helpers) and
`csrf.ts` (stateless CSRF tokens) — importable by `http/`, `application/` and `infrastructure/`,
never by `domain/`.
**Glue (the only cross-module orchestrators — PRD §8.2):** `orchestrator/`, `context-builder/`,
`artifactsink/`.

Every feature module uses the same internal layout:

```
<module>/
  domain/          # pure: types, invariants, state machines. Imports nothing outside domain.
  application/     # use cases / services. Depends on domain + its own ports.
  ports/           # interfaces the module needs from, or exposes to, the outside.
  infrastructure/  # Drizzle repositories, provider SDKs, filesystem. Implementations only.
  http/            # Hono routes + Zod schemas. Thin: parse → call use case → shape response.
```

- Real logic lives in `domain` (quota reservation invariant, generation state machine, part rules,
  model-lock) — not in services that only wrap a transaction.
- Drizzle queries live in `infrastructure`; the domain never sees a table.
- A module's public surface is its `application` interface (and the ports it exposes); everything
  else is private.

### 3.4 Ports & adapters — the seams where "clean" earns its keep

| Port | Defined by (consumer) | Implemented by | Rule it protects |
|---|---|---|---|
| `ProviderPort` (PAL: `NormalizedChatRequest` → `GenerationEvent`) | `generations/`, `orchestrator/` | `providers/adapters/{openai,anthropic,gemini}` | PRD §9 — no provider format above the adapter |
| `StorageProviderPort` (`storage_key`, put/get/delete stream) | `storage/`, `attachments/` | `storage/local` (→ S3 later) | PRD §12 — no filesystem path above storage |
| `JobQueuePort` (enqueue/claim/complete, `dedupe_key`) | `jobs/` | PostgreSQL `FOR UPDATE SKIP LOCKED` impl | D-3 scale path to pg-boss/SQS |
| `ClockPort` | platform consumers | system clock | deterministic period/expiry tests |
| `IdGeneratorPort` | platform consumers | UUIDv7 generator | time-ordered IDs; testable |

The port is owned by the consumer and implemented in `infrastructure`; the core never imports the
adapter. The "clean" ceremony is applied **only** here, not between every layer.

### 3.5 Cross-module communication

- Call **through the other module's `application` interface** (`quota.reserve()`,
  `conversations.allocateSeq()`), never its tables or `infrastructure/`.
- Cross-cutting orchestration lives **only** in `orchestrator/`, `context-builder/`, `artifactsink/`
  (PRD §8.2). No other module composes multiple concerns.
- Side effects use an **outbox**: write the `jobs` row in the same transaction as the state change
  (usage rollup, file expiry, notifications). Never perform network I/O inside a transaction.

### 3.6 Transactions & reads

- **Unit of Work.** `db/withTransaction(fn)` is the only way to open a transaction; the use case
  decides the boundary (T1 create, T2 settle). Repositories accept the transaction handle.
- **CQRS-lite.** Writes go through transactional use cases and `domain`. Reporting/admin reads
  (`usage_daily`, `usage_events`, error explorer, audit search) go through the read-only
  `reporting/` module, which queries Drizzle directly — no entities, no domain, no writes. No full
  CQRS or event sourcing.

### 3.7 Planned repository layout

```
src/
  # platform — cross-cutting; imports no feature module
  config/                # env schema (Zod) + constants
  db/                    # pool, drizzle client, schema, withTransaction (Unit of Work)
  http/                  # middleware: request-id, cors, auth, csrf, rate limit, error envelope
  observability/         # pino, metrics, tracing
  clock/                 # Clock + IdGenerator ports and implementations
  errors.ts              # error vocabulary + AppError (shared by application & http)
  crypto.ts              # session-token generation/hashing, UA hashing
  csrf.ts                # stateless signed CSRF tokens
  request-context.ts     # RequestMeta (audit provenance)

  # feature modules — each layered internally (§3.3)
  auth/                  # password hashing, sessions, RBAC, auth HTTP routes
  audit/                 # audit_logs writer (append-only; audit actions)
  conversations/         # conversations, messages, message_parts
  generations/           # generation record, runner, checkpointing, finalizer
  providers/             # PAL interfaces + adapters/<name>/  (ONLY place with provider SDKs)
  quota/                 # policies, accounts, reserve/settle/release, ledger
  attachments/           # upload pipeline, extraction, FileService
  storage/               # StorageProvider + local implementation
  admin/                 # admin routes/services
  jobs/                  # job runner + handlers + scheduler
  reporting/             # read-only query module (CQRS-lite reads)

  # glue — the only cross-module orchestrators (PRD §8.2)
  orchestrator/          # runs a generation end-to-end
  context-builder/       # conversation rows → NormalizedChatRequest
  artifactsink/          # provider-emitted bytes → StorageProvider → attachments row → part

  # composition root
  services.ts            # assembles infrastructure implementations into ports
  app.ts                 # Hono app assembly; wires middleware and the /api tree
  server.ts              # boot, env validation, graceful shutdown

docs/                    # PRD.md, API_CONTRACTS.md, IMPLEMENTATION_PLAN.md
migrations/              # forward-only SQL migrations
```

> Layer subfolders (`domain/ application/ ports/ infrastructure/ http/`) are introduced per module
> as it gains code; a new module starts as a single `application/` folder and splits when it earns
> the structure.

## 4. Commands (target)

```
bun install
bun run dev            # api + worker, watch mode
bun run typecheck      # tsc --noEmit
bun run lint           # eslint (includes the provider-import rule, §5)
bun run test           # vitest
bun run test:integration
bun run db:migrate     # forward-only, advisory-locked; run as a pre-deploy job
bun run db:seed:example# documented example providers/models — NEVER auto-applied in prod
bun run cli bootstrap-admin --email you@corp.example
docker compose up -d pg redis   # local dev deps
```

## 5. Non-negotiable conventions

- **No provider SDK import outside `src/providers/`.** Enforced by a lint rule (PRD NFR-MAINT-1).
- **Dependency rule (§3.2):** imports point inward (`http → application → domain`); `domain/` imports
  nothing external; `infrastructure/` is the only place Drizzle, provider SDKs and the filesystem
  appear. Enforced by `dependency-cruiser` in the lint gate. Repositories never open transactions.
- **Wire envelope:** every `/api` JSON response uses the envelope in `docs/API_CONTRACTS.md` §1 —
  success `{status,message,data}`, error `{status,code,message,retryable,details,trace?}`. `trace` is
  present **only when `NODE_ENV=development`** (sanitized) and never in staging/production. Routes must
  use the shared `src/http/envelope` helpers; hand-rolled response shapes are forbidden.
- **Unversioned API:** routes mount under `/api` with **no version segment**; additive fields/events are
  always allowed and clients must ignore unknowns. Breaking changes require an atomic SPA+API deploy.
- **No secret in code, DB, or logs.** Provider keys come from the environment/`.env` (PRD A-16);
  `ai_providers.secret_ref` stores the **env var name**, never the key. `LOG_CONTENT=false`.
- **Repositories always take an `AuthContext`** and filter by `user_id`. Accessing another
  user's row returns **404**, never 403. Admins/auditors are **not** exempt for content (A-13).
- **Never `SELECT *`** in application code; select explicit columns.
- **No pagination by `OFFSET`** — keyset/cursor only.
- **Streams hold no DB connection.** DB is touched only by the checkpointer and finalizer.
- **Never log** message text, prompts, file bytes, provider bodies, emails, keys, or password material.
- **Every admin mutation and security event** writes an `audit_logs` row in the same transaction.
- **Money is integer micros** (`bigint`); **all timestamps are `timestamptz` UTC**; DB stores UTC only.
- **IDs are UUIDv7**, generated in the application (time-ordered → good index locality).
- **Session cookie & CSRF (PRD §15.1).** Auth is an opaque `__Host-session` cookie (`HttpOnly; Secure;
  SameSite=Lax; Path=/`, never `Domain`), stored server-side keyed by `sha256(value)`. The SPA/API are
  same-site different-origin, so CORS uses an exact `ALLOWED_ORIGINS` allow-list (never `*`) with
  `credentials: true` and `Vary: Origin`. Every non-GET `/api` request needs a valid `X-CSRF-Token`
  (stateless HMAC over `nonce:issuedAt`, 12 h) **and** a passing `Origin` check; `POST /api/auth/login`
  is origin-only because it issues the token. Routes never touch cookies or the CSRF secret directly —
  use the shared middleware.

---

## 6. Recommended PostgreSQL schema

This is the **authoritative target schema**. Migrations must converge to it. It maps the PRD
§17 data model to the table names used by this project.

### 6.0 Name mapping (this file ↔ PRD)

| This file | PRD §17 name | Notes |
|---|---|---|
| `attachments` | `files` | Same table; "attachments" is the project name. |
| `usage_events` | `usage_records` | Same; one row per settled generation. |
| `quota_accounts` | `quota_periods` | Counters per user/period (with future `scope_type`). |
| `generation_jobs` | `generations` | Same; the generation record **is** the job record. |
| `ai_providers` / `ai_models` | `providers` / `models` | Registry tables. |
| `ai_model_prices` | `model_pricing` | Effective-dated prices for cost estimates. |

### 6.1 Cross-cutting conventions

- **Primary keys:** `uuid` (UUIDv7 from the app). Append-only logs use `bigint GENERATED ALWAYS AS IDENTITY`
  for cheap ordering.
- **Enums:** `text` + `CHECK` (not PG enum types) — easy to evolve without `ALTER TYPE` locks.
- **Timestamps:** `timestamptz`, always UTC. `created_at NOT NULL DEFAULT now()`; mutable rows also have `updated_at`.
- **Soft delete:** `deleted_at timestamptz`; every read predicate includes `deleted_at IS NULL`.
- **Partial indexes** for "active/visible" subsets — they are smaller and hotter.
- **`fillfactor = 80`** on tables that receive frequent in-place updates (`message_parts`, `quota_accounts`).
- **`jsonb`** for genuinely open config/capability blobs, always carrying a `schemaVersion`.
- **Constraints do work in the DB:** FKs on every relationship, `CHECK` for ranges/enums, unique
  indexes for identity, partial unique indexes for "at most one active X".

```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email
-- Optional, for admin user search:
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### 6.2 ERD (abbreviated)

```
divisions ─< users ─< sessions
                │
                ├─< conversations >── ai_models >── ai_providers
                │        │                 └─< ai_model_prices
                │        ├─< messages ─< message_parts >── attachments ─< file_extractions
                │        └─< generation_jobs ─< quota_reservations >── quota_accounts
                │                                    └─< usage_events
                │                                    └─< quota_ledger >── quota_accounts
                ├─< quota_accounts >── quota_accounts(scope)
                ├─< quota_ledger
                └─< idempotency_keys

quota_policies (global | division | user)     jobs
audit_logs   error_events   system_settings   usage_daily
```

### 6.3 Organizations / workspaces — **not created (justified)**

**Decision: omit.** The product is **single-tenant** (PRD A-1): one company, one deployment.
An `organizations` table would add a mandatory join to every root table, a tenant predicate to
every query, and an RLS surface — with **zero MVP benefit**. Isolation **within** the tenant is
already enforced by `user_id` on every user-owned table.

If multi-tenancy becomes a requirement, migrate additively (no rewrite):

```sql
-- FUTURE — do not create now
CREATE TABLE organizations (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE users        ADD COLUMN organization_id uuid NOT NULL REFERENCES organizations(id);
ALTER TABLE conversations ADD COLUMN organization_id uuid NOT NULL REFERENCES organizations(id);
-- ... then enable RLS and set app.organization_id per transaction
```

`divisions` (below) is **not** a tenant boundary — it only drives quota and model visibility.

---

### 6.4 Identity & access

#### `divisions`

- **Purpose:** org unit used for quota policy resolution and (P1) model visibility. Not a data-isolation boundary.
- **Important columns:**
  - `id uuid PK` — UUIDv7.
  - `name text NOT NULL UNIQUE` — display name.
  - `external_ref text` — optional HR/AD group reference for future sync.
  - `created_at timestamptz NOT NULL DEFAULT now()`.
- **Relationships:** referenced by `users.division_id`, `quota_policies.division_id`.
- **Constraints:** unique `name`; `name` non-empty (`CHECK (length(btrim(name)) > 0)`).
- **Indexing strategy:** the `UNIQUE(name)` index covers lookups. Add `UNIQUE (external_ref) WHERE external_ref IS NOT NULL` if sync is introduced.

```sql
CREATE TABLE divisions (
  id           uuid PRIMARY KEY,
  name         text NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
  external_ref text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX divisions_external_ref_uq ON divisions (external_ref) WHERE external_ref IS NOT NULL;
```

#### `users`

- **Purpose:** identity, credentials, role, status, division. The subject of all authorization.
- **Important columns:**
  - `email citext NOT NULL UNIQUE` — login identifier (case-insensitive).
  - `password_hash text NOT NULL` — argon2id; **never logged or returned**.
  - `password_updated_at timestamptz` — set on every change/reset.
  - `must_change_password boolean NOT NULL DEFAULT true` — first login / after admin reset.
  - `failed_login_attempts int NOT NULL DEFAULT 0`, `locked_until timestamptz` — lockout state.
  - `role text` — `user | admin | auditor`.
  - `status text` — `active | disabled`; `disabled` → 401 + session revocation on next request.
  - `division_id uuid` — nullable (unassigned users are possible).
  - `idp_subject text` — **nullable**, reserved for future SSO (A-15).
  - `deleted_at timestamptz` — soft delete.
- **Relationships:** 1‑N to `sessions`, `conversations`, `attachments`, `generation_jobs`, `quota_accounts`; N‑1 to `divisions`.
- **Constraints:** `UNIQUE (email)`; `UNIQUE (idp_subject)` **partial where not null**; range check on `failed_login_attempts >= 0`; `CHECK (role IN (...))`; `CHECK (status IN (...))`.
- **Indexing strategy:**
  - `UNIQUE (email)` — login lookup (citext gives case-insensitivity).
  - `UNIQUE (idp_subject) WHERE idp_subject IS NOT NULL` — future SSO.
  - `(status) WHERE status = 'active'` — admin listings/enable-disable scans.
  - `(division_id) WHERE deleted_at IS NULL` — division rollups.
  - Keyset listing: `(created_at DESC, id)`; add `pg_trgm` GIN on `email`/`display_name` only if substring search is required.

```sql
CREATE TABLE users (
  id                    uuid PRIMARY KEY,
  email                 citext NOT NULL UNIQUE,
  display_name          text NOT NULL,
  password_hash         text NOT NULL,
  password_updated_at   timestamptz NOT NULL DEFAULT now(),
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_login_attempts int NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until          timestamptz,
  role                  text NOT NULL DEFAULT 'user'   CHECK (role IN ('user','admin','auditor')),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  division_id           uuid REFERENCES divisions(id),
  idp_subject           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  last_login_at         timestamptz,
  deleted_at            timestamptz
);
CREATE UNIQUE INDEX users_idp_subject_uq ON users (idp_subject) WHERE idp_subject IS NOT NULL;
CREATE INDEX users_active_idx   ON users (status) WHERE status = 'active';
CREATE INDEX users_division_idx ON users (division_id) WHERE deleted_at IS NULL;
CREATE INDEX users_list_idx     ON users (created_at DESC, id);
```

#### `sessions`

- **Purpose:** server-backed, stateful sessions (opaque cookie → row). Revocable instantly (FR-AUTH-3).
- **Important columns:**
  - `id char(64) PK` — **`sha256(cookie value)`**, never the raw token.
  - `user_id uuid NOT NULL` — owner.
  - `expires_at timestamptz NOT NULL` — idle (8 h) / absolute (24 h) enforced in app.
  - `last_seen_at timestamptz NOT NULL DEFAULT now()` — throttled writes (≤ once/min).
  - `revoked_at timestamptz` — logout / disable / password change.
  - `rotated_from char(64)` — audit trail of session rotation.
  - `ip inet`, `user_agent_hash text` — security forensics, hashed UA.
- **Relationships:** N‑1 to `users`.
- **Constraints:** PK on `id`; FK `users(id)`; `expires_at > created_at`.
- **Indexing strategy:**
  - `(user_id) WHERE revoked_at IS NULL` — revoke-all-sessions for a user.
  - `(expires_at) WHERE revoked_at IS NULL` — hourly purge job.

```sql
CREATE TABLE sessions (
  id              char(64) PRIMARY KEY,                 -- sha256(cookie value)
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  rotated_from    char(64),
  ip              inet,
  user_agent_hash text,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx      ON sessions (expires_at) WHERE revoked_at IS NULL;
```

---

### 6.5 Provider & model registry

#### `ai_providers`

- **Purpose:** one row per upstream provider; config and the **name** of the env var holding its key.
- **Important columns:**
  - `key text NOT NULL UNIQUE` — internal slug (`openai`, `anthropic`).
  - `adapter text NOT NULL` — adapter key resolved in `providers/registry.ts`.
  - `base_url text` — optional override.
  - `secret_ref text NOT NULL` — **environment variable name** (A-16). Never the key.
  - `status text` — `active | disabled`.
  - `config jsonb NOT NULL DEFAULT '{}'` — timeouts, `maxConcurrency`, adapter-specific knobs (Zod-validated by the adapter).
  - `config_version int NOT NULL DEFAULT 1` — bumped on admin write; drives cache invalidation (≤30 s).
- **Relationships:** 1‑N to `ai_models`; referenced by `usage_events`, `error_events`.
- **Constraints:** `UNIQUE (key)`; non-empty `adapter`/`secret_ref`; `CHECK (status IN (...))`.
- **Indexing strategy:** `UNIQUE (key)` for resolution; `(status)` for admin lists. `config` is **not** indexed (never queried by content).

```sql
CREATE TABLE ai_providers (
  id             uuid PRIMARY KEY,
  key            text NOT NULL UNIQUE CHECK (length(btrim(key)) > 0),
  display_name   text NOT NULL,
  adapter        text NOT NULL,
  base_url       text,
  secret_ref     text NOT NULL,             -- env var NAME (A-16); never the key
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  config         jsonb NOT NULL DEFAULT '{}',
  config_version int NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_providers_status_idx ON ai_providers (status);
```

#### `ai_models`

- **Purpose:** the model registry (admin-editable, runtime — no deploy). Capabilities and limits drive
  validation and context building (capability flags, not provider checks — D-4).
- **Important columns:**
  - `provider_id uuid NOT NULL` — FK.
  - `key text NOT NULL UNIQUE` — internal slug.
  - `api_model_id text NOT NULL` — the provider's identifier (admin-entered).
  - `status text` — `active | disabled | deprecated | retired` (PRD §9.4 lifecycle).
  - `capabilities jsonb NOT NULL` — `ModelCapabilities` + `schemaVersion` (vision, pdf, streaming, generation, context window, …).
  - `context_window int`, `max_output_tokens int`, `default_max_output_tokens int`.
  - `quota_weight numeric(8,3) NOT NULL DEFAULT 1.000` — multiplier applied to quota tokens.
  - `config jsonb NOT NULL DEFAULT '{}'` — reasoning effort, `systemAddendum`, `timeoutMs`, etc.
  - `sort_order int`, `retire_at timestamptz`, `replacement_model_id uuid` — lifecycle/UX.
- **Relationships:** N‑1 `ai_providers`; self-FK `replacement_model_id`; 1‑N `ai_model_prices`, `conversations`, `generation_jobs`, `usage_events`.
- **Constraints:** `CHECK (context_window > 0)`, `CHECK (max_output_tokens > 0)`, `CHECK (default_max_output_tokens BETWEEN 1 AND max_output_tokens)`, `CHECK (quota_weight > 0)`; `UNIQUE (provider_id, api_model_id)`; `CHECK (status IN (...))`.
- **Indexing strategy:**
  - `UNIQUE (key)`.
  - `UNIQUE (provider_id, api_model_id)` — prevents duplicate provider identifiers.
  - `(status, sort_order, id)` — `GET /models` ordering.
  - `(provider_id)` — provider health/rollups.
  - Do **not** GIN-index `capabilities` in MVP; capability filtering is done in the registry cache, and JSONB GIN is only worth it if you later query models by capability in SQL.

```sql
CREATE TABLE ai_models (
  id                       uuid PRIMARY KEY,
  provider_id              uuid NOT NULL REFERENCES ai_providers(id),
  key                      text NOT NULL UNIQUE CHECK (length(btrim(key)) > 0),
  api_model_id             text NOT NULL,
  display_name             text NOT NULL,
  description              text,
  status                   text NOT NULL DEFAULT 'disabled'
                             CHECK (status IN ('active','disabled','deprecated','retired')),
  capabilities             jsonb NOT NULL,
  context_window           int  NOT NULL CHECK (context_window > 0),
  max_output_tokens        int  NOT NULL CHECK (max_output_tokens > 0),
  default_max_output_tokens int NOT NULL CHECK (default_max_output_tokens > 0),
  quota_weight             numeric(8,3) NOT NULL DEFAULT 1.000 CHECK (quota_weight > 0),
  config                   jsonb NOT NULL DEFAULT '{}',
  sort_order               int NOT NULL DEFAULT 0,
  retire_at                timestamptz,
  replacement_model_id     uuid REFERENCES ai_models(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (default_max_output_tokens <= max_output_tokens)
);
CREATE UNIQUE INDEX ai_models_provider_api_id_uq ON ai_models (provider_id, api_model_id);
CREATE INDEX ai_models_list_idx     ON ai_models (status, sort_order, id);
CREATE INDEX ai_models_provider_idx ON ai_models (provider_id);
```

#### `ai_model_prices`

- **Purpose:** effective-dated prices so cost is estimated with the price **at request time**, never
  rewritten by later edits.
- **Important columns:**
  - `model_id uuid NOT NULL`, `effective_from timestamptz NOT NULL`.
  - `input_micros_per_mtok bigint`, `output_micros_per_mtok bigint`, `cached_input_micros_per_mtok bigint` — micros per 1M tokens.
  - `currency char(3) NOT NULL DEFAULT 'USD'`.
- **Relationships:** N‑1 `ai_models`.
- **Constraints:** `UNIQUE (model_id, effective_from)`; all prices `>= 0`.
- **Indexing strategy:** the unique index supports "latest price at/before T":
  `SELECT ... WHERE model_id = $1 AND effective_from <= $2 ORDER BY effective_from DESC LIMIT 1`.

```sql
CREATE TABLE ai_model_prices (
  id                            uuid PRIMARY KEY,
  model_id                      uuid NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
  effective_from                timestamptz NOT NULL,
  input_micros_per_mtok         bigint NOT NULL CHECK (input_micros_per_mtok  >= 0),
  output_micros_per_mtok        bigint NOT NULL CHECK (output_micros_per_mtok >= 0),
  cached_input_micros_per_mtok  bigint CHECK (cached_input_micros_per_mtok >= 0),
  currency                      char(3) NOT NULL DEFAULT 'USD',
  created_at                    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, effective_from)
);
```

---

### 6.6 Conversations

#### `conversations`

- **Purpose:** a linear chat thread owned by one user on one model.
- **Important columns:**
  - `user_id uuid NOT NULL` — owner (all reads filter on this).
  - `model_id uuid NOT NULL` — **immutable once `message_count > 0`** (DB-enforced).
  - `title text NOT NULL DEFAULT 'New conversation'`.
  - `message_count int NOT NULL DEFAULT 0` — incremented inside the send transaction (also serializes `seq`).
  - `last_message_at timestamptz`, `deleted_at timestamptz`.
- **Relationships:** N‑1 `users`, `ai_models`; 1‑N `messages`, `generation_jobs`, `attachments`.
- **Constraints:** FK user/model; `CHECK (message_count >= 0)`; **trigger** `forbid_model_switch`
  raising when `model_id` changes and `OLD.message_count > 0`.
- **Indexing strategy:**
  - `(user_id, COALESCE(last_message_at, created_at) DESC, id) WHERE deleted_at IS NULL` — keyset conversation list.
  - `(model_id)` — model-level analytics and lifecycle checks.
  - Never `OFFSET`; page with `(sort_ts, id) < (last_seen_ts, last_seen_id)`.

```sql
CREATE TABLE conversations (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users(id),
  model_id        uuid NOT NULL REFERENCES ai_models(id),
  title           text NOT NULL DEFAULT 'New conversation',
  message_count   int  NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX conversations_user_recent_idx
  ON conversations (user_id, COALESCE(last_message_at, created_at) DESC, id)
  WHERE deleted_at IS NULL;
CREATE INDEX conversations_model_idx ON conversations (model_id);

CREATE FUNCTION forbid_model_switch() RETURNS trigger AS $$
BEGIN
  IF NEW.model_id <> OLD.model_id AND OLD.message_count > 0 THEN
    RAISE EXCEPTION 'conversation model is immutable after first message' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER conversations_model_lock
  BEFORE UPDATE OF model_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION forbid_model_switch();
```

#### `messages`

- **Purpose:** ordered turns (`user`/`assistant`) inside a conversation.
- **Important columns:**
  - `conversation_id uuid NOT NULL`, `seq bigint NOT NULL` — monotonic per conversation.
  - `role text` — `user | assistant`.
  - `status text` — `streaming | complete | incomplete | failed`.
  - `finish_reason text` — `stop | length | content_filter | cancelled | error | timeout | interrupted` (null while streaming).
  - `superseded_by uuid` — set on a retried failed/cancelled message (hidden from default listing, kept for audit).
  - `metadata jsonb NOT NULL DEFAULT '{}'` — e.g. `contextTruncated`.
- **Relationships:** N‑1 `conversations` (cascade delete); 1‑N `message_parts`; self-FK `superseded_by`;
  referenced by `generation_jobs` (`user_message_id`, `assistant_message_id`); `attachments.message_id`.
- **Constraints:** `UNIQUE (conversation_id, seq)`; role/status/finish_reason `CHECK`s; FK cascade.
- **Indexing strategy:**
  - `UNIQUE (conversation_id, seq)` — load and keyset pagination (`?before=<seq>`).
  - `(conversation_id, created_at)` not needed (seq is monotonic and sufficient).
  - `(status) WHERE status = 'streaming'` — recovery scans for stuck placeholders.

```sql
CREATE TABLE messages (
  id              uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             bigint NOT NULL,
  role            text   NOT NULL CHECK (role IN ('user','assistant')),
  status          text   NOT NULL CHECK (status IN ('streaming','complete','incomplete','failed')),
  finish_reason   text CHECK (finish_reason IN
                    ('stop','length','content_filter','cancelled','error','timeout','interrupted')),
  superseded_by   uuid REFERENCES messages(id),
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_streaming_idx ON messages (status) WHERE status = 'streaming';
```

#### `message_parts`

- **Purpose:** ordered, typed content blocks. `text` streams into `text_content`; everything else
  references an `attachments` row. Adding new part types needs **no migration** beyond a `CHECK` update (D-5).
- **Important columns:**
  - `message_id uuid NOT NULL`, `position int NOT NULL` — render order (assigned in event-start order).
  - `type text` — `text | image | document | generated_file | structured | tool_call | tool_result | reasoning`.
  - `status text` — `streaming | complete | incomplete | failed`.
  - `text_content text` — only for `type='text'`; appended during streaming.
  - `data jsonb NOT NULL DEFAULT '{}'` — type-specific metadata + `schemaVersion`.
  - `file_id uuid` — for binary-backed parts.
- **Relationships:** N‑1 `messages` (cascade); N‑1 `attachments`.
- **Constraints:**
  - `UNIQUE (message_id, position)`.
  - `type`/`status` `CHECK`s.
  - `CHECK (type <> 'text' OR file_id IS NULL)` — text parts are never file-backed.
  - `CHECK (status <> 'complete' OR type NOT IN ('image','document','generated_file') OR file_id IS NOT NULL)`
    — a **completed** binary part must point at a stored attachment (streaming parts may not yet).
- **Indexing strategy:**
  - `UNIQUE (message_id, position)` — one query loads all parts: `WHERE message_id = ANY($ids) ORDER BY message_id, position`.
  - `(file_id) WHERE file_id IS NOT NULL` — reverse lookup / integrity.
  - **`WITH (fillfactor = 80)`** so the frequent `text_content = text_content || $chunk` updates stay HOT
    (updated tuple on the same page → no index churn). Lower autovacuum thresholds on this table.

```sql
CREATE TABLE message_parts (
  id           uuid PRIMARY KEY,
  message_id   uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position     int  NOT NULL CHECK (position >= 0),
  type         text NOT NULL CHECK (type IN
                 ('text','image','document','generated_file','structured','tool_call','tool_result','reasoning')),
  status       text NOT NULL DEFAULT 'complete'
                 CHECK (status IN ('streaming','complete','incomplete','failed')),
  text_content text,
  data         jsonb NOT NULL DEFAULT '{}',
  file_id      uuid,                       -- FK added after attachments
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, position),
  CHECK (type <> 'text' OR file_id IS NULL),
  CHECK (status <> 'complete' OR type NOT IN ('image','document','generated_file') OR file_id IS NOT NULL)
) WITH (fillfactor = 80);
CREATE INDEX message_parts_file_idx ON message_parts (file_id) WHERE file_id IS NOT NULL;
```

---

### 6.7 Attachments (binary artifacts)

#### `attachments`

- **Purpose:** metadata + **opaque storage reference** for every uploaded or generated binary.
  Blobs live behind `StorageProvider`; **no filesystem path is ever stored or returned** (PRD §12.1).
- **Important columns:**
  - `owner_user_id uuid NOT NULL` — always enforced.
  - `conversation_id uuid NOT NULL`, `message_id uuid` (null until attached), `message_part_id uuid`.
  - `origin text` — `input | generated` (PRD calls this `role`; `origin` avoids clashing with `messages.role`).
  - `kind text` — `image | document | other`.
  - `display_name text NOT NULL` — sanitized original name, **display only**.
  - `declared_mime text`, `detected_mime text NOT NULL` — must be compatible (magic-byte check).
  - `size_bytes bigint NOT NULL`, `sha256 char(64) NOT NULL`.
  - `storage_provider text NOT NULL`, `storage_bucket text`, `storage_key text NOT NULL` — opaque key, e.g. `files/2026/10/<uuid>`.
  - `status text` — `uploading | validating | processing | ready | rejected | failed | missing | expired | deleted`.
  - `width int`, `height int`, `page_count int`, `error_code text`.
  - `expires_at timestamptz NOT NULL`, `deleted_at timestamptz`, `pinned_at timestamptz` (P2 pinning).
- **Relationships:** N‑1 `users`, `conversations`, `messages`; 1‑1 `file_extractions`; 1‑N `message_parts`.
- **Constraints:** FK owner/conversation/message; `CHECK (size_bytes >= 0)`; `status` `CHECK`;
  `UNIQUE (storage_key)` (the key scheme is globally unique); `sha256` is 64 hex chars.
- **Indexing strategy:**
  - `(owner_user_id, conversation_id)` — ownership checks on attach/list.
  - `(expires_at) WHERE status NOT IN ('expired','deleted')` — the cleanup job's driving query (partial → tiny).
  - `(message_id) WHERE message_id IS NOT NULL` — load parts' files.
  - `(sha256)` — optional dedupe/integrity analytics.
  - Weekly reconciliation lists the storage prefix and compares to rows (PRD §12.8).

```sql
CREATE TABLE attachments (
  id              uuid PRIMARY KEY,
  owner_user_id   uuid NOT NULL REFERENCES users(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id      uuid REFERENCES messages(id) ON DELETE SET NULL,
  message_part_id uuid,
  origin          text NOT NULL CHECK (origin IN ('input','generated')),
  kind            text NOT NULL CHECK (kind IN ('image','document','other')),
  display_name    text NOT NULL,
  declared_mime   text,
  detected_mime   text NOT NULL,
  size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
  sha256          char(64) NOT NULL,
  storage_provider text NOT NULL,
  storage_bucket   text,
  storage_key      text NOT NULL,
  status          text NOT NULL CHECK (status IN
                    ('uploading','validating','processing','ready','rejected','failed','missing','expired','deleted')),
  error_code   text,
  width        int,
  height       int,
  page_count   int,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  pinned_at    timestamptz,
  UNIQUE (storage_key)
);
ALTER TABLE message_parts
  ADD CONSTRAINT message_parts_file_fk FOREIGN KEY (file_id) REFERENCES attachments(id);
CREATE INDEX attachments_owner_conv_idx ON attachments (owner_user_id, conversation_id);
CREATE INDEX attachments_message_idx    ON attachments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX attachments_expiry_idx     ON attachments (expires_at) WHERE status NOT IN ('expired','deleted');
CREATE INDEX attachments_sha256_idx     ON attachments (sha256);
```

#### `file_extractions`

- **Purpose:** extracted text for input documents, retained with the conversation after the binary
  expires (A-14), so long conversations keep working.
- **Important columns:** `file_id uuid PK`; `status text` (`pending | done | failed | unsupported`);
  `extractor text`; `text text`; `char_count int`; `token_estimate int`; `truncated boolean`;
  `page_count int`; `error_code text`.
- **Relationships:** 1‑1 with `attachments` (cascade delete).
- **Constraints:** PK/FK `file_id`; `status` `CHECK`; `char_count >= 0`.
- **Indexing strategy:** PK is the access path. Add `(status) WHERE status = 'pending'` if a queue scans
  this table; with the `jobs` table this is usually unnecessary.

```sql
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
```

---

### 6.8 Generations

#### `generation_jobs`

- **Purpose:** the execution record for one assistant message — **it is also the job record**
  (PRD §14.6). Owns the state machine `pending → generating → completed | cancelled | failed`.
- **Important columns:**
  - `conversation_id`, `user_id`, `model_id` — dimensions for quota, analytics, ownership.
  - `user_message_id uuid NOT NULL`, `assistant_message_id uuid NOT NULL` — the message pair.
  - `request_id text NOT NULL` — request correlation (PRD §21.1).
  - `status text` — state machine values.
  - `runner_id text` — owning process (single-owner in MVP); `attempt_count int`.
  - `est_input_tokens int`, `max_output_tokens int` — the reservation basis.
  - `context_info jsonb` — truncation details surfaced to the UI.
  - `provider_request_id text` — support tickets only.
  - `error_code text`, `error_detail jsonb` — **sanitized**.
  - `cancel_reason text`, `cancel_requested_at timestamptz`.
  - `heartbeat_at timestamptz`, `last_event_seq int` — liveness and SSE replay.
- **Relationships:** N‑1 `conversations`, `users`, `ai_models`, `messages` (×2); 1‑1 `quota_reservations`;
  1‑1 `usage_events`.
- **Constraints:**
  - `status` `CHECK`.
  - **At most one active generation per conversation:**
    `CREATE UNIQUE INDEX ... ON generation_jobs (conversation_id) WHERE status IN ('pending','generating')`.
  - Terminal transitions use a conditional update `WHERE status IN ('pending','generating')` so
    cancel/complete/fail races resolve to exactly one terminal state (PRD §14.2).
- **Indexing strategy:**
  - Partial unique `one_active_generation_per_conversation` — enforces FR-CONV-4 and is also the lookup.
  - `(user_id) WHERE status IN ('pending','generating')` — concurrent-generation limit check.
  - `(heartbeat_at) WHERE status = 'generating'` — reaper's stale-heartbeat scan.
  - `(conversation_id, created_at DESC)` — history/debug.
  - `UNIQUE (request_id)` if one request maps to one generation (recommended).

```sql
CREATE TABLE generation_jobs (
  id                   uuid PRIMARY KEY,
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL REFERENCES users(id),
  model_id             uuid NOT NULL REFERENCES ai_models(id),
  user_message_id      uuid NOT NULL REFERENCES messages(id),
  assistant_message_id uuid NOT NULL REFERENCES messages(id),
  request_id           text NOT NULL,
  status               text NOT NULL CHECK (status IN ('pending','generating','completed','cancelled','failed')),
  runner_id            text,
  attempt_count        int NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  est_input_tokens     int CHECK (est_input_tokens >= 0),
  max_output_tokens    int CHECK (max_output_tokens > 0),
  context_info         jsonb NOT NULL DEFAULT '{}',
  provider_request_id  text,
  error_code           text,
  error_detail         jsonb,
  cancel_reason        text,
  cancel_requested_at  timestamptz,
  heartbeat_at         timestamptz,
  last_event_seq       int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  started_at           timestamptz,
  finished_at          timestamptz
);
CREATE UNIQUE INDEX one_active_generation_per_conversation
  ON generation_jobs (conversation_id) WHERE status IN ('pending','generating');
CREATE INDEX generation_jobs_active_user_idx ON generation_jobs (user_id) WHERE status IN ('pending','generating');
CREATE INDEX generation_jobs_stale_idx       ON generation_jobs (heartbeat_at) WHERE status = 'generating';
CREATE INDEX generation_jobs_conv_idx        ON generation_jobs (conversation_id, created_at DESC);
CREATE UNIQUE INDEX generation_jobs_request_uq ON generation_jobs (request_id);
```

#### `idempotency_keys`

- **Purpose:** make "create a generation" safe to retry (double-click, timeout, reconnect) — same key
  returns the original response, never a second generation or charge (FR-GEN-1, NFR-REL-2).
- **Important columns:**
  - `user_id uuid NOT NULL`, `key text NOT NULL` — **PK `(user_id, key)`**.
  - `endpoint text NOT NULL`, `request_hash char(64) NOT NULL` — `sha256` of canonical payload.
  - `response_status int`, `response_body jsonb` — replay payload (contains `generation.id`).
  - `expires_at timestamptz NOT NULL` — 24 h TTL.
- **Relationships:** N‑1 `users`; logically references a `generation_jobs` row via `response_body`.
- **Constraints:** PK `(user_id, key)`. The insert participates in the **same transaction** as the
  reservation and message/generation creation, so a concurrent duplicate blocks on the PK until the
  first commits, then replays — there is no in-progress limbo (PRD §16.5).
- **Indexing strategy:** PK serves lookups by `(user_id, key)`; add `(expires_at)` for the hourly purge.

```sql
CREATE TABLE idempotency_keys (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           text NOT NULL,
  endpoint      text NOT NULL,
  request_hash  char(64) NOT NULL,
  response_status int NOT NULL,
  response_body   jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);
```

---

### 6.9 Quota & usage

#### `quota_policies`

- **Purpose:** admin-set policy at `global | division | user` scope. Each field is nullable and
  **resolved per field** (`user → division → global`).
- **Important columns:** `scope text`; `division_id uuid`; `user_id uuid`;
  `monthly_tokens bigint`; `max_input_tokens_per_request int`; `max_output_tokens_per_request int`;
  `max_concurrent_generations int`; `allowed_model_ids uuid[]` (P1); `updated_by uuid`; `updated_at`.
- **Relationships:** N‑1 `divisions` / `users`.
- **Constraints:** XOR check ensuring the right ID is present for the scope:
  `(scope='global' AND division_id IS NULL AND user_id IS NULL) OR ...`.
  Unique per scope via `COALESCE(division_id, user_id, sentinel)`.
- **Indexing strategy:** the unique scope index is the only access path.

```sql
CREATE TABLE quota_policies (
  id                        uuid PRIMARY KEY,
  scope                     text NOT NULL CHECK (scope IN ('global','division','user')),
  division_id               uuid REFERENCES divisions(id),
  user_id                   uuid REFERENCES users(id),
  monthly_tokens            bigint CHECK (monthly_tokens >= 0),
  max_input_tokens_per_request  int CHECK (max_input_tokens_per_request > 0),
  max_output_tokens_per_request int CHECK (max_output_tokens_per_request > 0),
  max_concurrent_generations    int CHECK (max_concurrent_generations > 0),
  allowed_model_ids         uuid[],
  updated_by                uuid REFERENCES users(id),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope='global'   AND division_id IS NULL     AND user_id IS NULL)
      OR (scope='division' AND division_id IS NOT NULL AND user_id IS NULL)
      OR (scope='user'     AND user_id IS NOT NULL     AND division_id IS NULL))
);
CREATE UNIQUE INDEX quota_policy_scope_uq
  ON quota_policies (scope, COALESCE(division_id, user_id, '00000000-0000-0000-0000-000000000000'));
```

#### `quota_accounts`

- **Purpose:** the **counters** for a user for a period. This single row is the concurrency-control point:
  a conditional `UPDATE` serializes reservations (PRD §11.4).
- **Important columns:**
  - `user_id uuid NOT NULL`.
  - `scope_type text NOT NULL DEFAULT 'total'` (`total | provider | model` — future), `scope_id uuid`.
  - `period_start timestamptz`, `period_end timestamptz` — computed from `QUOTA_TIMEZONE` (default UTC+7), stored UTC.
  - `base_limit_tokens bigint NOT NULL`, `adjustment_tokens bigint NOT NULL DEFAULT 0`.
  - `used_tokens bigint NOT NULL DEFAULT 0`, `reserved_tokens bigint NOT NULL DEFAULT 0`.
  - `limits jsonb NOT NULL DEFAULT '{}'` — snapshot of resolved max input/output + concurrency.
- **Relationships:** N‑1 `users`; 1‑N `quota_reservations`, `quota_ledger`, `usage_events`.
- **Constraints:** `used_tokens >= 0`, `reserved_tokens >= 0`, `base_limit_tokens >= 0`;
  `UNIQUE (user_id, scope_type, COALESCE(scope_id, sentinel), period_start)`.
- **Indexing strategy:** the unique index supports lazy period creation
  (`INSERT ... ON CONFLICT DO NOTHING`) and lookups. `(user_id, period_start DESC)` for history views.
  `fillfactor = 80` (frequent in-place counter updates).

```sql
CREATE TABLE quota_accounts (
  id                uuid PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users(id),
  scope_type        text NOT NULL DEFAULT 'total' CHECK (scope_type IN ('total','provider','model')),
  scope_id          uuid,
  period_start      timestamptz NOT NULL,
  period_end        timestamptz NOT NULL,
  base_limit_tokens bigint NOT NULL CHECK (base_limit_tokens >= 0),
  adjustment_tokens bigint NOT NULL DEFAULT 0,
  used_tokens       bigint NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  reserved_tokens   bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  limits            jsonb NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start)
) WITH (fillfactor = 80);
CREATE UNIQUE INDEX quota_accounts_uq
  ON quota_accounts (user_id, scope_type, COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'), period_start);
CREATE INDEX quota_accounts_user_period_idx ON quota_accounts (user_id, period_start DESC);
```

#### `quota_reservations`

- **Purpose:** holds tokens for exactly one generation; converted to consumed (**settle**) or returned
  (**release**), idempotently. Reused across provider retries — never double-reserved.
- **Important columns:** `generation_id uuid NOT NULL UNIQUE`; `user_id uuid`; `account_id uuid`;
  `reserved_tokens bigint NOT NULL`; `settled_tokens bigint`; `status text`
  (`active | settled | released | expired`); `expires_at timestamptz NOT NULL`; `finalized_at timestamptz`.
- **Relationships:** 1‑1 `generation_jobs`; N‑1 `quota_accounts`, `users`.
- **Constraints:** `UNIQUE (generation_id)` (idempotency), `reserved_tokens > 0`, `status` `CHECK`.
- **Indexing strategy:**
  - `UNIQUE (generation_id)` — the settle/release idempotency key.
  - `(expires_at) WHERE status = 'active'` — the reservation reaper's driving query.

```sql
CREATE TABLE quota_reservations (
  id              uuid PRIMARY KEY,
  generation_id   uuid NOT NULL UNIQUE REFERENCES generation_jobs(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id),
  account_id      uuid NOT NULL REFERENCES quota_accounts(id),
  reserved_tokens bigint NOT NULL CHECK (reserved_tokens > 0),
  settled_tokens  bigint CHECK (settled_tokens >= 0),
  status          text NOT NULL CHECK (status IN ('active','settled','released','expired')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finalized_at    timestamptz
);
CREATE INDEX quota_res_active_exp_idx ON quota_reservations (expires_at) WHERE status = 'active';
```

#### `quota_ledger`

- **Purpose:** append-only, signed record of every quota movement. Corrections are **new rows**, never
  edits. This is the evidence used by nightly reconciliation (NFR-QA-1).
- **Important columns:** `id bigint IDENTITY PK`; `user_id`; `account_id`; `generation_id` (nullable);
  `entry_type text` (`period_open | reserve | settle | release | expire_release | adjust | grant`);
  `tokens_delta bigint` (**signed**); `used_after bigint`, `reserved_after bigint`; `actor_user_id`;
  `reason`; `request_id`; `created_at`.
- **Relationships:** N‑1 `users`, `quota_accounts`; optional N‑1 `generation_jobs`.
- **Constraints:** `entry_type` `CHECK`; `tokens_delta <> 0` (except `period_open`).
  **Append-only is enforced by grants**, not by a trigger (see §6.11).
- **Indexing strategy:** `PK(id)` for ordering; `(user_id, created_at DESC)` for user ledgers;
  `(account_id, id)` for period folding. Optional monthly partitioning when it grows large.

```sql
CREATE TABLE quota_ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       uuid NOT NULL,
  account_id    uuid NOT NULL REFERENCES quota_accounts(id),
  generation_id uuid REFERENCES generation_jobs(id) ON DELETE SET NULL,
  entry_type    text NOT NULL CHECK (entry_type IN
                  ('period_open','reserve','settle','release','expire_release','adjust','grant')),
  tokens_delta  bigint NOT NULL DEFAULT 0,     -- signed: reserve/adjust(+,-); see entry_type
  used_after    bigint NOT NULL,
  reserved_after bigint NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  reason        text,
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_ledger_user_time_idx ON quota_ledger (user_id, created_at DESC);
CREATE INDEX quota_ledger_account_idx   ON quota_ledger (account_id, id);
```

#### `usage_events`

- **Purpose:** one row per **settled** generation — the source of truth for reporting and cost.
  Immutable (written once at finalization).
- **Important columns:** `generation_id uuid NOT NULL UNIQUE`; `user_id`; `division_id`; `provider_id`;
  `model_id`; `account_id`; `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_tokens`;
  `quota_tokens bigint`; `overshoot_tokens bigint NOT NULL DEFAULT 0`; `usage_source text`
  (`provider | estimated`); `est_cost_micros bigint`; `cost_currency`; `outcome text`
  (`completed | cancelled | failed`); `error_category`; `duration_ms`; `time_to_first_token_ms`.
- **Relationships:** 1‑1 `generation_jobs`; N‑1 `users`, `divisions`, `ai_providers`, `ai_models`, `quota_accounts`.
- **Constraints:** `UNIQUE (generation_id)`; all token counts `>= 0`; `usage_source`/`outcome` `CHECK`s.
- **Indexing strategy:**
  - `UNIQUE (generation_id)` — idempotent finalization.
  - `(user_id, created_at DESC)` and `(model_id, created_at DESC)` — admin/user reporting dimensions.
  - `(division_id, created_at DESC)` — division rollups.
  - At high volume, consider **BRIN** on `created_at` for range scans, and monthly **declarative partitioning**.
    Note: a partitioned table cannot keep `UNIQUE (generation_id)` unless the partition key is included —
    if you partition, enforce single-write via the finalizer's `INSERT ... ON CONFLICT` against a
    non-partitioned dedupe or accept app-level idempotency. Do not partition before ~50M rows.

```sql
CREATE TABLE usage_events (
  id                     uuid PRIMARY KEY,
  generation_id          uuid NOT NULL UNIQUE REFERENCES generation_jobs(id),
  user_id                uuid NOT NULL REFERENCES users(id),
  division_id            uuid REFERENCES divisions(id),
  provider_id            uuid NOT NULL REFERENCES ai_providers(id),
  model_id               uuid NOT NULL REFERENCES ai_models(id),
  account_id             uuid NOT NULL REFERENCES quota_accounts(id),
  input_tokens           int  NOT NULL CHECK (input_tokens  >= 0),
  output_tokens          int  NOT NULL CHECK (output_tokens >= 0),
  cached_input_tokens    int  CHECK (cached_input_tokens >= 0),
  reasoning_tokens       int  CHECK (reasoning_tokens >= 0),
  quota_tokens           bigint NOT NULL CHECK (quota_tokens >= 0),
  overshoot_tokens       bigint NOT NULL DEFAULT 0 CHECK (overshoot_tokens >= 0),
  usage_source           text NOT NULL CHECK (usage_source IN ('provider','estimated')),
  est_cost_micros        bigint CHECK (est_cost_micros >= 0),
  cost_currency          char(3) NOT NULL DEFAULT 'USD',
  outcome                text NOT NULL CHECK (outcome IN ('completed','cancelled','failed')),
  error_category         text,
  duration_ms            int CHECK (duration_ms >= 0),
  time_to_first_token_ms int CHECK (time_to_first_token_ms >= 0),
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_user_time_idx     ON usage_events (user_id, created_at DESC);
CREATE INDEX usage_events_model_time_idx    ON usage_events (model_id, created_at DESC);
CREATE INDEX usage_events_division_time_idx ON usage_events (division_id, created_at DESC);
```

#### `usage_daily`

- **Purpose:** **disposable, reproducible** daily rollup for fast dashboards. Rebuilt nightly and
  maintained incrementally every 5 min.
- **Important columns:** `day date`, `user_id`, `division_id`, `provider_id`, `model_id`,
  `requests int`, `failed_requests int`, `input_tokens bigint`, `output_tokens bigint`,
  `quota_tokens bigint`, `est_cost_micros bigint`.
- **Relationships:** N‑1 `users`, `divisions`, `ai_providers`, `ai_models`.
- **Constraints:** PK `(day, user_id, model_id)` (upsert target).
- **Indexing strategy:** PK for upserts; add `(day)` and `(model_id, day)` for admin group-by queries.

```sql
CREATE TABLE usage_daily (
  day             date NOT NULL,
  user_id         uuid NOT NULL,
  division_id     uuid,
  provider_id     uuid NOT NULL,
  model_id        uuid NOT NULL,
  requests        int    NOT NULL CHECK (requests >= 0),
  failed_requests int    NOT NULL CHECK (failed_requests >= 0),
  input_tokens    bigint NOT NULL CHECK (input_tokens  >= 0),
  output_tokens   bigint NOT NULL CHECK (output_tokens >= 0),
  quota_tokens    bigint NOT NULL CHECK (quota_tokens  >= 0),
  est_cost_micros bigint CHECK (est_cost_micros >= 0),
  PRIMARY KEY (day, user_id, model_id)
);
CREATE INDEX usage_daily_day_idx       ON usage_daily (day);
CREATE INDEX usage_daily_model_day_idx ON usage_daily (model_id, day);
```

---

### 6.10 Audit, ops & jobs

#### `audit_logs`

- **Purpose:** immutable record of admin mutations and security events, written **in the same
  transaction** as the change (NFR-AUD-1).
- **Important columns:** `id bigint IDENTITY PK`; `actor_user_id` (nullable for system);
  `action text NOT NULL`; `target_type`, `target_id`; `before jsonb`, `after jsonb` (**secrets redacted**);
  `request_id`, `ip inet`, `user_agent_hash`; `prev_hash char(64)` (optional tamper-evident chain).
- **Relationships:** N‑1 `users` (actor); polymorphic `(target_type, target_id)` — intentionally **no FK**.
- **Constraints:** `action` non-empty. Append-only via grants (§6.11).
- **Indexing strategy:** `(created_at DESC)` for the log view; `(actor_user_id, created_at DESC)`;
  `(target_type, target_id, created_at DESC)` for "history of this resource"; at scale, BRIN on `created_at`.

```sql
CREATE TABLE audit_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id   uuid REFERENCES users(id),
  action          text NOT NULL,
  target_type     text,
  target_id       text,
  before          jsonb,
  after           jsonb,
  request_id      text,
  ip              inet,
  user_agent_hash text,
  prev_hash       char(64),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_time_idx   ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id, created_at DESC);
```

#### `jobs`

- **Purpose:** PostgreSQL-backed job queue (`SELECT ... FOR UPDATE SKIP LOCKED`). No broker in MVP.
- **Important columns:** `type text NOT NULL`; `payload jsonb`; `status text`
  (`queued | running | done | failed | dead`); `run_at timestamptz`; `attempts int`, `max_attempts int`;
  `locked_by text`, `locked_at timestamptz`, `last_error text`; **`dedupe_key text UNIQUE`** (idempotent scheduling).
- **Relationships:** none (payload carries references).
- **Constraints:** `status` `CHECK`; `attempts >= 0`; `max_attempts >= 1`; unique `dedupe_key`.
- **Indexing strategy:**
  - `(run_at) WHERE status = 'queued'` — the poller's driving query (partial → small and hot).
  - `UNIQUE (dedupe_key)` — prevents duplicate scheduled work.

```sql
CREATE TABLE jobs (
  id           uuid PRIMARY KEY,
  type         text NOT NULL,
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts int NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  locked_by    text,
  locked_at    timestamptz,
  last_error   text,
  dedupe_key   text UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX jobs_due_idx ON jobs (run_at) WHERE status = 'queued';
```

#### `system_settings`

- **Purpose:** versioned, audited platform settings — system prompt, file limits, retention,
  **`quota.timezone`** (default `Asia/Jakarta`).
- **Important columns:** `key text PK`; `value jsonb NOT NULL`; `version int`; `updated_by uuid`; `updated_at`.
- **Relationships:** N‑1 `users` (last editor).
- **Constraints:** PK `key`; consumers validate `value` with a Zod schema per key.
- **Indexing strategy:** PK only.

```sql
CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  version    int NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

#### `error_events`

- **Purpose:** sanitized system errors for the admin error explorer (no provider bodies, no stack traces).
- **Important columns:** `id bigint IDENTITY PK`; `occurred_at`; `request_id`; `component text NOT NULL`;
  `category text NOT NULL`; `provider_id`, `model_id`, `generation_id` (no FK on the last — must survive generation purge);
  `message text NOT NULL`; `context jsonb`.
- **Relationships:** soft references to registry/generation — **no FKs** so logs survive deletions.
- **Constraints:** `component`/`category`/`message` non-empty.
- **Indexing strategy:** `(occurred_at DESC, category)`; optional `(request_id)`.

```sql
CREATE TABLE error_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  request_id    text,
  component     text NOT NULL,
  category      text NOT NULL,
  provider_id   uuid,
  model_id      uuid,
  generation_id uuid,
  message       text NOT NULL,
  context       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX error_events_time_idx ON error_events (occurred_at DESC, category);
```

---

### 6.11 Roles, grants & append-only enforcement

Append-only tables are protected by **privileges**, not by application discipline.

```sql
-- Roles (names illustrative)
--   app_role      : the running service
--   migrator_role : owns DDL, runs migrations
--   readonly_role : auditors/dashboards (SELECT only)

-- Full DML on mutable tables
GRANT SELECT, INSERT, UPDATE, DELETE ON
  users, sessions, divisions, ai_providers, ai_models, ai_model_prices,
  conversations, messages, message_parts, attachments, file_extractions,
  generation_jobs, idempotency_keys, quota_policies, quota_accounts,
  quota_reservations, usage_events, usage_daily, jobs, system_settings, error_events
TO app_role;

-- Append-only tables: no UPDATE / DELETE for the app
GRANT SELECT, INSERT ON quota_ledger, audit_logs TO app_role;
REVOKE UPDATE, DELETE ON quota_ledger, audit_logs FROM app_role;

-- Auditors read reporting only
GRANT SELECT ON usage_events, usage_daily, audit_logs, error_events,
                quota_accounts, quota_ledger, ai_providers, ai_models
TO readonly_role;
```

### 6.12 Transaction-safety recipes

These are the load-bearing flows. Implement them exactly; they are what make quota, idempotency,
and streaming crash-safe.

**T1 — Create a generation (one short transaction).**
Inside the transaction: insert `idempotency_keys` → reserve quota (conditional `UPDATE`) →
`UPDATE conversations ... RETURNING message_count` to allocate `seq` → insert user message + parts →
insert assistant placeholder (`status='streaming'`) → insert `generation_jobs` (`pending`) →
set `attachments.message_id`. Commit, **then** start the provider call.

```sql
-- Atomic reservation: the conditional UPDATE is the concurrency control.
UPDATE quota_accounts
   SET reserved_tokens = reserved_tokens + $reserve, updated_at = now()
 WHERE id = $account_id
   AND used_tokens + reserved_tokens + $reserve <= base_limit_tokens + adjustment_tokens
RETURNING used_tokens, reserved_tokens, base_limit_tokens + adjustment_tokens AS limit_tokens;
-- 0 rows => ROLLBACK with 429 quota_exceeded (include remaining + resetAt)

-- Sequence allocation serializes per conversation (row lock):
UPDATE conversations SET message_count = message_count + 2, last_message_at = now(), updated_at = now()
 WHERE id = $conversation_id AND deleted_at IS NULL
RETURNING message_count;
-- user seq = message_count - 1, assistant seq = message_count
```

**T2 — Settle or release (finalizer, idempotent).** One transaction keyed by `generation_id`:

```sql
SELECT * FROM quota_reservations WHERE generation_id = $g FOR UPDATE;
-- status <> 'active' => no-op (already settled/released/expired): idempotent

UPDATE quota_accounts
   SET reserved_tokens = reserved_tokens - $reserved,
       used_tokens     = used_tokens + $actual,   -- 0 on release
       updated_at = now()
 WHERE id = $account_id;

UPDATE quota_reservations
   SET status = $status, settled_tokens = $actual, finalized_at = now()
 WHERE generation_id = $g;

INSERT INTO usage_events (...) VALUES (...);        -- only on settle
INSERT INTO quota_ledger (...) VALUES (...);        -- entry_type settle|release, signed delta, balances after
```

**T3 — Set a terminal state exactly once** (resolves cancel/complete/fail races):

```sql
UPDATE generation_jobs
   SET status = $terminal, finished_at = now(), error_code = $code
 WHERE id = $g AND status IN ('pending','generating')
RETURNING id;
-- 0 rows => another path already finalized; do not settle twice
```

**T4 — Idempotent send replay:** `INSERT INTO idempotency_keys ... ON CONFLICT (user_id, key) DO NOTHING`;
if `0 rows` then `SELECT` the stored response; compare `request_hash` — match ⇒ replay with
`Idempotency-Replayed: true`; mismatch ⇒ `422 idempotency_key_reuse`.

**T5 — Streaming checkpoints** are **not** in the generation transaction: the checkpointer runs
`UPDATE message_parts SET text_content = text_content || $chunk, updated_at = now() WHERE id = $id`
every 1 s / 2 KB and bumps `generation_jobs.heartbeat_at`. Streams hold no DB connection.

### 6.13 Isolation, locking & scheduler

- Default isolation is **`READ COMMITTED`**. The counter reservation is correct under it because the
  conditional `UPDATE` re-evaluates its `WHERE` after the row lock is released (PRD §11.4).
- Prefer `SELECT ... FOR UPDATE` only where a read-then-write sequence must be atomic (settlement).
- **Schedulers** (cron-like jobs) take `pg_try_advisory_lock(hashtext('scheduler:<name>'))` so exactly
  one process schedules each recurring job.
- Keep transactions **short**; never do network I/O (provider calls, storage writes) inside a transaction.
- **P1 hardening:** row-level security on `conversations`, `messages`, `message_parts`, `attachments`
  keyed on `current_setting('app.user_id')`, set with `SET LOCAL app.user_id = $1` per transaction.
  Application filters remain primary.

### 6.14 Migrations & evolution policy

- **Forward-only**, expand/contract, reviewed. No destructive change in the same release that stops using a column.
- Run migrations as a **pre-deploy job** under an advisory lock; never on container boot.
- Adding a part type / status = update the `CHECK` (cheap) — no new table.
- New capability keys go inside `capabilities`/`config` JSON with a bumped `schemaVersion` — no migration.
- Partition `message_parts`, `usage_events`, `audit_logs`, `quota_ledger` by month only when
  > ~50M rows or retention purges get heavy (and remember the unique-constraint caveat in §6.9).
- The example seed file is **never** auto-applied in production (A-11).

---

## 7. Testing expectations

- **Never mock the database** for quota, idempotency, or transaction tests (Testcontainers + real PG).
- Required suites: quota concurrency/property, adapter contract, idempotency, streaming replay,
  upload hardening, auth (lockout, session rotation, revocation), security (IDOR on every ID route,
  secret/password leak scan).
- Quota oversubscription test: limit 100,000 with 50 × 20,000 parallel reservations ⇒ **exactly 5 succeed**,
  and `used + reserved <= limit` holds at every sampled instant.
- Coverage gate: ≥ 80 % lines on `quota`, `orchestrator`, `context`, `providers`; 100 % of error mappings.

## 8. Definition of done

A change is done when: types pass, lint passes (including the provider-import rule), unit +
integration tests pass against real PostgreSQL, the migration is forward-only and reviewed, no
secret/content appears in logs, audit rows are written for admin/security mutations, and — for
anything touching quota — the concurrency and idempotency tests are green.
