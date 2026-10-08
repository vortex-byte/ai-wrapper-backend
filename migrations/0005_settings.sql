-- 0005 — system settings + sanitized error events (AGENTS §6.10)

CREATE TABLE system_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  version    int NOT NULL DEFAULT 1 CHECK (version >= 1),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Platform defaults are data, not secrets; safe to ship in a migration.
INSERT INTO system_settings (key, value)
VALUES ('quota.timezone', '"Asia/Jakarta"'::jsonb)
ON CONFLICT (key) DO NOTHING;

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
  context       jsonb NOT NULL DEFAULT '{}',
  CHECK (length(btrim(component)) > 0),
  CHECK (length(btrim(category)) > 0),
  CHECK (length(btrim(message)) > 0)
);
CREATE INDEX error_events_time_idx ON error_events (occurred_at DESC, category);
CREATE INDEX error_events_request_idx ON error_events (request_id);
