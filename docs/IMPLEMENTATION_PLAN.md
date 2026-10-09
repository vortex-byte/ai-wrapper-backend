# Implementation & Deployment Plan — Scaffold → VPS (no Docker)

| | |
|---|---|
| **Document status** | v1.1 — execution companion to `docs/PRD.md` (Draft v1.3) |
| **Date** | 2026-10-08 |
| **Scope** | Phased build plan (Phase 0 → launch) **and** a native VPS deployment/operations guide (**systemd + PostgreSQL + Bun, no Docker**) |
| **Sources of truth** | `docs/PRD.md` (behaviour) · `docs/API_CONTRACTS.md` (wire) · `AGENTS.md` (conventions & schema) |

> **Deliberate deviation from PRD §24.1.** The PRD sketches a container image; this guide deploys the
> same artifact as **native processes on one VPS**. The `ROLE = api | worker | all` switch, the
> migrations-as-pre-deploy rule, the blue/green standby (A-4) and the reverse-proxy requirements
> (§24.3) are all preserved. Nothing here changes the application contract.
>
> The repository is currently **docs-only**. Phase 0 creates the code. Treat every command below as
> the target convention; add the `package.json` scripts as you scaffold.

---

## 0. How to use this document

- **Part A** is the build order. Do the phases in sequence; each has tasks, deliverables and **exit criteria**. Do not start the next phase until the current exit criteria are green.
- **Part B** is the runbook for putting the app on a VPS and keeping it alive. It is written so it can be executed top-to-bottom on a fresh Ubuntu box.
- Every **P0** item in PRD §26.1 must be covered by the end of **Phase 5**. Phases 0–3 produce a usable text-chat backend; Phase 4 adds files; Phase 5/6 hardens and launches.

### Phase tracker

| Phase | Name | Est. | Exit gate | Done |
|---|---|---|---|---|
| 0 | Foundations (scaffold) | 1–1.5 wk | Auth + RBAC tests green; deploy to staging | [ ] |
| 1 | Registry & conversations | 1.5 wk | Create conversation, history loads, model lock enforced | [ ] |
| 2 | Generation core | 2 wk | Streaming E2E; kill -9 recovery; adapter contract tests green | [ ] |
| 3 | Quota & usage | 2 wk | Concurrency/property tests green; reconciliation clean | [ ] |
| 4 | Files & multimodal | 2 wk | Upload/attach/answer works; third adapter = zero core changes | [ ] |
| 5 | Admin, observability, hardening | 1.5–2 wk | §25 readiness checklist fully checked | [ ] |
| 6 | Pilot & launch | 2 wk | SLOs met 2 weeks; no P1 defects | [ ] |
| — | Post-MVP | — | P1 items, S3 migration, multi-node streaming, P2 | [ ] |

---

## 1. Locked decisions & conventions

Copied from `AGENTS.md` — these are not revisited during the build.

- **Runtime:** Bun.js LTS. **HTTP:** Hono (`streamSSE`). **Language:** TypeScript strict. **DB:** PostgreSQL 15+. **Query layer:** Drizzle + Zod at every boundary. **Cache:** Redis optional (never required for correctness or sign-in). **Tests:** Vitest + Testcontainers + `FakeProvider`.
- **No provider SDK import outside `src/providers/`** (lint-enforced).
- **No secret in code, DB, or logs.** Provider keys come from the environment/`.env`; `ai_providers.secret_ref` holds the **env var name**. `LOG_CONTENT=false`.
- **Repositories take an `AuthContext`**; cross-user access returns **404**. Admins/auditors are not exempt for content.
- **No `SELECT *`**; **no `OFFSET` pagination**; **streams hold no DB connection**.
- **UUIDv7** app-generated IDs; money in **integer micros**; all timestamps **`timestamptz` UTC**; quota periods are calendar months in `QUOTA_TIMEZONE` (default `Asia/Jakarta`).
- **Migrations are forward-only**, expand/contract, run as a **pre-deploy job under an advisory lock** — never on app boot.
- **Append-only** `quota_ledger` / `audit_logs` enforced by grants (`REVOKE UPDATE, DELETE`).

---

## 2. Target topology (single VPS, no Docker)

```
                    Internet (HTTPS 443)
                            │
                  ┌─────────▼──────────┐
                  │  Caddy or nginx    │  TLS, HTTP/2, SSE-friendly (no buffering)
                  │  (systemd unit)    │  client_max_body_size ~35M, read timeout >= 330s
                  └─────────┬──────────┘
                            │ 127.0.0.1:8080 (active)  /  :8081 (standby during deploy)
        ┌───────────────────┼───────────────────────────┐
        ▼                   ▼                           ▼
  ai-chat@blue        ai-chat@green               ai-chat-worker (optional)
  ROLE=all            ROLE=all                    ROLE=worker
  (systemd)           (systemd)                   (systemd)
        └──────────────┬───────────┘                       │
                       ▼                                   │
              PostgreSQL 15+ (localhost:5432, not exposed) ◄┘
                       │
              /var/lib/ai-chat/files   (local disk, temporary, NOT backed up — D-7)
```

- **One active node** (A-4). The second `systemd` instance exists only for zero-downtime deploys and is idle otherwise.
- **Worker** runs the `jobs` poller + scheduler (advisory-locked). On the smallest box, `ROLE=all` covers both; a separate worker is optional.
- Redis is **not installed** by default. If you add it later (rate limits), keep it optional so its absence never breaks sign-in.
- PostgreSQL is bound to `localhost` only; the app connects over loopback or a Unix socket.

---

# Part A — Build phases

> Each phase lists: **Objective → Tasks → Deliverables → Exit criteria → Commands**.
> Requirement IDs refer to the PRD.

## Phase 0 — Foundations (scaffold)

**Objective.** A runnable Hono service with config validation, a real PostgreSQL schema baseline, email/password auth, RBAC, audit writing, and the deploy skeleton. No AI calls yet.

**Tasks**
- [x] `package.json` (Bun), `tsconfig.json` (strict), ESLint + Prettier, Vitest config, `.env.example`, `.gitignore`, `.editorconfig`. ✅ M0.1
- [x] Repo layout exactly as `AGENTS.md` §3.7 (`src/config/`, `src/db/`, `src/http/`, `src/observability/`, `src/clock/`, feature modules such as `src/auth/`, `src/providers/`, glue `src/orchestrator/`; `src/app.ts`, `src/server.ts`, `migrations/`). ✅ M0.1
- [x] **Config:** Zod schema for the full env (§24.2 + Appendix A). **Fail fast** at boot on missing/invalid config. ✅ M0.1
- [x] Lint gates: ESLint (provider-import ban) + `dependency-cruiser` (AGENTS.md §3.2 inward rule) + Prettier. ✅ M0.1
- [x] Hono app: request-id middleware, JSON logging (pino) with redaction, `/healthz`, `/readyz`, `/metrics` (**raw, not enveloped**). ✅ M0.1
- [x] **Wire contract (v1.3):** unversioned `/api` prefix + shared envelope helpers (`{status,message,data}` / `{status,code,message,retryable,details,trace?}`, `trace` only when `NODE_ENV=development`), per `docs/API_CONTRACTS.md` §1. No route hand-rolls JSON; 2xx never returns `204`. ✅ M0.1/M0.0
- [x] DB layer: pool, Drizzle client, migration runner (forward-only, `pg_advisory_lock`), `db/seed` for the example registry (**never auto-applied in prod**). ✅ M0.2/M0.6 (`seed-example` guarded; populates once Phase 1 registry tables exist)
- [x] **Migrations baseline:** `users`, `sessions`, `divisions`, `audit_logs`, `system_settings`, `jobs` (+ `citext` extension). Apply the AGENTS.md §6 grammar from day one (UUIDv7, `text`+`CHECK`, partial indexes). ✅ M0.2
- [x] **Auth (FR-AUTH-1…9):** argon2id (`Bun.password`), `POST /auth/login`, opaque `__Host-session` cookie, sessions in PostgreSQL (idle 8 h / absolute 24 h), rotation on login, lockout (8 / 15 min), per-IP login limit, generic errors. ✅ M0.3/M0.4/M0.5 (per-IP limit via `rateLimitLogin`)
- [x] **RBAC** middleware (`user | admin | auditor`); `must_change_password` gate (403 `password_change_required`) allowing only `GET /me`, `POST /me/password`, `DELETE /auth/session`. ✅ M0.4/M0.5
- [x] Admin user provisioning + password reset; `bootstrap-admin` CLI; last-admin protection. ✅ M0.5
- [x] **Audit writer** (same transaction as the mutation); append-only grants prepared. ✅ M0.3 (grants in migrations)
- [x] `FakeProvider` + provider registry interfaces (no adapter yet). ✅ M0.6
- [ ] CI: lint (incl. provider-import rule), typecheck, unit + integration (Testcontainers), dependency audit, migration dry-run. — *deferred by decision (no workflow files yet)*
- [ ] Staging deploy using **Part B** (first pass — can be `ROLE=all`, single instance).

**Deliverables.** Sign-in/out, forced password change, admin user CRUD, RBAC, audit rows, health endpoints, CI green, staging reachable over HTTPS.

**Exit criteria.** Auth + RBAC tests green (lockout, rotation, revocation, IDOR); deploy to staging reproducible from a clean checkout.

**Commands**
```bash
bun install
bun run db:migrate
bun run cli bootstrap-admin --email you@corp.example
bun run cli seed-example   # optional dev examples; refuses in production
bun run typecheck && bun run lint && bun run test
bun run dev
```

## Phase 1 — Registry & conversations

**Objective.** Admin-managed provider/model registry and the conversation/message/part persistence model.

**Tasks**
- [ ] Migrations: `ai_providers`, `ai_models`, `ai_model_prices`, `conversations`, `messages`, `message_parts`, `quota_policies`, `quota_accounts`, `quota_reservations`, `quota_ledger`, `usage_events`, `usage_daily`, `idempotency_keys` (schema may land here; quota **logic** is Phase 3).
- [ ] `forbid_model_switch` trigger (model immutable once `message_count > 0`).
- [ ] Registry cache (≤30 s invalidation via `config_version`) + capability-driven validation.
- [ ] Admin APIs: providers (`secretRef` = env var name only), models, pricing, health/test stubs.
- [ ] Conversations: create/list (keyset)/get/rename/soft-delete; `GET /models` filtered by status/permission.
- [ ] Messages: `GET /conversations/:id/messages` (cursor by `seq`), part loading (`ORDER BY message_id, position`).
- [ ] Context builder (text-only) with a truncation strategy hook.
- [ ] `system_settings` reader/writer (system prompt, limits, `quota.timezone`).

**Deliverables.** Admin can register OpenAI + Anthropic + models; a user can create a conversation and load (empty) history; model lock enforced in the DB.

**Exit criteria.** Integration tests: create conversation with model, model immutability, keyset pagination, IDOR on every ID route.

## Phase 2 — Generation core

**Objective.** Real streaming generation through the provider abstraction, crash-safe and replayable.

**Tasks**
- [ ] `generation_jobs` migration (state machine + partial unique "one active per conversation").
- [ ] Orchestrator/runner + `idempotency_keys` transactional send (T1/T4 in `AGENTS.md` §6.12).
- [ ] **Two adapters:** OpenAI + Anthropic (normalized events); `FakeProvider` fault injection.
- [ ] SSE endpoint `GET /generations/:id/stream` with `Last-Event-ID` replay, heartbeats, `snapshot` fallback.
- [ ] Checkpointer (1 s / 2 KB) appending to `message_parts.text_content`; `heartbeat_at` bump.
- [ ] Finalizer (T2/T3): settle/release, `messages` terminal state, SSE terminal event; idempotent.
- [ ] Cancel; reaper (stale heartbeat > 45 s → `failed(interrupted)`); provider error translation (no detail leaks).
- [ ] Idempotent retry endpoint; graceful shutdown drain (SIGTERM, §24.6).
- [ ] Adapter **contract suite** + streaming/failure tests; kill -9 recovery test.

**Deliverables.** End-to-end streamed chat with cancel, reconnect, retry, and crash recovery.

**Exit criteria.** Streaming works E2E against `FakeProvider` and a live smoke test; kill -9 mid-stream is recovered by the reaper with partial text persisted.

## Phase 3 — Quota & usage

**Objective.** Correct reservation/settlement accounting under concurrency.

**Tasks**
- [ ] Policy resolution (`user → division → global`, per field) + lazy period creation.
- [ ] Reservation via conditional `UPDATE` (T1); settle/release via `SELECT … FOR UPDATE` (T2); ledger rows (signed) for every movement.
- [ ] Reservation reaper, quota reaper integration, estimation + margins, overshoot handling.
- [ ] `GET /me/quota`, `GET /me/usage`; admin quota APIs (`quota-policies`, `adjustments`, user quota + ledger).
- [ ] `usage_events` written once per settled generation; `usage_daily` rollup handler + nightly rebuild.
- [ ] Nightly reconciliation (counters vs ledger) + a `reconcile` job.
- [ ] **Concurrency/property tests** (real PostgreSQL): the 100,000-limit / 50×20,000 test → exactly 5 succeed.

**Deliverables.** Enforced per-user monthly quota (default 500,000 tokens), accurate usage reporting, auditable ledger.

**Exit criteria.** Concurrency + property tests green; `used + reserved <= limit` holds at every sampled instant; daily reconciliation runs (must stay clean for 14 days across Phases 3–5).

## Phase 4 — Files & multimodal

**Objective.** Upload, validate, extract, attach, and serve binary artifacts; prove the abstraction with a third adapter.

**Tasks**
- [ ] `attachments` + `file_extractions` migrations; `StorageProvider` interface + `LocalStorageProvider` (`STORAGE_LOCAL_ROOT`, opaque keys only — no paths stored/returned).
- [ ] Upload pipeline: size/type limits, magic-byte detection, image dimension/probe, archive-bomb + macro + encrypted-PDF rejection, `sha256`.
- [ ] Async extraction job (forked child: timeout + memory limit); 5 s fast-path; `RETAIN_EXTRACTIONS`.
- [ ] Attach flow inside the send transaction; `ArtifactSink` for `generated_file` parts (tested with `FakeProvider`).
- [ ] `GET /files/:id/content` (owner-only, correct headers, `Range`); `GET`/`DELETE /attachments/:id`.
- [ ] Cleanup jobs: `files.expire_and_delete` (two-phase), `files.orphan_reaper`, `storage.reconcile` weekly.
- [ ] **Third adapter: Gemini** (must require zero core changes to `orchestrator/`).

**Deliverables.** Image + document upload → attach → grounded answer; generated files stored and downloadable; TTL cleanup working.

**Exit criteria.** Upload-hardening tests pass; third adapter added with **zero** core changes; disk-space alerts set.

## Phase 5 — Admin, observability, hardening

**Objective.** Meet the production readiness checklist (PRD §25).

**Tasks**
- [ ] Admin reporting APIs: usage (`groupBy`), error explorer (`error_events`), audit log search; CSV exports (P1).
- [ ] Metrics (low cardinality), dashboards, alert rules (§21.5); OTLP tracing hook (sample errors 100 %, success 10 %).
- [ ] Rate limiting (per-IP/login/user/message/upload) with `RateLimit-*` headers; security headers + CORS + CSRF/Origin.
- [ ] Retention jobs (messages, files, ledger, audit, logs); session/idempotency purge.
- [ ] Load test (150 concurrent streams / 30 min) + 24 h soak; `EXPLAIN` review of top queries; autovacuum tuning.
- [ ] Runbooks: DB restore, secret rotation, provider outage, disk full, reconciliation mismatch; DR drill (RTO ≤ 1 h, RPO ≤ 5 min).
- [ ] Dependency/vulnerability scan; pen-test fixes; log-redaction verification.

**Deliverables.** All monitoring, alerting, retention, and hardening in place; runbooks written.

**Exit criteria.** PRD §25 checklist **fully checked**; SLOs measured under load.

## Phase 6 — Pilot & launch

**Objective.** Go live with one division, then all users.

**Tasks**
- [ ] Pilot one division; calibrate estimation margins and limits; tune provider concurrency.
- [ ] Daily quota reconciliation + backup-restore drill on staging.
- [ ] Incident/comms plan; on-call rota; support intake.
- [ ] Final security sign-off; provider contracts confirmed (Q-3).

**Exit criteria.** SLOs met for 2 weeks; no P1 defects; successful restore drill.

## Post-MVP

P1 items first (division-scoped model visibility, circuit breaker, error explorer, RLS hardening, AV scanning, fork, exports), then P2 (§26.3). Enable each by **adding modules behind existing interfaces** — no new tables/queues/services in the MVP.

---

# Part B — VPS deployment guide (no Docker)

**Assumed platform:** Ubuntu 24.04 LTS, systemd, `amd64`. Adapt package names for Debian/RHEL. All commands assume `sudo`.

**Naming used below**

| Thing | Value |
|---|---|
| Service user | `aichat` (no login shell) |
| App root | `/srv/ai-chat` with `releases/<ts>` + `current` symlink |
| Env file | `/etc/ai-chat/ai-chat.env` (root, `0600`) |
| Migration env | `/etc/ai-chat/migrate.env` (root, `0600`) |
| File storage | `/var/lib/ai-chat/files` |
| DB | `aichat` on `localhost:5432`, roles `aichat_app` / `aichat_migrator` |
| Backups | `/var/backups/ai-chat` |
| Internal port | `8080` (blue) / `8081` (green) |

## B0 — Provision the VPS & baseline

- [ ] Create a non-root sudo user; disable password SSH, **keys only**; `PermitRootLogin no`.
- [ ] `sudo apt update && sudo apt -y upgrade`; enable `unattended-upgrades`.
- [ ] Set hostname/timezone; **keep the OS clock on UTC** (the app stores UTC; quota months are computed in `QUOTA_TIMEZONE` in code, not from the system zone).
- [ ] Firewall (see B12). Do this before exposing anything.
- [ ] Create the service user and directories:
```bash
sudo useradd --system --home /srv/ai-chat --shell /usr/sbin/nologin aichat
sudo mkdir -p /srv/ai-chat/releases /etc/ai-chat /var/lib/ai-chat/files /var/backups/ai-chat
sudo chown -R aichat:aichat /srv/ai-chat /var/lib/ai-chat
sudo chmod 750 /etc/ai-chat
```

## B1 — Install the runtime & services

```bash
# Bun (current user) — then expose system-wide for the service
curl -fsSL https://bun.sh/install | bash
sudo ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
bun --version

# PostgreSQL 15+ (Ubuntu 24.04 ships 16; fine)
sudo apt -y install postgresql postgresql-contrib

# Reverse proxy — pick ONE
#   A) Caddy (automatic TLS, simplest)
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy
#   B) nginx + certbot
# sudo apt -y install nginx certbot python3-certbot-nginx
```

> **Runtime fallback.** If a dependency proves incompatible with Bun, build to plain JS and run under
> Node 22 LTS (`bun build ./src/server.ts --target node --outdir dist` + `node dist/server.js`).
> The layout, env, systemd units and proxy config below are unchanged — only `ExecStart` differs.

## B2 — PostgreSQL setup

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE aichat_migrator LOGIN PASSWORD 'CHANGE_ME_migrator';      -- owns DDL
CREATE ROLE aichat_app      LOGIN PASSWORD 'CHANGE_ME_app';           -- runs the service
CREATE DATABASE aichat OWNER aichat_migrator ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
SQL

# Extensions require superuser; run against the new DB:
sudo -u postgres psql -d aichat -c 'CREATE EXTENSION IF NOT EXISTS citext;'
# Optional (only if admin substring search is added):
# sudo -u postgres psql -d aichat -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
```

Apply the **grants** from `AGENTS.md` §6.11 (after the baseline migration creates the tables):

```sql
-- mutable tables: full DML for the app
GRANT SELECT, INSERT, UPDATE, DELETE ON <mutable tables...> TO aichat_app;
-- append-only: no UPDATE/DELETE
GRANT SELECT, INSERT ON quota_ledger, audit_logs TO aichat_app;
REVOKE UPDATE, DELETE ON quota_ledger, audit_logs FROM aichat_app;
-- sequence usage (bigint identity columns)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO aichat_app;
ALTER DEFAULT PRIVILEGES FOR ROLE aichat_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO aichat_app;
```

> Review the auto-grant default privileges against the append-only rule — `audit_logs`/`quota_ledger`
> must be **explicitly exempted** (do not blanket-grant them `UPDATE/DELETE`).

- [ ] Bind to localhost only (default). Confirm `listen_addresses = 'localhost'` and no `0.0.0.0/0` in `pg_hba.conf`.
- [ ] Tune for the box: `shared_buffers` ~25 % RAM, `effective_cache_size` ~50–75 %, `work_mem` modest, `max_connections` ≥ `DB_POOL_MAX` × nodes + headroom. Enable `log_min_duration_statement` for slow queries.
- [ ] Set `ALTER ROLE aichat_app SET statement_timeout = '30s';` (long jobs use the worker with its own override).

## B3 — Filesystem layout

```
/srv/ai-chat/
├── releases/
│   └── 20261008T120000/        # one immutable release (git archive / rsync / tarball)
├── current -> releases/20261008T120000
/var/lib/ai-chat/files/         # STORAGE_LOCAL_ROOT (persistent, NOT backed up — D-7)
/etc/ai-chat/ai-chat.env        # 0600 root
/etc/ai-chat/migrate.env        # 0600 root
```

- `/var/lib/ai-chat/files` must be on a **large, monitored** volume; alert at ≥ 80 % full.
- Never place storage under `/srv/ai-chat/releases` — releases are replaced on deploy.

## B4 — Environment & secrets

Create `/etc/ai-chat/ai-chat.env` (root, `0600`). Systemd reads it as root before dropping privileges, so `root:root 0600` is correct.

```bash
sudo tee /etc/ai-chat/ai-chat.env >/dev/null <<'ENV'
NODE_ENV=production
ROLE=all
PORT=8080
DATABASE_URL=postgres://aichat_app:CHANGE_ME_app@127.0.0.1:5432/aichat
DB_POOL_MAX=20
STORAGE_LOCAL_ROOT=/var/lib/ai-chat/files
STORAGE_WRITE_PROVIDER=local
QUOTA_TIMEZONE=Asia/Jakarta
SESSION_SECRET=CHANGE_ME_32_bytes_min_or_longer
ALLOWED_ORIGINS=https://ai.corp.example
MAX_ACTIVE_GENERATIONS=150
SHUTDOWN_DRAIN_SECONDS=120
LOG_LEVEL=info
LOG_CONTENT=false
RETAIN_EXTRACTIONS=true
PASSWORD_MIN_LENGTH=12
LOGIN_MAX_FAILURES=8
LOGIN_LOCKOUT_MINUTES=15
# Provider keys (referenced by ai_providers.secret_ref; never stored in the DB)
OPENAI_API_KEY=CHANGE_ME
ANTHROPIC_API_KEY=CHANGE_ME
# GEMINI_API_KEY=CHANGE_ME        # Phase 4
# OTEL_EXPORTER_OTLP_ENDPOINT=    # optional
ENV
sudo chmod 600 /etc/ai-chat/ai-chat.env

# Migrator env (deploy only; never read by the app)
sudo tee /etc/ai-chat/migrate.env >/dev/null <<'ENV'
MIGRATION_DATABASE_URL=postgres://aichat_migrator:CHANGE_ME_migrator@127.0.0.1:5432/aichat
ENV
sudo chmod 600 /etc/ai-chat/migrate.env
```

- [ ] `.env` is **never** in the repo; CI secret scanning enabled; `/etc/ai-chat` is `750`.
- [ ] Provider keys are the only place secrets live — no secret manager (A-16).

## B5 — Release artifact

A release is a self-contained snapshot of the code at a git tag/commit:

```bash
RELEASE=/srv/ai-chat/releases/$(date -u +%Y%m%dT%H%M%S)
sudo -u aichat mkdir -p "$RELEASE"
# from CI or the dev machine:
git archive --format=tar.gz <tag> | sudo -u aichat tar -xz -C "$RELEASE"
# or: rsync -a --delete ./ "$RELEASE"/   (exclude node_modules, .git, .env)

cd "$RELEASE"
sudo -u aichat bun install --frozen-lockfile --production
# Optional bundle for a smaller/faster start (Bun target; see runtime fallback for Node):
sudo -u aichat bun run build          # -> dist/server.js  (add this script)
```

Add these scripts to `package.json` during Phase 0: `build`, `start` (`bun run src/server.ts`
or `bun dist/server.js`), and keep `db:migrate`.

## B6 — systemd services

Install `/etc/systemd/system/ai-chat@.service` (template; `%i` = `blue`/`green`):

```ini
[Unit]
Description=AI Chat API (%i)
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=exec
User=aichat
Group=aichat
WorkingDirectory=/srv/ai-chat/current
EnvironmentFile=/etc/ai-chat/ai-chat.env
Environment=ROLE=all
Environment=PORT=8080
ExecStartPre=/usr/local/bin/bun run db:migrate:check
ExecStart=/usr/local/bin/bun run start
Restart=always
RestartSec=3
TimeoutStopSec=150
KillSignal=SIGTERM
# Hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/ai-chat/files
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
```

- `Environment=PORT=8080` / `8081` per instance (blue on 8080, green on 8081). For green, override with a drop-in (`/etc/systemd/system/ai-chat@green.service.d/port.conf`).
- `ROLE=all` for the smallest box. A separate worker unit uses `Environment=ROLE=worker` and the same env file.
- `TimeoutStopSec=150` > `SHUTDOWN_DRAIN_SECONDS=120` (PRD §24.6) so drain completes before SIGKILL.
- `ExecStartPre` may run a **migration check** (advisory lock, no-op if current); real migrations run in the deploy step (B8).

Enable:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-chat@blue
sudo systemctl status ai-chat@blue
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8080/readyz
```

**Worker (optional on one box):** duplicate the unit as `ai-chat-worker.service` with `ROLE=worker`, no `PORT` requirement.

## B7 — Reverse proxy, TLS & SSE

TLS is **mandatory**: the session cookie uses the `__Host-` prefix (Secure, Path=/, no Domain).

**Caddy** (`/etc/caddy/Caddyfile`):
```caddyfile
ai.corp.example {
    encode zstd gzip
    request_body {
        max_size 35MB
    }
    reverse_proxy 127.0.0.1:8080 {
        flush_interval -1          # stream SSE without buffering
        transport http {
            read_timeout 330s
            write_timeout 0
        }
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
    }
}
```
```bash
sudo systemctl reload caddy
```

**nginx** (alternative, `/etc/nginx/sites-available/ai-chat`):
```nginx
upstream ai_chat_backend {
    server 127.0.0.1:8080;          # switch to :8081 for green during a deploy
    keepalive 32;
}
server {
    listen 443 ssl http2;
    server_name ai.corp.example;
    ssl_certificate     /etc/letsencrypt/live/ai.corp.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ai.corp.example/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 35m;        # attachments (~30MB + overhead)

    location / {
        proxy_pass http://ai_chat_backend;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_read_timeout 330s;
        proxy_send_timeout 330s;
        proxy_buffering off;             # required for SSE
        proxy_cache off;
        chunked_transfer_encoding on;
    }
}
server { listen 80; server_name ai.corp.example; return 301 https://$host$request_uri; }
```
```bash
sudo certbot --nginx -d ai.corp.example    # or use Caddy's automatic TLS
sudo nginx -t && sudo systemctl reload nginx
```

**Requirement checks (§24.3):** no buffering on `/api/generations/*/stream`, read timeout ≥ 330 s, `client_max_body_size` ≈ 35 MB, forward `X-Request-Id` + real client IP from a **trusted** proxy list, HTTP/2 on.

## B8 — Migrations as a pre-deploy job

Never migrate on app boot. Run once, under an advisory lock, as `aichat_migrator`:

```bash
sudo -u aichat env $(grep -v '^#' /etc/ai-chat/migrate.env | xargs) \
  sh -c 'cd /srv/ai-chat/current && bun run db:migrate'
```

- Forward-only, expand/contract; **N-1 code runs on N schema** so rollback stays possible.
- Destructive steps land only one full release later.
- `db:migrate:check` (used in `ExecStartPre`) only verifies the schema version — no writes.

## B9 — Deploy procedure & rollback

### Simple deploy (short restart; acceptable for MVP)
```bash
set -euo pipefail
RELEASE=/srv/ai-chat/releases/$(date -u +%Y%m%dT%H%M%S)
sudo -u aichat mkdir -p "$RELEASE"
git archive --format=tar.gz <tag> | sudo -u aichat tar -xz -C "$RELEASE"
sudo -u aichat sh -c "cd '$RELEASE' && bun install --frozen-lockfile --production"
# 1) migrate (pre-deploy, migrator role)
sudo -u aichat env $(grep -v '^#' /etc/ai-chat/migrate.env | xargs) sh -c "cd '$RELEASE' && bun run db:migrate"
# 2) switch symlink + restart (SIGTERM drains up to 120s)
sudo -u aichat ln -sfn "$RELEASE" /srv/ai-chat/current
sudo systemctl restart ai-chat@blue
# 3) verify
curl -fsS https://ai.corp.example/readyz
```
Downtime is ~1 s (new connections only); in-flight streams drain via SIGTERM.

### Zero-downtime deploy (blue/green, recommended)
1. Start the idle instance on the new release:
   ```bash
   sudo -u aichat ln -sfn "$RELEASE" /srv/ai-chat/current
   sudo systemctl restart ai-chat@green      # PORT=8081
   curl -fsS http://127.0.0.1:8081/readyz
   ```
2. Flip the proxy to `:8081` (nginx `upstream` → `server 127.0.0.1:8081;` then `nginx -t && systemctl reload nginx`; Caddy: update `reverse_proxy` and `reload`).
3. Drain + stop the old instance: `sudo systemctl stop ai-chat@blue`.
4. Next deploy swaps roles (green → blue). Keep the pattern alternating.

### Rollback
```bash
# point back to the previous release and restart
sudo -u aichat ln -sfn /srv/ai-chat/releases/<previous-ts> /srv/ai-chat/current
sudo systemctl restart ai-chat@blue        # or flip the proxy back
```
Because migrations are backward-compatible, N-1 code runs on N schema. Rehearse this in staging (§25).

## B10 — Backups & restore

Per D-7 the **file volume is intentionally not backed up** (it is temporary; after a restore, missing
blobs are marked `missing` and the UI shows "unavailable"). Back up the **database**.

```bash
# /etc/cron.d/ai-chat-backup  (or a systemd timer)
0 2 * * *  postgres  pg_dump -Fc -d aichat -f /var/backups/ai-chat/aichat-$(date +\%F).dump
30 2 * * * postgres  find /var/backups/ai-chat -name 'aichat-*.dump' -mtime +14 -delete
```

- [ ] Nightly `pg_dump -Fc`; retain 14 daily + weekly/monthly as policy allows.
- [ ] Ship dumps **offsite** (e.g. `rclone copy` to object storage) — same-host backups are not DR.
- [ ] For RPO ≤ 5 min, enable **WAL archiving / PITR** (archive_command to a local volume + offsite).
- [ ] **Restore drill** (quarterly, and before launch):
  ```bash
  createdb -T template0 aichat_restore
  pg_restore -d aichat_restore /var/backups/ai-chat/aichat-YYYY-MM-DD.dump
  # point a staging instance at aichat_restore and verify /readyz + a login
  ```
- [ ] Verify append-only grants survive restore (they are part of the schema/migration).

## B11 — Observability & logging

- [ ] `journalctl -u ai-chat@blue -f` for live logs; set `LOG_LEVEL=info`, `LOG_CONTENT=false`.
- [ ] **logrotate** (or journald caps) so JSON logs cannot fill the disk:
  ```
  /etc/logrotate.d/ai-chat  →  rotate 14, daily, compress, copytruncate
  ```
- [ ] Scrape `/metrics` from a network-restricted source; dashboards for p50/95/99 latency, TTFT, errors by category, tokens, active generations, quota rejections.
- [ ] Health probes: external uptime monitor on `https://ai.corp.example/healthz` (liveness) and `/readyz` (readiness). **Provider health is not readiness** (§21.6).
- [ ] Alerts (§21.5): generation failure rate, provider 401/403, reservations past expiry, reconciliation mismatch, disk < 20 %, DB pool > 80 %, readiness flapping.

## B12 — Security hardening

- [ ] **ufw:** `sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable`. PostgreSQL (5432) stays **closed** to the internet.
- [ ] `fail2ban` on sshd (and optionally on auth failures via proxy logs).
- [ ] SSH: keys only, no root, non-standard port optional, `AllowUsers`.
- [ ] `unattended-upgrades` for OS packages; plan PostgreSQL minor upgrades.
- [ ] OS-level: dedicated `aichat` user, `.env` `0600`, `/etc/ai-chat` `750`, secrets not in shell history (use env files, not inline exports).
- [ ] Container/static scans N/A (no Docker) — use `bun audit` / `npm audit` in CI and a filesystem scanner if required.
- [ ] Egress allow-list for provider APIs where the network supports it; set provider-console **spend caps**.
- [ ] Verify TLS, HSTS, security headers, and that responses never leak provider detail or stack traces.

## B13 — Provider-key rotation runbook (A-16)

1. Add the new key at the provider console; note spend caps.
2. Update `/etc/ai-chat/ai-chat.env` (`OPENAI_API_KEY=…`).
3. Rolling restart with the standby: start the idle instance, flip the proxy, drain the other (B9), or `sudo systemctl restart ai-chat@blue` for a ≤1 s blip.
4. Verify: `GET /admin/providers/health` is healthy and a smoke generation succeeds.
5. Revoke the old key at the provider.
6. Confirm no key material appears in logs or responses; audit shows a `secret_ref` change (reference only).

## B14 — Operations runbook

| Task / incident | Action |
|---|---|
| App won't start | `journalctl -u ai-chat@blue -n 200`; likely config validation (fail-fast) or DB outage |
| `/readyz` fails | Check PostgreSQL reachable, migrations current, storage writable + free space |
| Provider outage | Not fatal to readiness; circuit opens; users get `provider_unavailable`/`provider_rate_limited`; watch alerts |
| Streams stall / proxy buffering | Confirm `proxy_buffering off` / Caddy `flush_interval -1`; read timeout ≥ 330 s |
| Disk filling | `files.expire_and_delete` + `files.orphan_reaper` running? Check `/var/lib/ai-chat/files` and logs; alert < 20 % |
| Stuck `streaming` generations | `generation.reaper` (30 s) should mark `failed(interrupted)`; check heartbeats/worker |
| Quota discrepancy | Run `quota.reconcile`; inspect `quota_ledger` (source of truth); never edit counters directly |
| Deploy broke something | Roll back the symlink (B9); verify N-1 on N schema |
| Certificate renewal | Caddy automatic; nginx `certbot renew` timer — verify |
| Job queue backing up | Check worker running; queue depth alert; jobs are idempotent so they can be retried |

## B15 — Go-live checklist

- [ ] PRD §25 checklist fully checked.
- [ ] `bootstrap-admin` executed on the production DB; first login forces a password change.
- [ ] Provider registry populated; keys valid; health check green; spend caps set.
- [ ] Backups running + **restore drill passed**; offsite copy verified.
- [ ] Alerts wired to on-call; runbooks available (B14).
- [ ] Graceful shutdown verified under load; rollback rehearsed.
- [ ] SSE verified end-to-end through the proxy (no buffering, reconnect + replay work).
- [ ] Firewall + TLS + headers verified from outside the network.
- [ ] Retention jobs scheduled; reconciliation clean for 14 days.

---

## Appendix A — Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | yes | `development` | `production` in prod |
| `ROLE` | yes | `all` | `api \| worker \| all` |
| `PORT` | api/all | `8080` | internal; proxy terminates TLS |
| `DATABASE_URL` | yes | — | app role |
| `MIGRATION_DATABASE_URL` | deploy only | — | migrator role; never read by the app |
| `DB_POOL_MAX` | yes | `20` | per node |
| `REDIS_URL` | no | — | optional; never required for correctness |
| `STORAGE_LOCAL_ROOT` | yes | — | e.g. `/var/lib/ai-chat/files` |
| `STORAGE_WRITE_PROVIDER` | yes | `local` | |
| `QUOTA_TIMEZONE` | yes | `Asia/Jakarta` | IANA name (A-5) |
| `SESSION_SECRET` | recommended | — | ≥32 bytes; CSRF token signing (PRD marks it optional; set it in prod) |
| `ALLOWED_ORIGINS` | yes | — | CSV of SPA origins |
| `MAX_ACTIVE_GENERATIONS` | yes | `150` | per node capacity |
| `SHUTDOWN_DRAIN_SECONDS` | no | `120` | < `TimeoutStopSec` |
| `LOG_LEVEL` | no | `info` | |
| `LOG_CONTENT` | yes | `false` | **must stay false** in prod |
| `RETAIN_EXTRACTIONS` | no | `true` | A-14 |
| `PASSWORD_MIN_LENGTH` | no | `12` | |
| `LOGIN_MAX_FAILURES` | no | `8` | |
| `LOGIN_LOCKOUT_MINUTES` | no | `15` | |
| `SESSION_IDLE_HOURS` | no | `8` | |
| `SESSION_ABSOLUTE_HOURS` | no | `24` | |
| `OPENAI_API_KEY` | per provider | — | referenced by `secret_ref` |
| `ANTHROPIC_API_KEY` | per provider | — | |
| `GEMINI_API_KEY` | Phase 4 | — | |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no | — | tracing |

## Appendix B — systemd unit (worker)

```ini
[Unit]
Description=AI Chat worker
After=network-online.target postgresql.service
Wants=network-online.target
Requires=postgresql.service

[Service]
Type=exec
User=aichat
Group=aichat
WorkingDirectory=/srv/ai-chat/current
EnvironmentFile=/etc/ai-chat/ai-chat.env
Environment=ROLE=worker
ExecStart=/usr/local/bin/bun run start
Restart=always
RestartSec=5
TimeoutStopSec=180
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/ai-chat/files

[Install]
WantedBy=multi-user.target
```

## Appendix C — First-run sequence (fresh VPS recap)

```bash
# 1) baseline + service user + dirs            (B0)
# 2) install Bun, PostgreSQL, proxy             (B1)
# 3) create roles/db/extensions/grants          (B2)
# 4) write /etc/ai-chat/*.env (0600)            (B4)
# 5) deploy first release, install deps         (B5)
# 6) migrate as migrator                        (B8)
# 7) enable + start systemd units               (B6)
# 8) configure proxy + TLS                      (B7)
# 9) bootstrap admin                            (Phase 0)
sudo -u aichat sh -c 'set -a; . /etc/ai-chat/ai-chat.env; set +a; cd /srv/ai-chat/current && bun run cli bootstrap-admin --email you@corp.example'
# 10) verify health + login + a smoke generation
curl -fsS https://ai.corp.example/readyz
```

## Appendix D — Deployment checklist (per release)

- [ ] CI green: lint (provider-import rule) · typecheck · unit/integration/contract/quota tests · dependency audit · migration dry-run on a prod-like snapshot.
- [ ] Backup completed **before** migrating (`pg_dump`).
- [ ] Migration applied once, as migrator, advisory-locked; N-1 compatibility confirmed.
- [ ] New release installed + `bun install --frozen-lockfile --production`.
- [ ] Roll out (simple restart or blue/green), verify `/readyz` and a live smoke generation.
- [ ] Proxy still unbuffered for SSE; body size/timeouts unchanged.
- [ ] Watch errors/latency for 15 min; keep the previous release for one-step rollback.

---

*End of document.*
