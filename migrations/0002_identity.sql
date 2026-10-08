-- 0002 — identity & access: divisions, users, sessions (AGENTS §6.4 / PRD §17)

CREATE TABLE divisions (
  id           uuid PRIMARY KEY,
  name         text NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
  external_ref text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX divisions_external_ref_uq ON divisions (external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE users (
  id                    uuid PRIMARY KEY,
  email                 citext NOT NULL UNIQUE,
  display_name          text NOT NULL,
  password_hash         text NOT NULL,
  password_updated_at   timestamptz NOT NULL DEFAULT now(),
  must_change_password  boolean NOT NULL DEFAULT true,
  failed_login_attempts int NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  locked_until          timestamptz,
  role                  text NOT NULL DEFAULT 'user'   CHECK (role IN ('user','admin','auditor')),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  division_id           uuid REFERENCES divisions(id),
  idp_subject           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  last_login_at         timestamptz,
  deleted_at            timestamptz,
  CHECK (length(btrim(display_name)) > 0)
);
CREATE UNIQUE INDEX users_idp_subject_uq ON users (idp_subject) WHERE idp_subject IS NOT NULL;
CREATE INDEX users_active_idx   ON users (status) WHERE status = 'active';
CREATE INDEX users_division_idx ON users (division_id) WHERE deleted_at IS NULL;
CREATE INDEX users_list_idx     ON users (created_at DESC, id);

CREATE TABLE sessions (
  id              char(64) PRIMARY KEY,                 -- sha256(cookie value)
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  rotated_from    char(64),
  ip              inet,
  user_agent_hash text,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expiry_idx      ON sessions (expires_at) WHERE revoked_at IS NULL;
