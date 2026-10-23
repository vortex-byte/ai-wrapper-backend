# AI Wrapper API

Enterprise multi-provider AI Wrapper backend service built with Bun, Hono, and PostgreSQL.

## Overview

AI Wrapper API provides a secure, unified backend for conversational AI applications within enterprise environments. It decouples client applications from upstream model providers, preventing direct browser access to third-party endpoints and centralizing credential management, usage tracking, per-user token quotas, attachment validation, and streaming delivery.

The system is designed as a feature-first modular monolith with hexagonal boundaries separating three core concerns:
- Conversation persistence: Threads, messages, parts, and lifecycle history.
- Provider execution: The Provider Abstraction Layer (PAL) and streaming orchestrator.
- Binary artifact storage: Local file persistence and generated artifact hydration.

## Features

### Multi-Provider Architecture
- Unified Provider Abstraction Layer (PAL) normalizing requests and responses across OpenAI, Anthropic, and Google Gemini.
- Dynamic model and provider registry stored in PostgreSQL, allowing runtime configuration adjustments without application redeployment.
- Secure secret management referencing environment variable names instead of persisting raw API credentials in database tables.

### Streaming and Real-Time Orchestration
- Server-Sent Events (SSE) streaming for generation responses.
- In-memory ring buffer for message replay, allowing dropped connections to resume without repeating inference.
- Multi-subscriber fan-out with backpressure management.
- Checkpointing mechanism that periodically persists partial streaming content to PostgreSQL while keeping long-lived streams free of open database connections.

### Quota and Accounting
- Hierarchical quota policies resolved across user, division, and global scopes.
- Atomic token reservation executed within a single transaction to prevent quota oversubscription under concurrent workloads.
- Idempotent finalization settling actual token consumption against reserved balances.
- Append-only quota ledger recording all balance changes for financial and compliance reconciliation.
- Disposable daily rollups for dashboard performance.

### Attachments and Binary Processing
- Content validation utilizing magic byte detection, file size verification, and dimension inspection.
- Path traversal protection and atomic file writing for local disk storage.
- Document text extraction supporting PDF, DOCX, XLSX, PPTX, and plain text formats.
- Sandboxed artifact hydration downloading provider-generated files and diagrams before exposing download references to clients.

### Security and Access Control
- Server-backed sessions utilizing secure, HTTP-only cookie tokens with SHA-256 server indexing.
- Password hashing utilizing Argon2id with automatic forced password resets on initial login.
- Stateless HMAC CSRF protection with strict origin validation for all mutation routes.
- Multi-tier role-based access control supporting user, admin, and super_admin privileges.
- Rate limiting covering IP, user, login, upload, and generation endpoints.
- Strict isolation preventing unauthorized access to conversations and files owned by other users.

### Operations and Reliability
- Single unified deployable supporting multiple operational roles: api, worker, and all.
- PostgreSQL-backed job queue utilizing SKIP LOCKED concurrency for asynchronous background tasks.
- Background worker executing soft-deleted conversation purges, attachment expiration, and daily rollups.
- Comprehensive JSON logging using Winston with daily log rotation and automatic retention pruning.
- Sanitized system error event recording avoiding exposure of sensitive message text, prompts, or provider responses.
- Idempotency key handling ensuring duplicate requests return cached results without re-executing generations.

## Prerequisites

Before deploying or running the application, ensure the following dependencies are installed:

- Bun runtime: Version 1.2.0 or higher.
- PostgreSQL: Version 15 or higher with the citext extension enabled.
- System tools: openssl (for secret key generation) and standard POSIX shell utilities.

## Configuration

Environment variables configure runtime behavior, database connections, security parameters, and provider secrets. Copy `.env.example` to `.env` to begin configuration:

```bash
cp .env.example .env
```

### Core Configuration Variables

| Variable | Description | Default |
| --- | --- | --- |
| `NODE_ENV` | Environment mode (`development`, `test`, `production`) | `development` |
| `ROLE` | Process operational role (`api`, `worker`, `all`) | `all` |
| `HOST` | Bind host interface | `127.0.0.1` |
| `PORT` | Listening HTTP port | `8080` |
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `TEST_DATABASE_URL` | PostgreSQL connection string for integration tests | Required for tests |
| `MIGRATION_DATABASE_URL` | Dedicated connection string for migrations (optional) | Unset |
| `SESSION_SECRET` | 32-character secret for sessions and CSRF signing | Required |
| `SESSION_COOKIE_NAME` | Name of the session cookie | `__Host-session` |
| `SESSION_IDLE_MINUTES` | Inactivity window before session invalidation | `480` |
| `SESSION_ABSOLUTE_MINUTES` | Maximum lifetime of a session | `1440` |
| `STORAGE_LOCAL_ROOT` | Directory for file uploads and hydrated artifacts | `./.var/files` |
| `STORAGE_MIN_FREE_MIB` | Minimum free disk space before rejecting uploads | `512` |
| `QUOTA_TIMEZONE` | Timezone identifier for quota period boundaries | `Asia/Jakarta` |
| `MAX_ACTIVE_GENERATIONS` | Maximum concurrent streaming generations per process | `2` |
| `ALLOWED_ORIGINS` | Comma-separated allowlist of allowed CORS origins | `""` |
| `LOG_LEVEL` | Log level (`debug`, `info`, `warn`, `error`) | `info` |
| `LOG_DIR` | Directory path for rotating log files | `./.var/logs` |

### Provider API Keys

Provider adapters resolve API keys dynamically from environment variable names configured in the database `ai_providers.secret_ref` column. Add the required provider keys to your environment:

```bash
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
GEMINI_API_KEY=your-gemini-key
```

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd ai-wrapper-api
   ```

2. Install dependencies using Bun:
   ```bash
   bun install
   ```

3. Ensure PostgreSQL is running and create the application databases:
   ```sql
   CREATE DATABASE aiwrapper;
   CREATE DATABASE aiwrapper_test;
   ```

4. Generate a secure session secret:
   ```bash
   openssl rand -hex 32
   ```
   Paste the generated value into the `SESSION_SECRET` variable in your `.env` file.

5. Apply database migrations:
   ```bash
   bun run db:migrate
   ```

6. Bootstrap the initial Super Administrator account:
   ```bash
   bun run cli bootstrap-admin --email admin@example.com --display-name "System Administrator"
   ```
   The command outputs a temporary password. The administrator must update this password upon initial login.

7. (Optional for local development) Seed example provider and model configurations:
   ```bash
   bun run db:seed:example
   ```
   This inserts demonstration records for OpenAI, Anthropic, and Gemini models. Do not run this script in production environments.

## Operational Guide

### Running the Application

To start the server in watch mode for development:
```bash
bun run dev
```

To run the server in production mode:
```bash
bun run start
```

### Process Roles

The application binary supports running in segregated roles using the `ROLE` environment variable:

- `ROLE=api`: Starts only the HTTP server and SSE streaming orchestrator. Background job pollers and schedulers remain inactive. Suitable for horizontally scaled web nodes.
- `ROLE=worker`: Starts only the PostgreSQL job queue processor and recurring schedulers. The HTTP server is not bound. Suitable for background worker instances.
- `ROLE=all`: Runs both HTTP endpoints and background job processing within a single unified process. Recommended for single-instance VPS deployments.

### Command Line Interface

The project includes an operational CLI for management tasks:

- Apply pending SQL migrations:
  ```bash
  bun run cli migrate
  ```
- Check migration status and detect checksum drift:
  ```bash
  bun run cli migrate:check
  ```
- Provision or update an administrator account:
  ```bash
  bun run cli bootstrap-admin --email <email> [--display-name <name>] [--password <password>] [--force]
  ```
- Seed development models:
  ```bash
  bun run cli seed-example
  ```
- Run a live streaming smoke test against a configured provider:
  ```bash
  bun run cli smoke-live --provider <provider_key>
  ```

### Code Quality and Verification

Run the full verification gate (TypeScript typechecking, ESLint, dependency boundaries, unit tests):
```bash
bun run verify
```

Run unit tests:
```bash
bun run test
```

Run integration tests against PostgreSQL:
```bash
bun run test:integration
```
Note: Integration tests require `TEST_DATABASE_URL` pointing to a PostgreSQL database whose name includes `test`.

Check dependency boundary rules:
```bash
bun run depcruise
```

## API Overview

The HTTP API is mounted under the unversioned `/api` prefix. Health inspection routes `/healthz` and `/readyz` are served from the root.

### Wire Format

All JSON endpoints utilize standard wire envelopes.

Success envelope:
```json
{
  "status": "ok",
  "message": "Operation completed successfully.",
  "data": { ... }
}
```

Error envelope:
```json
{
  "status": "error",
  "code": "quota_exceeded",
  "message": "Your monthly token quota is exhausted.",
  "retryable": false,
  "details": { ... }
}
```
Note: The `trace` attribute is only present in the error envelope when `NODE_ENV=development`.

### Core Endpoint Summary

| Method | Endpoint | Description | Auth Required |
| --- | --- | --- | --- |
| `GET` | `/healthz` | Process liveness check | No |
| `GET` | `/readyz` | Database readiness and migration status | No |
| `POST` | `/api/auth/login` | Authenticate credentials and receive session cookie with CSRF token | Origin only |
| `POST` | `/api/auth/logout` | Revoke session and clear authentication cookie | Yes |
| `GET` | `/api/me` | Fetch authenticated user profile and permissions | Yes |
| `POST` | `/api/me/password` | Update current user password | Yes |
| `GET` | `/api/models` | List active models available to the caller | Yes |
| `GET` | `/api/conversations` | List conversation threads using keyset pagination | Yes |
| `POST` | `/api/conversations` | Create a new conversation thread | Yes |
| `GET` | `/api/conversations/:id` | Retrieve conversation details and messages | Yes |
| `DELETE` | `/api/conversations/:id` | Soft-delete a conversation thread | Yes |
| `POST` | `/api/conversations/:id/messages` | Send message and initialize generation job | Yes |
| `GET` | `/api/generations/:id/stream` | Connect to SSE stream for generation output | Yes |
| `POST` | `/api/generations/:id/cancel` | Cancel an in-flight generation | Yes |
| `POST` | `/api/conversations/:id/attachments` | Upload binary attachment with magic byte inspection | Yes |
| `GET` | `/api/files/:id/content` | Download binary attachment file | Yes |
| `GET` | `/api/admin/users` | List users with keyset pagination | Admin |
| `POST` | `/api/admin/users` | Create user account | Admin |
| `GET` | `/api/admin/quotas` | Inspect quota accounts and policies | Admin |
| `GET` | `/api/admin/reporting/usage` | Aggregated token usage analytics | Super Admin |
| `GET` | `/api/admin/reporting/audit-logs` | Search immutable security audit log | Super Admin |

## Project Structure

```text
src/
├── admin/            # Administrative user, division, and policy management
├── artifactsink/     # Hydration of provider-generated files into local storage
├── attachments/      # File upload validation, text extraction, and attachment storage
├── audit/            # Immutable audit logging repository and action catalog
├── auth/             # Password verification, session management, and RBAC
├── cli/              # Management CLI commands (migrations, bootstrap, seeding)
├── clock/            # System clock and UUIDv7 ID generator abstractions
├── config/           # Environment validation via Zod schemas
├── context-builder/  # Token estimation, context truncation, and prompt assembly
├── conversations/    # Threads, messages, parts, and sequence allocation
├── db/               # PostgreSQL pool, Drizzle schema, transactions, and migrations
├── generations/      # Execution records, checkpointer, and settlement finalizer
├── http/             # Hono middleware, error handling, rate limiting, and wire envelopes
├── jobs/             # PostgreSQL SKIP LOCKED job queue, runners, and recurring schedulers
├── observability/    # Winston logging setup, redaction filters, and daily rotation
├── orchestrator/     # SSE streaming, run lifecycle manager, and ring buffer
├── providers/        # Provider Abstraction Layer (PAL) and adapters (OpenAI, Anthropic, Gemini)
├── quota/            # Quota accounts, policies, atomic reservations, and tariffs
├── reporting/        # Usage aggregations, daily rollups, and audit log search
├── storage/          # Storage abstraction port and atomic local filesystem adapter
├── app.ts            # Hono application routing assembly
├── server.ts         # Process entry point, role initialization, and graceful shutdown
└── services.ts       # Dependency injection and infrastructure wiring
```
