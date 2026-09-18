-- =============================================================================
-- 0001 — Identity, tenancy and security
-- =============================================================================
-- Conventions used across every migration in this project:
--   * Primary keys are TEXT (ULID-style, generated in `src/utils/id.js`).
--   * Timestamps are TEXT, ISO-8601 UTC — lexicographically sortable.
--   * Money is INTEGER *paise*. Never a float: a finance ledger must not drift.
--   * Every tenant-scoped table carries tenant_id and indexes it first.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------------------
-- Tenants — one row per firm/account on the platform. The isolation boundary.
-- --------------------------------------------------------------------------
CREATE TABLE tenants (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  legal_name        TEXT,
  email             TEXT NOT NULL,
  phone             TEXT,
  address_line1     TEXT,
  address_line2     TEXT,
  city              TEXT,
  state             TEXT,
  state_code        TEXT,               -- GST state code, drives CGST/SGST vs IGST
  pincode           TEXT,
  country           TEXT NOT NULL DEFAULT 'IN',
  gstin             TEXT,
  pan               TEXT,
  tan               TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','trial','suspended','cancelled')),
  timezone          TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency          TEXT NOT NULL DEFAULT 'INR',
  franchise_id      TEXT,               -- set when this tenant belongs to a franchise
  is_demo           INTEGER NOT NULL DEFAULT 0,
  onboarding_step   TEXT NOT NULL DEFAULT 'complete',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_tenants_status ON tenants(status);
CREATE INDEX idx_tenants_franchise ON tenants(franchise_id);

-- --------------------------------------------------------------------------
-- Franchises — a network operator owning several tenants (add-on 26).
-- --------------------------------------------------------------------------
CREATE TABLE franchises (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  code                TEXT NOT NULL UNIQUE,
  owner_name          TEXT,
  owner_email         TEXT,
  owner_phone         TEXT,
  city                TEXT,
  state               TEXT,
  status              TEXT NOT NULL DEFAULT 'onboarding'
                        CHECK (status IN ('onboarding','active','suspended','terminated')),
  revenue_share_pct   REAL NOT NULL DEFAULT 20.0,
  branding_json       TEXT,             -- franchise-level white-label overrides
  onboarded_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- --------------------------------------------------------------------------
-- Branches — offices within a tenant (add-on 25).
-- --------------------------------------------------------------------------
CREATE TABLE branches (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  code          TEXT NOT NULL,
  is_head_office INTEGER NOT NULL DEFAULT 0,
  address_line1 TEXT,
  city          TEXT,
  state         TEXT,
  state_code    TEXT,
  pincode       TEXT,
  phone         TEXT,
  email         TEXT,
  manager_user_id TEXT,
  latitude      REAL,                   -- geofence centre for GPS attendance
  longitude     REAL,
  geofence_m    INTEGER NOT NULL DEFAULT 200,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);
CREATE INDEX idx_branches_tenant ON branches(tenant_id);

-- --------------------------------------------------------------------------
-- Companies — the legal entities whose books are filed. A tenant may manage
-- many (multi-company add-on); a client user may be scoped to a subset.
-- --------------------------------------------------------------------------
CREATE TABLE companies (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  branch_id       TEXT REFERENCES branches(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  legal_name      TEXT,
  entity_type     TEXT NOT NULL DEFAULT 'private_limited'
                    CHECK (entity_type IN ('proprietorship','partnership','llp','private_limited','public_limited','trust','society','huf','other')),
  gstin           TEXT,
  pan             TEXT,
  tan             TEXT,
  cin             TEXT,
  registration_no TEXT,
  email           TEXT,
  phone           TEXT,
  website         TEXT,
  address_line1   TEXT,
  address_line2   TEXT,
  city            TEXT,
  state           TEXT,
  state_code      TEXT NOT NULL DEFAULT '33',
  pincode         TEXT,
  country         TEXT NOT NULL DEFAULT 'IN',
  financial_year_start TEXT NOT NULL DEFAULT '04-01',
  gst_registration_type TEXT NOT NULL DEFAULT 'regular'
                    CHECK (gst_registration_type IN ('regular','composition','casual','non_resident','sez','unregistered')),
  gst_filing_frequency TEXT NOT NULL DEFAULT 'monthly'
                    CHECK (gst_filing_frequency IN ('monthly','quarterly')),
  logo_key        TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','trial','inactive','suspended','archived')),
  is_demo         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX idx_companies_tenant ON companies(tenant_id, status);
CREATE INDEX idx_companies_branch ON companies(branch_id);
CREATE INDEX idx_companies_gstin ON companies(gstin);

-- --------------------------------------------------------------------------
-- Users
-- --------------------------------------------------------------------------
CREATE TABLE users (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL only for platform Super Admin
  email                 TEXT NOT NULL,
  password_hash         TEXT NOT NULL,          -- PBKDF2-SHA256, salted, iteration-tagged
  full_name             TEXT NOT NULL,
  phone                 TEXT,
  avatar_key            TEXT,
  job_title             TEXT,
  branch_id             TEXT REFERENCES branches(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','invited','suspended','locked','deactivated')),
  email_verified_at     TEXT,
  phone_verified_at     TEXT,
  twofa_enabled         INTEGER NOT NULL DEFAULT 0,
  twofa_secret          TEXT,                   -- AES-GCM encrypted TOTP seed
  twofa_backup_codes    TEXT,                   -- JSON array of hashed single-use codes
  twofa_enrolled_at     TEXT,
  must_change_password  INTEGER NOT NULL DEFAULT 0,
  failed_login_count    INTEGER NOT NULL DEFAULT 0,
  locked_until          TEXT,
  last_login_at         TEXT,
  last_login_ip         TEXT,
  locale                TEXT NOT NULL DEFAULT 'en-IN',
  timezone              TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  theme                 TEXT NOT NULL DEFAULT 'dark' CHECK (theme IN ('dark','light','system')),
  is_demo               INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT
);
-- Email is unique per tenant; the platform Super Admin (tenant_id NULL) is
-- covered by the second, partial index.
CREATE UNIQUE INDEX idx_users_tenant_email ON users(tenant_id, email) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX idx_users_platform_email ON users(email) WHERE tenant_id IS NULL;
CREATE INDEX idx_users_status ON users(tenant_id, status);
CREATE INDEX idx_users_branch ON users(branch_id);

-- --------------------------------------------------------------------------
-- Roles & permissions — seven system roles, plus tenant-defined custom roles.
-- --------------------------------------------------------------------------
CREATE TABLE roles (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = system role
  key           TEXT NOT NULL,          -- super_admin | admin | finance_manager | ...
  name          TEXT NOT NULL,
  description   TEXT,
  level         INTEGER NOT NULL DEFAULT 50,  -- 100 highest; used for "can manage" checks
  is_system     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_roles_system_key ON roles(key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX idx_roles_tenant_key ON roles(tenant_id, key) WHERE tenant_id IS NOT NULL;

CREATE TABLE permissions (
  key           TEXT PRIMARY KEY,       -- e.g. documents.verify
  resource      TEXT NOT NULL,
  action        TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT NOT NULL DEFAULT 'general'
);

CREATE TABLE role_permissions (
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  granted       INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id       TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by   TEXT,
  assigned_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX idx_user_roles_role ON user_roles(role_id);

-- Per-user permission overrides on top of the role grant (grant or revoke).
CREATE TABLE user_permissions (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  granted        INTEGER NOT NULL,
  assigned_by    TEXT,
  assigned_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, permission_key)
);

-- --------------------------------------------------------------------------
-- Company membership — narrows a user's data visibility inside their tenant.
-- A user with no rows here sees every company in the tenant (subject to RBAC);
-- a user with rows sees only those companies. Client users always have rows.
-- --------------------------------------------------------------------------
CREATE TABLE user_companies (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  relationship  TEXT NOT NULL DEFAULT 'member'
                  CHECK (relationship IN ('owner','member','assigned','readonly')),
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, company_id)
);
CREATE INDEX idx_user_companies_company ON user_companies(company_id);

-- --------------------------------------------------------------------------
-- Sessions — server-side record for every issued token, so sessions can be
-- listed and revoked (Enterprise Security add-on).
-- --------------------------------------------------------------------------
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id       TEXT,
  token_hash      TEXT NOT NULL UNIQUE,   -- SHA-256 of the bearer token
  device_id       TEXT,
  ip              TEXT,
  user_agent      TEXT,
  active_company_id TEXT,
  twofa_satisfied INTEGER NOT NULL DEFAULT 0,
  step_up_at      TEXT,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_reason  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id, revoked_at);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

-- Short-lived challenge issued after password success, before the 2FA code.
CREATE TABLE auth_challenges (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('totp','email_otp','sms_otp','step_up')),
  code_hash     TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  ip            TEXT,
  user_agent    TEXT,
  device_id     TEXT,
  consumed_at   TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX idx_auth_challenges_user ON auth_challenges(user_id);

CREATE TABLE password_resets (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  ip            TEXT,
  used_at       TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

-- --------------------------------------------------------------------------
-- Devices & login anomaly tracking (Enterprise Security add-on)
-- --------------------------------------------------------------------------
CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id      TEXT,
  fingerprint    TEXT NOT NULL,
  label          TEXT,
  platform       TEXT,
  browser        TEXT,
  last_ip        TEXT,
  trusted        INTEGER NOT NULL DEFAULT 0,
  blocked        INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  UNIQUE (user_id, fingerprint)
);
CREATE INDEX idx_devices_tenant ON devices(tenant_id);

CREATE TABLE login_events (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT,
  user_id       TEXT,
  email         TEXT,
  result        TEXT NOT NULL
                  CHECK (result IN ('success','bad_password','unknown_user','locked','twofa_required','twofa_failed','ip_blocked','device_blocked','suspended')),
  ip            TEXT,
  user_agent    TEXT,
  device_id     TEXT,
  anomaly       TEXT,                   -- new_device | new_ip | impossible_travel
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_login_events_user ON login_events(user_id, created_at);
CREATE INDEX idx_login_events_tenant ON login_events(tenant_id, created_at);

CREATE TABLE ip_allowlist (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cidr          TEXT NOT NULL,
  label         TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_ip_allowlist_tenant ON ip_allowlist(tenant_id);

CREATE TABLE security_policies (
  tenant_id            TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enforce_2fa          INTEGER NOT NULL DEFAULT 0,
  enforce_2fa_roles    TEXT,            -- JSON array of role keys; NULL = all
  ip_allowlist_enabled INTEGER NOT NULL DEFAULT 0,
  session_ttl_hours    INTEGER NOT NULL DEFAULT 12,
  idle_timeout_minutes INTEGER NOT NULL DEFAULT 60,
  password_min_length  INTEGER NOT NULL DEFAULT 10,
  password_require_mixed INTEGER NOT NULL DEFAULT 1,
  password_expiry_days INTEGER NOT NULL DEFAULT 0,
  max_failed_logins    INTEGER NOT NULL DEFAULT 5,
  lockout_minutes      INTEGER NOT NULL DEFAULT 15,
  device_approval      INTEGER NOT NULL DEFAULT 0,
  anomaly_alerts       INTEGER NOT NULL DEFAULT 1,
  step_up_for_sensitive INTEGER NOT NULL DEFAULT 0,
  updated_by           TEXT,
  updated_at           TEXT NOT NULL
);
