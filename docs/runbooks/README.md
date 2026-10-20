# Runbooks

Operational procedures for the internal AI chat platform.

Every runbook follows the same shape: **detect → assess → act → verify → follow up**. Commands
assume the standard VPS layout:

| Thing | Value |
|---|---|
| Service | `ai-chat@blue` / `ai-chat@green` (systemd) |
| App root | `/srv/ai-chat/current` |
| Env file | `/etc/ai-chat/ai-chat.env` (root, `0600`) |
| Logs | `/var/log/ai-chat/app-%DATE%.log`, `/var/log/ai-chat/error-%DATE%.log` |
| Files | `/var/lib/ai-chat/files` |
| Backups | `/var/backups/ai-chat` |

## Index

| Runbook | Use when |
|---|---|
| [database-pitr-restore.md](database-pitr-restore.md) | Data corruption, bad migration, or a lost host; restore to a point in time |
| [provider-secret-rotation.md](provider-secret-rotation.md) | A provider key is exposed, expired, or rotated on schedule |
| [provider-outage.md](provider-outage.md) | Upstream errors, 401/403, timeouts, or one provider degrading |
| [disk-full.md](disk-full.md) | `No space left on device`, rising disk usage, or a stalled upload/generation |
| [quota-reconciliation-mismatch.md](quota-reconciliation-mismatch.md) | Nightly reconciliation reports a mismatch, or a user disputes usage |
| [logging-operations.md](logging-operations.md) | Reading/rotating logs, verifying redaction, alerting off `error-*.log` |

## Universal first steps

```bash
# 1. Is the process healthy?
curl -fsS http://127.0.0.1:8080/healthz && curl -fsS http://127.0.0.1:8080/readyz
sudo systemctl status ai-chat@blue --no-pager

# 2. What is it complaining about? (JSON lines; jq makes them readable)
sudo tail -n 200 /var/log/ai-chat/error-$(date +%F).log | jq -r '"\(.ts) \(.level) \(.msg)"'

# 3. Correlate one request end-to-end. The id is in the X-Request-Id response header.
sudo grep -h '"requestId":"<request-id>"' /var/log/ai-chat/app-*.log | jq

# 4. Recent systemd restarts / OOM kills
sudo journalctl -u ai-chat@blue --since '1 hour ago' --no-pager | tail -n 100
```

**Never** paste log lines containing `email`, `ip`, or provider payloads into a ticket. Redaction
removes secrets and content, but operational metadata is still personal data.

## Escalation

| Severity | Definition | Response |
|---|---|---|
| P1 | Sign-in or generation unavailable for everyone | Page on-call now; follow the matching runbook |
| P2 | One provider/division degraded; workaround exists | Act within business hours; update status note |
| P3 | Single-user issue, cosmetic, or an alert that self-resolved | Normal ticket queue |
