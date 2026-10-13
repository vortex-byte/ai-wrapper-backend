-- 0011 — remove the `auditor` role (MVP has two roles: user | admin)
--
-- The `auditor` role was a read-only subset of `admin` (PRD §15.2): every capability it
-- held, `admin` already holds. Dropping it removes a role that carried no exclusive access.
--
-- Existing `auditor` rows are promoted to `admin` so their reporting/audit access is preserved.

UPDATE users SET role = 'admin', updated_at = now() WHERE role = 'auditor';

ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('user','admin'));
