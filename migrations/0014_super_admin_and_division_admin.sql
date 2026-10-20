-- 0014 — super_admin and division-scoped admin roles (PRD §6, §15, §17)
--
-- Promotes existing admin accounts to super_admin (preserving full platform authority).
-- Updates users_role_check to ('user', 'admin', 'super_admin').
-- Adds constraint users_admin_division_check requiring division_id NOT NULL when role = 'admin'.

UPDATE users SET role = 'super_admin', updated_at = now() WHERE role = 'admin';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'super_admin'));

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_admin_division_check;
ALTER TABLE users
  ADD CONSTRAINT users_admin_division_check CHECK (role <> 'admin' OR division_id IS NOT NULL);
