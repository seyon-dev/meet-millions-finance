-- ---------------------------------------------------------------------------
-- 0012 — Make automation and broadcasts actually run.
--
-- Two features shipped with a table, a screen and an API, and no execution:
--
--   * automation_rules could be written and listed, but nothing ever evaluated
--     them, so fire_count stayed 0 for ever and a "wait 2 days then remind"
--     rule was a row nobody read.
--   * broadcasts were inserted with status 'queued' — a value the CHECK
--     constraint on that table does not allow, so an immediate broadcast
--     failed outright, and a scheduled one was stored and never sent.
--
-- What execution needs that the schema did not have:
--
--   automation_jobs   — a due-time queue, so a delayed rule survives the
--                       request that triggered it and runs later.
--   automation_runs   — what happened, per rule per event. Without it a
--                       failing rule is invisible: fire_count only counts
--                       successes, and the error went to console.warn.
--   broadcast_recipients — one row per recipient, so delivery is tracked per
--                       person rather than as a count nobody can audit, and
--                       so a retry does not re-send to those already reached.
--
-- The broadcasts.status CHECK is also widened. SQLite cannot alter a CHECK in
-- place, so the table is rebuilt; existing rows are carried over.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Delayed automation
-- ---------------------------------------------------------------------------
CREATE TABLE automation_jobs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id       TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  trigger_key   TEXT NOT NULL,
  payload_json  TEXT,
  run_after     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  -- Set from the event that queued the job. Two identical events for the same
  -- rule and entity must not queue the work twice; the unique index below is
  -- what enforces that.
  dedupe_key    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_autojobs_due ON automation_jobs(status, run_after);
CREATE INDEX idx_autojobs_tenant ON automation_jobs(tenant_id, rule_id);
CREATE UNIQUE INDEX idx_autojobs_dedupe ON automation_jobs(rule_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status IN ('pending','running');

-- ---------------------------------------------------------------------------
-- What each rule actually did
-- ---------------------------------------------------------------------------
CREATE TABLE automation_runs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id       TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  trigger_key   TEXT NOT NULL,
  -- fired    — conditions matched and every action ran
  -- skipped  — conditions did not match; this is a normal outcome, not a fault
  -- queued   — a delayed rule; the automation_jobs row carries it from here
  -- failed   — an action threw. last_error says what.
  status        TEXT NOT NULL
                  CHECK (status IN ('fired','skipped','queued','failed')),
  reason        TEXT,
  actions_json  TEXT,
  error         TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_autoruns_rule ON automation_runs(rule_id, created_at);
CREATE INDEX idx_autoruns_tenant ON automation_runs(tenant_id, created_at);

-- ---------------------------------------------------------------------------
-- Broadcast delivery, per recipient
-- ---------------------------------------------------------------------------
CREATE TABLE broadcast_recipients (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  broadcast_id  TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  client_id     TEXT REFERENCES clients(id) ON DELETE SET NULL,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  to_address    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','delivered','failed','skipped')),
  provider_message_id TEXT,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  sent_at       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_bcastrcpt_broadcast ON broadcast_recipients(broadcast_id, status);
CREATE INDEX idx_bcastrcpt_tenant ON broadcast_recipients(tenant_id);
CREATE UNIQUE INDEX idx_bcastrcpt_unique ON broadcast_recipients(broadcast_id, to_address);

-- ---------------------------------------------------------------------------
-- Widen broadcasts.status
--
-- The old CHECK allowed draft/scheduled/sending/completed/failed/cancelled.
-- The code inserts 'queued' and needs 'processing' and 'sent' for the
-- lifecycle to be describable. SQLite has no ALTER for a CHECK, so: rebuild.
-- ---------------------------------------------------------------------------
CREATE TABLE broadcasts_new (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL CHECK (channel IN ('whatsapp','sms','email')),
  name              TEXT NOT NULL,
  template_id       TEXT REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
  body              TEXT,
  audience_json     TEXT NOT NULL,
  recipient_count   INTEGER NOT NULL DEFAULT 0,
  sent_count        INTEGER NOT NULL DEFAULT 0,
  delivered_count   INTEGER NOT NULL DEFAULT 0,
  failed_count      INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','queued','scheduled','processing','sending','sent','completed','failed','cancelled')),
  scheduled_at      TEXT,
  started_at        TEXT,
  completed_at      TEXT,
  last_error        TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

INSERT INTO broadcasts_new
  (id, tenant_id, channel, name, template_id, body, audience_json, recipient_count,
   sent_count, delivered_count, failed_count, status, scheduled_at, started_at,
   completed_at, created_by, created_at, updated_at)
SELECT
   id, tenant_id, channel, name, template_id, body, audience_json, recipient_count,
   sent_count, delivered_count, failed_count, status, scheduled_at, started_at,
   completed_at, created_by, created_at, updated_at
FROM broadcasts;

DROP TABLE broadcasts;
ALTER TABLE broadcasts_new RENAME TO broadcasts;
CREATE INDEX idx_broadcasts_tenant ON broadcasts(tenant_id, status, created_at);
