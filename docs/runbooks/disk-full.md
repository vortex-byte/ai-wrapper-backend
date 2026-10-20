# Runbook — Disk full

**Impact:** uploads fail, log writes fail, PostgreSQL may go read-only, and generations fail at the
finalizer when they cannot write. **Severity:** P1.

## Detect

Any of:

```bash
df -h / /var/lib/ai-chat /var/log /var/backups      # any Use% at 100%
sudo tail -n 200 /var/log/ai-chat/error-$(date +%F).log | jq 'select(.err.code == "ENOSPC")'
sudo journalctl -u ai-chat@blue --since '1 hour ago' | grep -i 'no space'
```

The platform alert fires below **20 % free**, so a full disk means an alert was missed
or something grew abruptly.

## Assess — what is using the space, in priority order

```bash
# 1. Log volume (Winston + journald)
sudo du -sh /var/log/ai-chat /var/log/journal
sudo ls -lhS /var/log/ai-chat | head

# 2. Uploaded/generated blobs (temporary by design)
sudo du -sh /var/lib/ai-chat/files
sudo find /var/lib/ai-chat/files -type f -mtime +31 | wc -l    # should trend to 0

# 3. Backups (a missing retention purge is the usual culprit)
sudo du -sh /var/backups/ai-chat
sudo ls -lh /var/backups/ai-chat | tail

# 4. Database
sudo -u postgres psql -d aichat -c "
  SELECT relname,
         pg_size_pretty(pg_total_relation_size(c.oid)) AS total
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r'
   ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 10;"
```

## Act — safe reclaim, in this order

1. **Old compressed logs** (safe; retention should have done this):
   ```bash
   sudo find /var/log/ai-chat -name '*.log.gz' -mtime +14 -delete
   sudo journalctl --vacuum-time=14d
   ```
2. **Offsite-shipped backups**: delete only dumps already verified as copied offsite.
   ```bash
   sudo ls -lh /var/backups/ai-chat     # confirm today's dump is offsite BEFORE deleting anything
   sudo find /var/backups/ai-chat -name 'aichat-*.dump' -mtime +14 -delete
   ```
   Never delete the newest dump. If offsite shipping is broken, fix that first — the dumps are the
   only full recovery artifact.
3. **Orphaned blobs**: run the reconciliation job rather than `rm` by hand — it compares storage keys
   with `attachments` rows and deletes only unreferenced files.
   ```bash
   psql -d aichat -c "SELECT id, type, status, run_at FROM jobs WHERE type = 'storage.reconcile' ORDER BY created_at DESC LIMIT 3;"
   # If the scheduler is behind, enqueue one now. A unique dedupe_key keeps this idempotent,
   # and the worker picks it up within JOB_POLL_INTERVAL_MS.
   psql -d aichat -c "
     INSERT INTO jobs (id, type, payload, dedupe_key)
     VALUES (gen_random_uuid(), 'storage.reconcile', '{}',
             'storage.reconcile:manual:' || to_char(now(), 'YYYYMMDDHH24MI'))
     ON CONFLICT (dedupe_key) DO NOTHING;"
   ```
4. **Expired attachments** the expiry job has not reached:
   ```bash
   psql -d aichat -c "
     SELECT status, count(*) FROM attachments
      WHERE expires_at < now() AND status IN ('ready','uploading','processing')
      GROUP BY 1;"
   ```
   If the count is large, the `attachments.expire` job is stuck — fix the worker (below), do not
   `DELETE` rows manually: blobs would be orphaned with no key to find them by.
5. **Database bloat**: the autovacuum tuning in `migrations/0016_autovacuum_tuning.sql` should keep
   `message_parts`/`quota_accounts`/`jobs` from bloating. If one table is still huge:
   ```bash
   sudo -u postgres psql -d aichat -c "VACUUM (VERBOSE, ANALYZE) message_parts;"
   ```
   `VACUUM FULL` rewrites the table and takes an `ACCESS EXCLUSIVE` lock — do not run it during
   business hours; prefer onboarding monthly partitioning.

## Verify

```bash
df -h /var/lib/ai-chat /var/log
# A new upload succeeds and a generation completes end to end.
```

Also confirm the jobs that were failing resume:

```bash
psql -d aichat -c "SELECT type, status, count(*) FROM jobs WHERE created_at > now() - interval '1 hour' GROUP BY 1,2;"
sudo tail -n 50 /var/log/ai-chat/error-$(date +%F).log | jq -r 'select(.err.code == "ENOSPC") | .msg'
```

## Follow up

- If retention did not run, it failed silently: check that the worker role is up and that
  `CONVERSATION_RETENTION_DAYS` / `LOG_FILE_RETENTION_DAYS` / `LOG_MAX_SIZE` are set as intended.
- If the growth was uploads, check `attachments.expire` and `attachments.purge_orphans` job history;
  the orphan grace window is 60 minutes, so a broken expiry job shows up as a fast-growing directory.
- Add a dashboard/alert note with the reclaimed amount and root cause.
