-- 0001 — extensions
-- Case-insensitive email identity (AGENTS §6.1). pg_trgm is intentionally not
-- installed yet; add it with a later migration when admin substring search lands.
CREATE EXTENSION IF NOT EXISTS citext;
