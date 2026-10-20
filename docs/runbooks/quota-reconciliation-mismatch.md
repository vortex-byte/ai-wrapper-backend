# Runbook — Quota reconciliation mismatch

**Impact:** users may be charged for tokens they did not consume (or get free ones), and the nightly
job reports a mismatch. **Severity:** P2, P1 if it affects many accounts.

## How the numbers should relate

```
used_tokens + reserved_tokens <= base_limit_tokens + adjustment_tokens     -- per quota_accounts row
```

- `quota_ledger` is append-only evidence: `reserve`, `settle`, `release`, `expire_release`,
  `adjust`, `grant`.
- `usage_events` is one row per **settled** generation (`generation_id` is UNIQUE).
- `reserved_tokens` holds money in flight; a generation that dies without settling is released by
  the reaper (`quota.reservations.reaper`, every 60 s).

## Detect

```bash
# The nightly job's result.
psql -d aichat -c "
  SELECT created_at, status, last_error
    FROM jobs WHERE type = 'quota.reconcile' ORDER BY created_at DESC LIMIT 5;"

# Mismatches it writes into the error stream.
psql -d aichat -c "
  SELECT occurred_at, message, context
    FROM error_events WHERE category = 'quota_mismatch'
   ORDER BY occurred_at DESC LIMIT 20;"

sudo grep '"msg":"quota reconciliation' /var/log/ai-chat/app-$(date +%F).log | jq
```

## Diagnose — three independent checks

**1. Did the reservation count drift?**

```bash
psql -d aichat -c "
  SELECT a.id, a.user_id,
         a.used_tokens, a.reserved_tokens,
         a.base_limit_tokens, a.adjustment_tokens,
         COALESCE(r.active_reserved, 0) AS from_reservations
    FROM quota_accounts a
    LEFT JOIN (
      SELECT account_id, sum(reserved_tokens) AS active_reserved
        FROM quota_reservations WHERE status = 'active' GROUP BY account_id
    ) r ON r.account_id = a.id
   WHERE a.reserved_tokens <> COALESCE(r.active_reserved, 0)
   LIMIT 50;"
```

A nonzero `from_reservations - reserved_tokens` means a reservation is `active` but no longer counted
(the account was updated without it) or the reverse. Check for a stale `active` row whose generation is
already terminal:

```bash
psql -d aichat -c "
  SELECT r.id, r.generation_id, r.reserved_tokens, r.expires_at, g.status
    FROM quota_reservations r JOIN generation_jobs g ON g.id = r.generation_id
   WHERE r.status = 'active' AND g.status IN ('completed','cancelled','failed')
   LIMIT 50;"
```

Those should not exist: terminal transitions settle or release in the same transaction.
If they do, the finalizer crashed between the state change and the settlement —
release them through the service (`quota.release`), never with raw SQL, so the ledger stays truthful.

**2. Does the ledger fold to the counter?**

```bash
psql -d aichat -c "
  SELECT l.account_id,
         sum(CASE l.entry_type
               WHEN 'settle' THEN l.tokens_delta
               WHEN 'adjust' THEN l.tokens_delta
               WHEN 'grant'  THEN l.tokens_delta
               ELSE 0 END) AS ledger_delta,
         a.used_tokens
    FROM quota_ledger l JOIN quota_accounts a ON a.id = l.account_id
   WHERE a.period_start = date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta')
   GROUP BY l.account_id, a.used_tokens
  HAVING sum(CASE l.entry_type
               WHEN 'settle' THEN l.tokens_delta
               WHEN 'adjust' THEN l.tokens_delta
               WHEN 'grant'  THEN l.tokens_delta
               ELSE 0 END) <> a.used_tokens
   LIMIT 20;"
```

**3. Does usage agree with settlements?**

```bash
psql -d aichat -c "
  SELECT u.generation_id
    FROM usage_events u
    JOIN quota_reservations r ON r.generation_id = u.generation_id
   WHERE u.quota_tokens <> r.settled_tokens
   LIMIT 20;"
```

## Act

1. **If a user disputes usage**, pull their evidence before changing anything:
   ```bash
   psql -d aichat -c "
     SELECT l.created_at, l.entry_type, l.tokens_delta, l.used_after, l.reserved_after,
            l.generation_id, l.reason
       FROM quota_ledger l
      WHERE l.user_id = '<user-id>' ORDER BY l.id DESC LIMIT 50;"
   ```
2. **Correct with a new row, never an edit.** Both `quota_ledger` and `audit_logs` are append-only
   by grant; an `UPDATE` will be rejected, which is the intended behavior.
   - Refund: a `grant`/`adjust` entry with a positive delta and `reason` set, plus the matching
     `quota_accounts.used_tokens` change in the same transaction.
   - Charge correction after an overshoot: `usage_events.overshoot_tokens` already records it; do not
     rewrite `usage_events`.
3. Record the correction as an admin mutation so `audit_logs` has an entry with `before`/`after`.

## Verify

Re-run the three checks; all return no rows. Then:

```bash
psql -d aichat -c "
  SELECT count(*) AS over_limit FROM quota_accounts
   WHERE used_tokens + reserved_tokens > base_limit_tokens + adjustment_tokens;"
# expect: 0
```

## Follow up

- Reconcile mismatches almost always mean a crash between a terminal state change and its
  settlement. Confirm the reaper runs (`generation.reaper`, every 30 s) and that its
  `generation_interrupted` path settles rather than only marking the message failed.
- If the drift came from a restore, note the recovery timestamp and expect the ledger to be
  internally consistent but incomplete for the lost window.
