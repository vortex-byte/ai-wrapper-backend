# Runbook — Logging operations

**Goal:** find the right log line fast, keep rotation healthy, and prove redaction still holds.
**Owner:** on-call engineer. **Severity:** P3 unless logs are missing during an incident.

## Where the logs live

| Transport | Path | Level | Retention |
|---|---|---|---|
| Console (systemd journal) | `journalctl -u ai-chat@blue` | `LOG_LEVEL` | journald policy |
| Application | `/var/log/ai-chat/app-%DATE%.log` | info, warn, error | 14 days, gzip after rotation |
| Errors only | `/var/log/ai-chat/error-%DATE%.log` | error | 14 days, gzip |
| Audit trail | `audit_logs` table | — | 24 months |
| Operational errors | `error_events` table | — | queryable, sanitized |

Rotation: `winston-daily-rotate-file`, `datePattern: 'YYYY-MM-DD'`, `maxSize: '20m'`,
`maxFiles: '14d'`, `zippedArchive: true`. Size-based rollover appends a suffix
(`app-2026-10-20.1.log`) when a day's file passes 20 MB.

## Read them efficiently

Every line is one JSON object (`ts`, `level`, `msg`, plus bound fields).

```bash
# Human-readable recent errors.
sudo tail -n 100 /var/log/ai-chat/error-$(date +%F).log | jq -r '"\(.ts) \(.msg)"'

# One request across files (the id is in the X-Request-Id response header).
sudo zgrep -h '"requestId":"<id>"' /var/log/ai-chat/app-*.log* | jq

# One generation: orchestration start/finish, provider errors, settlement.
sudo zgrep -h '"generationId":"<id>"' /var/log/ai-chat/*.log* | jq

# Error rate by category (also available in error_events, which survives rotation).
sudo cat /var/log/ai-chat/error-$(date +%F).log | jq -r '.category // "uncategorized"' | sort | uniq -c | sort -rn
```

`zcat -f` or `zgrep` works on rotated `.gz` archives; `grep -r` does not decompress them.

## What is redacted (and what is not)

The logger deep-redacts at serialization time:

- **Secret-bearing keys** (`password`, `*Token`, `apiKey`, `authorization`, `secret*`, `cookie`, …)
  → `[redacted]`.
- **Content-bearing keys** (`prompt`, `messages`, `content`, `body`, `text`, `fileBytes`, …) →
  **dropped**, not replaced.
- **Free text** is scrubbed for `Bearer …`, `sk-…`, `AIza…`, `password=…`, and
  `postgres://user:pass@…` before it is written, including inside `err.stack`.

Never log message text, prompts, file bytes, provider response bodies, emails, keys, or password
material. Instead log identifiers and counts: `requestId`, `generationId`, `userId` (id only),
`inputTokens`, `durationMs`, `errorCode`.

## Verify redaction after a change

The CI test suite is the primary guard (`tests/unit/observability/logger.test.ts`). To spot-check
a running instance:

```bash
# 1. Key-shaped material anywhere in today's logs.
sudo grep -cE 'sk-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{20,}|Bearer [A-Za-z0-9._-]{20,}' \
  /var/log/ai-chat/*.log | grep -v ':0' || echo 'clean'

# 2. Content keys must not appear as JSON fields at all.
sudo grep -oE '"(prompt|messages|content|fileBytes)":' /var/log/ai-chat/app-$(date +%F).log | sort | uniq -c
# expect: no output

# 3. A stack trace is present on errors (proves stack serialization works).
sudo tail -n 200 /var/log/ai-chat/error-$(date +%F).log | jq -r 'select(.err.stack != null) | .err.name' | sort | uniq -c
```

If a leak is found: treat it as an incident, rotate the exposed secret
([provider-secret-rotation.md](provider-secret-rotation.md)), delete the affected log files and
archives, then fix the field name in `src/observability/logger.ts` redaction lists.

## Rotation health

```bash
sudo ls -lh /var/log/ai-chat | tail -20
sudo du -sh /var/log/ai-chat
# Files older than the retention window mean rotation/retention is broken.
sudo find /var/log/ai-chat -name '*.log*' -mtime +15 | head
```

If disk grows without pruning, check `LOG_FILE_RETENTION_DAYS`, `LOG_MAX_SIZE`, and that the process
can create files in `/var/log/ai-chat` (ownership `aichat`, mode `0750`).

## Alerts derived from logs (no metrics endpoint)

| Alert | Signal | First check |
|---|---|---|
| Generation failure spike | `error-*.log` count of `generation failed` per 5 min | [provider-outage.md](provider-outage.md) |
| Auth failures | `category: "provider_auth"` | key validity, [provider-secret-rotation.md](provider-secret-rotation.md) |
| Reservations past expiry | `quota_reservations.status = 'active' AND expires_at < now()` | worker role up? |
| Reconciliation mismatch | `jobs` row for `quota.reconcile` failed | [quota-reconciliation-mismatch.md](quota-reconciliation-mismatch.md) |
| Disk < 20 % | host agent | [disk-full.md](disk-full.md) |
| Readiness flapping | external probe on `/readyz` | DB pool, disk, migrations |
