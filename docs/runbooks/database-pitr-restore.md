# Runbook — Database point-in-time restore (PITR)

**Target:** RTO ≤ 1 h, RPO ≤ 5 min.
**Owner:** on-call backend engineer. **Severity:** P1.

## When to use this

- A migration or script corrupted data (bad `UPDATE`/`DELETE`, wrong backfill).
- The database host is lost and the volume must be rebuilt.
- A recovery drill on staging (quarterly, and before launch).

Do **not** use this to fix a single bad row — that is a targeted write with an audit row.
A restore is destructive and rolls back every user's data to the recovery point.

## Prerequisites (verify before you need it)

- [ ] WAL archiving is on and the archive is **offsite**:
  ```bash
  psql -d postgres -c 'SHOW archive_mode;'        # expect: on
  psql -d postgres -c 'SHOW archive_command;'     # expect: a copy to the archive volume
  ls -lh /var/lib/postgresql/wal-archive | tail   # segments arriving every ~16 MB / 60 s
  ```
- [ ] Nightly `pg_dump -Fc` exists and is shipped offsite (`rclone copy`).
- [ ] The restore procedure was rehearsed on staging; the timing below is a measured number.

## 1. Stop the bleeding

```bash
# Stop both instances so nothing writes while you decide the recovery target.
sudo systemctl stop ai-chat@blue ai-chat@green
```

If the cause is a scheduled job, disable its timer first (`sudo systemctl stop ai-chat-scheduler`
or comment the cron entry) so it does not re-run after the restore.

## 2. Choose the recovery target

Find the last known-good timestamp **before** the corrupting action. Use the audit log:

```bash
psql -d aichat -c "
  SELECT created_at, action, target_type, target_id
    FROM audit_logs
   WHERE created_at > now() - interval '6 hours'
   ORDER BY created_at DESC
   LIMIT 50;"
```

Write it down as UTC (`2026-10-20 08:14:00+00`). When in doubt, pick the earlier timestamp: replaying
less is recoverable, replaying corruption is not.

## 3. Restore into a **new** directory, never over the live one

```bash
sudo systemctl stop postgresql
sudo -u postgres rm -rf /var/lib/postgresql/restore
sudo -u postgres mkdir -p /var/lib/postgresql/restore
# Unpack the latest base backup taken BEFORE the target recovery time
sudo -u postgres tar -xzf /var/backups/ai-chat/basebackup-<DATE>.tar.gz -C /var/lib/postgresql/restore
```

Add the recovery target to `postgresql.auto.conf`:

```
restore_command = 'cp /var/lib/postgresql/wal-archive/%f %p'
recovery_target_time = '2026-10-20 08:14:00+00'
recovery_target_action = 'promote'
```

Create `recovery.signal` in the restore directory, then start PostgreSQL on the restored directory
(change `data_directory` or move it into place after the check below).

```bash
sudo -u postgres touch /var/lib/postgresql/restore/recovery.signal
sudo systemctl start postgresql
sudo -u postgres psql -c 'SELECT pg_is_in_recovery();'   # expect: f (promoted)
```

If PITR is not yet enabled, fall back to the nightly dump — accept the larger RPO:

```bash
sudo -u postgres createdb -T template0 aichat_restore
sudo -u postgres pg_restore -d aichat_restore /var/backups/ai-chat/aichat-YYYY-MM-DD.dump
```

## 4. Verify before pointing traffic at it

```bash
# Row counts look sane and the corrupting change is gone.
sudo -u postgres psql -d aichat -c "
  SELECT
    (SELECT count(*) FROM users)             AS users,
    (SELECT count(*) FROM conversations)     AS conversations,
    (SELECT count(*) FROM message_parts)     AS parts,
    (SELECT count(*) FROM generation_jobs)   AS generations;"

# Accounting invariants hold: nothing was double-settled or over-reserved.
psql -d aichat -c "
  SELECT count(*) AS over_limit
    FROM quota_accounts
   WHERE used_tokens + reserved_tokens > base_limit_tokens + adjustment_tokens;"
# expect: 0

psql -d aichat -c "
  SELECT count(*) AS duplicate_settlements
    FROM usage_events GROUP BY generation_id HAVING count(*) > 1;"
# expect: no rows (generation_id is UNIQUE; this proves the constraint survived)
```

Then start one instance against it and smoke-test:

```bash
sudo systemctl start ai-chat@blue
curl -fsS http://127.0.0.1:8080/readyz
# sign in through the SPA, send one message, confirm it streams, then check:
sudo tail -n 20 /var/log/ai-chat/error-$(date +%F).log | jq -r '.msg'
```

## 5. Re-open traffic and reconcile

1. Flip the proxy to the restored instance.
2. Re-enable scheduled jobs (`systemctl start ai-chat-scheduler`).
3. Run quota reconciliation explicitly, then inspect it:
   ```bash
   psql -d aichat -c "
     INSERT INTO jobs (id, type, payload, dedupe_key)
     VALUES (gen_random_uuid(), 'quota.reconcile', '{}',
             'quota.reconcile:manual:' || to_char(now(), 'YYYYMMDDHH24MI'))
     ON CONFLICT (dedupe_key) DO NOTHING;"
   psql -d aichat -c "SELECT * FROM jobs WHERE type = 'quota.reconcile' ORDER BY created_at DESC LIMIT 3;"
   ```
4. Expect a burst of `missing` attachments: the blob volume is deliberately **not** backed up.
   The expiry job marks them `missing`, and the SPA renders "unavailable". Do not try to
   restore bytes from backups.

## 6. Follow up

- Write an incident note: recovery target, data lost window, users affected, verification output.
- Add the failure mode to the alert list if it was not already covered.
- If a migration caused it: the migration is **forward-only**. Ship a corrective migration; do not
  edit the applied one.
