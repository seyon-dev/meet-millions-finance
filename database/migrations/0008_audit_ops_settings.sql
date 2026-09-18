-- =============================================================================
-- 0008 — Audit trail, attendance, white label, backups, settings, system logs
-- =============================================================================

PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------------------
-- Audit logs — the compliance record. Tamper-evident by hash chaining: each
-- row stores the hash of the previous row for its tenant, so any deletion or
-- edit breaks the chain and is detectable (`/api/audit/verify-chain`).
-- Retention is configurable up to 7 years (Advanced Audit Logs add-on).
-- --------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT,
  sequence        INTEGER NOT NULL,
  actor_id        TEXT,
  actor_name      TEXT,
  actor_role      TEXT,
  actor_type      TEXT NOT NULL DEFAULT 'user'
                    CHECK (actor_type IN ('user','system','api_key','webhook','cron','anonymous')),
  action          TEXT NOT NULL,        -- auth.login | document.verify | settings.update ...
  category        TEXT NOT NULL DEFAULT 'general',
  entity_type     TEXT,
  entity_id       TEXT,
  entity_label    TEXT,
  old_value_json  TEXT,
  new_value_json  TEXT,
  severity        TEXT NOT NULL DEFAULT 'info'
                    CHECK (severity IN ('debug','info','notice','warning','critical')),
  result          TEXT NOT NULL DEFAULT 'success'
                    CHECK (result IN ('success','failure','denied')),
  ip              TEXT,
  user_agent      TEXT,
  session_id      TEXT,
  request_id      TEXT,
  metadata_json   TEXT,
  prev_hash       TEXT,
  hash            TEXT NOT NULL,
  retain_until    TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_audit_tenant_seq ON audit_logs(tenant_id, sequence);
CREATE INDEX idx_audit_tenant_created ON audit_logs(tenant_id, created_at);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_action ON audit_logs(tenant_id, action, created_at);

-- Platform-level operational log, separate from the tenant audit trail.
CREATE TABLE system_logs (
  id            TEXT PRIMARY KEY,
  level         TEXT NOT NULL CHECK (level IN ('debug','info','warn','error','fatal')),
  source        TEXT NOT NULL,          -- worker | cron | webhook | integration
  event         TEXT NOT NULL,
  message       TEXT NOT NULL,
  tenant_id     TEXT,
  request_id    TEXT,
  path          TEXT,
  status_code   INTEGER,
  duration_ms   INTEGER,
  context_json  TEXT,
  stack         TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_syslogs_created ON system_logs(created_at);
CREATE INDEX idx_syslogs_level ON system_logs(level, created_at);

-- --------------------------------------------------------------------------
-- Backups (Admin → Backup & Restore)
-- --------------------------------------------------------------------------
CREATE TABLE backups (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform-wide
  kind              TEXT NOT NULL DEFAULT 'full'
                      CHECK (kind IN ('full','database','documents','settings')),
  scope             TEXT NOT NULL DEFAULT 'tenant'
                      CHECK (scope IN ('platform','tenant')),
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','running','completed','failed','expired','restored')),
  trigger           TEXT NOT NULL DEFAULT 'manual'
                      CHECK (trigger IN ('manual','scheduled')),
  storage_key       TEXT,
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  table_count       INTEGER NOT NULL DEFAULT 0,
  row_count         INTEGER NOT NULL DEFAULT 0,
  document_count    INTEGER NOT NULL DEFAULT 0,
  checksum_sha256   TEXT,
  manifest_json     TEXT,
  error_message     TEXT,
  started_at        TEXT,
  completed_at      TEXT,
  expires_at        TEXT,
  created_by        TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_backups_tenant ON backups(tenant_id, created_at);

CREATE TABLE restore_jobs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  backup_id     TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL DEFAULT 'dry_run'
                  CHECK (mode IN ('dry_run','restore')),
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','completed','failed','cancelled')),
  tables_json   TEXT,
  report_json   TEXT,
  error_message TEXT,
  confirmed_by  TEXT,
  started_at    TEXT,
  completed_at  TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL
);

-- --------------------------------------------------------------------------
-- GPS attendance & field visits (add-on 21)
-- --------------------------------------------------------------------------
CREATE TABLE attendance (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  branch_id         TEXT REFERENCES branches(id) ON DELETE SET NULL,
  day               TEXT NOT NULL,      -- YYYY-MM-DD
  check_in_at       TEXT,
  check_in_lat      REAL,
  check_in_lng      REAL,
  check_in_accuracy REAL,
  check_in_address  TEXT,
  check_in_within_geofence INTEGER,
  check_out_at      TEXT,
  check_out_lat     REAL,
  check_out_lng     REAL,
  check_out_address TEXT,
  check_out_within_geofence INTEGER,
  worked_minutes    INTEGER NOT NULL DEFAULT 0,
  travel_km         REAL NOT NULL DEFAULT 0,
  visit_count       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'present'
                      CHECK (status IN ('present','half_day','absent','leave','holiday','remote','pending')),
  notes             TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (user_id, day)
);
CREATE INDEX idx_attendance_tenant_day ON attendance(tenant_id, day);

CREATE TABLE gps_visits (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  attendance_id     TEXT REFERENCES attendance(id) ON DELETE SET NULL,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id         TEXT REFERENCES clients(id) ON DELETE SET NULL,
  purpose           TEXT NOT NULL DEFAULT 'document_collection'
                      CHECK (purpose IN ('document_collection','meeting','audit','delivery','other')),
  checked_in_at     TEXT NOT NULL,
  checked_out_at    TEXT,
  latitude          REAL NOT NULL,
  longitude         REAL NOT NULL,
  accuracy_m        REAL,
  address           TEXT,
  within_geofence   INTEGER,
  distance_from_client_m REAL,
  duration_minutes  INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  documents_collected INTEGER NOT NULL DEFAULT 0,
  photo_key         TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_visits_user ON gps_visits(user_id, checked_in_at);
CREATE INDEX idx_visits_client ON gps_visits(client_id, checked_in_at);

-- --------------------------------------------------------------------------
-- White label (add-on 24) — one branding row per tenant.
-- --------------------------------------------------------------------------
CREATE TABLE white_label_settings (
  tenant_id           TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled             INTEGER NOT NULL DEFAULT 0,
  product_name        TEXT,
  logo_key            TEXT,
  logo_dark_key       TEXT,
  favicon_key         TEXT,
  app_icon_key        TEXT,
  primary_colour      TEXT,
  accent_colour       TEXT,
  sidebar_style       TEXT NOT NULL DEFAULT 'glass'
                        CHECK (sidebar_style IN ('glass','solid')),
  login_headline      TEXT,
  login_subtext       TEXT,
  login_image_key     TEXT,
  custom_domain       TEXT,
  domain_status       TEXT NOT NULL DEFAULT 'not_configured'
                        CHECK (domain_status IN ('not_configured','pending_dns','verifying','active','failed')),
  domain_verification_token TEXT,
  domain_verified_at  TEXT,
  ssl_status          TEXT NOT NULL DEFAULT 'none'
                        CHECK (ssl_status IN ('none','pending','active','failed')),
  email_from_name     TEXT,
  email_from_address  TEXT,
  email_footer        TEXT,
  sms_sender_id       TEXT,
  support_email       TEXT,
  support_phone       TEXT,
  hide_powered_by     INTEGER NOT NULL DEFAULT 0,
  updated_by          TEXT,
  updated_at          TEXT NOT NULL
);

-- --------------------------------------------------------------------------
-- Settings — namespaced key/value per tenant (and platform when tenant NULL).
-- --------------------------------------------------------------------------
CREATE TABLE settings (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  namespace     TEXT NOT NULL,          -- general | tax | storage | calling | notifications ...
  key           TEXT NOT NULL,
  value_json    TEXT NOT NULL,
  value_type    TEXT NOT NULL DEFAULT 'string'
                  CHECK (value_type IN ('string','number','boolean','json')),
  is_secret     INTEGER NOT NULL DEFAULT 0,
  description   TEXT,
  updated_by    TEXT,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_settings_platform ON settings(namespace, key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX idx_settings_tenant ON settings(tenant_id, namespace, key) WHERE tenant_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Feature flags — tenant-level overrides layered above plan and add-on gating.
-- --------------------------------------------------------------------------
CREATE TABLE feature_flags (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  feature_key   TEXT NOT NULL,
  enabled       INTEGER NOT NULL,
  reason        TEXT,
  expires_at    TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_flags_platform ON feature_flags(feature_key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX idx_flags_tenant ON feature_flags(tenant_id, feature_key) WHERE tenant_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Saved views — persisted table filters (§61: "filters must persist").
-- --------------------------------------------------------------------------
CREATE TABLE saved_views (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  screen        TEXT NOT NULL,
  name          TEXT NOT NULL,
  filters_json  TEXT NOT NULL,
  columns_json  TEXT,
  sort_json     TEXT,
  is_default    INTEGER NOT NULL DEFAULT 0,
  is_shared     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_savedviews_user ON saved_views(user_id, screen);

-- --------------------------------------------------------------------------
-- Scheduled reports & exports (Advanced Analytics add-on)
-- --------------------------------------------------------------------------
CREATE TABLE scheduled_reports (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  report_type       TEXT NOT NULL,
  filters_json      TEXT,
  format            TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv','pdf','json')),
  frequency         TEXT NOT NULL DEFAULT 'monthly'
                      CHECK (frequency IN ('daily','weekly','monthly','quarterly')),
  day_of_week       INTEGER,
  day_of_month      INTEGER,
  hour_utc          INTEGER NOT NULL DEFAULT 3,
  recipients_json   TEXT NOT NULL,
  is_active         INTEGER NOT NULL DEFAULT 1,
  last_run_at       TEXT,
  last_run_status   TEXT,
  next_run_at       TEXT,
  run_count         INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_schedreports_next ON scheduled_reports(is_active, next_run_at);

-- --------------------------------------------------------------------------
-- Custom dashboards (Advanced Analytics add-on)
-- --------------------------------------------------------------------------
CREATE TABLE custom_dashboards (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  widgets_json  TEXT NOT NULL,          -- [{type,metric,filters,span}]
  is_shared     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- --------------------------------------------------------------------------
-- Push device registrations (Mobile App add-on)
-- --------------------------------------------------------------------------
CREATE TABLE push_tokens (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('android','ios','web')),
  device_label  TEXT,
  app_version   TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (user_id, token)
);

-- --------------------------------------------------------------------------
-- Offline capture queue (Mobile App: "offline document capture")
-- --------------------------------------------------------------------------
CREATE TABLE offline_captures (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id         TEXT REFERENCES clients(id) ON DELETE SET NULL,
  local_ref         TEXT NOT NULL,
  document_type_id  TEXT,
  file_name         TEXT,
  size_bytes        INTEGER,
  captured_at       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','uploading','uploaded','failed','discarded')),
  document_id       TEXT REFERENCES documents(id) ON DELETE SET NULL,
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (user_id, local_ref)
);

-- --------------------------------------------------------------------------
-- Rate limiting — durable counters (KV is the fast path, this is the record)
-- --------------------------------------------------------------------------
CREATE TABLE rate_limits (
  id            TEXT PRIMARY KEY,       -- bucket key
  scope         TEXT NOT NULL,
  window_start  TEXT NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  expires_at    TEXT NOT NULL
);
CREATE INDEX idx_ratelimits_expiry ON rate_limits(expires_at);
