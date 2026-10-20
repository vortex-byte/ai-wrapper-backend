# Runbook — Provider secret rotation

**Target:** zero failed generations during rotation (keys are read per request from the environment).
**Owner:** platform admin + on-call engineer. **Severity:** P1 if a key leaked, P3 if scheduled.

## How secrets are held

- `ai_providers.secret_ref` stores the **name** of an environment variable (e.g. `OPENAI_API_KEY`),
  never the key itself.
- The adapter resolves that variable when it builds the client, so a rotation is an env change plus
  a restart — **no database write**.
- `.env` is `0600`, owned by root, at `/etc/ai-chat/ai-chat.env`. Secrets never appear in code, the
  database, logs, or `ps` output.

Confirm the current mapping before touching anything:

```bash
psql -d aichat -c 'SELECT key, adapter, secret_ref, status FROM ai_providers ORDER BY key;'
# secret_ref is an env var NAME, e.g. OPENAI_API_KEY — never a value
```

## Path A — scheduled rotation (no incident)

1. **Issue the new key** in the provider console. Keep the old key active.
2. Set a spend cap on the new key if the console supports it.
3. Update the env file (avoid shell history):
   ```bash
   sudo -e /etc/ai-chat/ai-chat.env     # replace the value for OPENAI_API_KEY
   sudo chmod 600 /etc/ai-chat/ai-chat.env
   sudo chown root:root /etc/ai-chat/ai-chat.env
   ```
4. Rolling restart — one instance at a time so generation stays available:
   ```bash
   sudo systemctl restart ai-chat@green
   curl -fsS http://127.0.0.1:8081/readyz
   # flip the proxy to :8081, drain blue, then restart blue and flip back when convenient
   sudo systemctl restart ai-chat@blue
   ```
5. **Verify a real call** for each affected provider (a one-sentence prompt). Then confirm the log
   has no auth failures:
   ```bash
   sudo grep -c '"category":"provider_auth"' /var/log/ai-chat/error-$(date +%F).log
   # expect: 0 (or unchanged from before the rotation)
   ```
6. Wait one full business day of clean traffic, then **revoke the old key** in the console.

## Path B — key exposed (do it now, in this order)

1. **Revoke the leaked key first.** A short outage is better than an open spend line. Users see
   `503 provider_unavailable` on the affected models; other providers keep working.
2. Disable the provider so no request keeps retrying with a dead key:
   ```bash
   psql -d aichat -c "UPDATE ai_providers SET status = 'disabled', updated_at = now() WHERE key = 'openai';"
   ```
   This is an admin mutation: write the audit row in the same transaction if you use the admin API
   (`PATCH /api/admin/providers/:id`) — prefer the API over raw SQL.
3. Issue a replacement key, update the env file, restart (`systemctl restart ai-chat@blue`), then
   re-enable the provider through the admin API.
4. **Assess exposure.** Pull the provider's usage/billing for the leaked key's lifetime and look for
   calls outside the app's traffic shape. Check the provider's audit log for key management events.
5. Search this repository's working tree and history for the value; if it was committed, treat the
   git remote as compromised and rotate everything that file contained.
6. Check our logs for leaks of the key **value** (redaction should have caught it):
   ```bash
   sudo grep -rl 'sk-' /var/log/ai-chat/ || echo 'no key-shaped strings in logs'
   ```
7. Write the incident note: exposure window, spend impact, keys rotated, follow-up action.

## If a rotation breaks generation

| Symptom | Likely cause | Fix |
|---|---|---|
| `provider_auth` 401 in `error-*.log` | New key value wrong, or a stale process | Re-check the env file on the **running** instance; restart both units |
| Provider still works with the old key | Process did not restart (env is read at boot) | `systemctl show ai-chat@blue -p ExecMainStartTimestamp`; restart |
| `secret_ref` points at a missing var | Typo in `ai_providers.secret_ref` | Fix through `PATCH /api/admin/providers/:id`, then restart |
| All models of one provider fail, others fine | Provider disabled from path B step 2 | Re-enable once a valid key is live |

## Never

- Put a key in `ai_providers.config`, a migration, a seed file, a ticket, or a chat message.
- Rotate the `SESSION_SECRET` at the same time — that signs out every user and makes CSRF tokens
  invalid, which turns a key rotation into a full outage.
