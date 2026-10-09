-- 0006 — align user email uniqueness with soft-delete semantics (AGENTS §6.14, forward-only)
--
-- `users.email` was declared inline `UNIQUE` in 0002, which ignores `deleted_at`.
-- Re-creating a user whose email belongs to a soft-deleted row therefore raised a raw
-- 23505 and surfaced as a 500 instead of a 409 conflict. Replace it with a partial
-- unique index scoped to live rows.
--
-- `divisions.name` is intentionally left alone: divisions have no `deleted_at` column
-- (they are never soft-deleted), so a plain UNIQUE is already correct there.
--
-- Expand/contract: this only narrows the constraint; no column is dropped and no
-- running release stops using the index.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key;
CREATE UNIQUE INDEX users_email_live_uq ON users (email) WHERE deleted_at IS NULL;
