# Runbook — Provider outage / degradation

**Goal:** keep the rest of the product working, fail in a way the SPA can render, and avoid burning
quota on doomed calls.
**Owner:** on-call backend engineer. **Severity:** P1 if every provider is down, P2 if one is.

## Detect

Users report "generation failed" and/or `/readyz` stays green while fast-failing generations climb.
Readiness deliberately ignores provider health — the app is up even when a provider is not.

```bash
# Error rate by category for today.
sudo cat /var/log/ai-chat/error-$(date +%F).log \
  | jq -r 'select(.category != null) | .category' | sort | uniq -c | sort -rn

# And in the operational table, which survives log rotation and is queryable per provider.
psql -d aichat -c "
  SELECT category, provider_id, count(*) AS events
    FROM error_events
   WHERE occurred_at > now() - interval '30 minutes'
   GROUP BY 1, 2 ORDER BY events DESC;"
```

Map `provider_id` to a name:

```bash
psql -d aichat -c 'SELECT id, key, status FROM ai_providers ORDER BY key;'
```

## Classify

| Category | Meaning | Typical cause |
|---|---|---|
| `provider_auth` | 401/403 from upstream | Revoked/expired key, disabled project |
| `provider_rate_limited` | 429 | Provider-side limit, burst of traffic |
| `provider_unavailable` | 5xx / connection refused | Provider incident |
| `provider_timeout` | No first byte within the deadline | Network path, overloaded upstream |
| `generation_timeout` | Stream stalled mid-flight | Long generations hitting the deadline |

Check the provider's own status page before assuming our side is at fault.

## Act

1. **Confirm it is upstream, not us.** One manual call with the deployed key:
   ```bash
   # The key is never printed; only the HTTP status is.
   sudo grep '^OPENAI_API_KEY=' /etc/ai-chat/ai-chat.env >/dev/null && echo 'key present'
   curl -sS -o /dev/null -w '%{http_code}\n' https://api.openai.com/v1/models \
     -H "Authorization: Bearer $(sudo sed -n 's/^OPENAI_API_KEY=//p' /etc/ai-chat/ai-chat.env)"
   ```
   If it 401s, switch to [provider-secret-rotation.md](provider-secret-rotation.md) path B.

2. **Disable the failing provider** (admin API, so the change is audited):
   ```
   PATCH /api/admin/providers/:id   { "status": "disabled" }
   ```
   Effect: `GET /api/models` stops returning its models, so new turns cannot select it. In-flight
   generations fail with a retryable error — that is expected.

3. **If every provider is down**, do not disable them all: users cannot start anything, but the
   existing conversations and history still load. Post an internal status note and wait; disabling
   also blocks recovery. Fixes to try in order:
   - `sudo systemctl restart ai-chat@blue` (a stuck adapter client or a leaked socket pool).
   - Raise `providers.config.timeoutMs` only if the failures are timeouts and the provider is slow,
     not down.
   - Check egress: `curl -sS -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/v1/models`.

4. **Protect quota.** During an incident the reaper releases reservations for generations that never
   completed, so users are not charged for provider failures. Verify it is running:
   ```bash
   psql -d aichat -c "
     SELECT count(*) AS stale_active
       FROM quota_reservations
      WHERE status = 'active' AND expires_at < now();"
   # expect: 0 after one reaper cycle (60 s)
   ```
   If `stale_active` keeps growing, the worker role is down — see step 5.

5. **Is the worker running?** Jobs (reaper, rollups, retention) run in the `all` or `worker` role:
   ```bash
   psql -d aichat -c "SELECT status, count(*) FROM jobs GROUP BY 1;"
   psql -d aichat -c "SELECT locked_by, count(*) FROM jobs WHERE status = 'running' GROUP BY 1;"
   sudo journalctl -u ai-chat@blue --since '10 minutes ago' | grep -i 'job'
   ```

## Verify recovery

- `GET /api/models` lists the provider's models again after re-enabling.
- A fresh message streams to `generation.completed`.
- `error_events` for the last 5 minutes has no new rows of the failing category:
  ```bash
  psql -d aichat -c "
    SELECT count(*) FROM error_events
     WHERE occurred_at > now() - interval '5 minutes' AND category LIKE 'provider_%';"
  ```

## Follow up

- If quota was overshot by failed retries, reconcile:
  [quota-reconciliation-mismatch.md](quota-reconciliation-mismatch.md).
- If the same provider has failed twice in a week, open a follow-up item for a circuit breaker with
  automatic disable/retry-after.
