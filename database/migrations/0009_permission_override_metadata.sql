-- Per-user permission overrides: why, and for how long.
--
-- An elevated permission that nobody can explain, and that never expires, is
-- how an organisation quietly accumulates over-privileged accounts. The reason
-- is recorded so an auditor can read it, and the expiry is enforced where
-- permissions are loaded (src/auth/identity.js), not merely displayed.

ALTER TABLE user_permissions ADD COLUMN reason TEXT;
ALTER TABLE user_permissions ADD COLUMN expires_at TEXT;

CREATE INDEX idx_user_permissions_expiry
  ON user_permissions (expires_at) WHERE expires_at IS NOT NULL;
