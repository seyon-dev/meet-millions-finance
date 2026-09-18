-- =============================================================================
-- 0003 — Tax engine, reports, approvals, tasks and the activity trail
-- =============================================================================

PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------------------
-- Tax rules — rates and thresholds live in data, not in code, so a rate change
-- is a row insert rather than a deploy. Every rule is version-dated.
-- --------------------------------------------------------------------------
CREATE TABLE tax_rules (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = platform default
  regime            TEXT NOT NULL CHECK (regime IN ('gst','tds','tcs','cess')),
  code              TEXT NOT NULL,          -- GST_5 | GST_18 | TDS_194C_IND ...
  name              TEXT NOT NULL,
  description       TEXT,
  hsn_sac           TEXT,
  section_code      TEXT,                   -- TDS section, e.g. 194C
  rate_pct          REAL NOT NULL DEFAULT 0,
  cgst_pct          REAL NOT NULL DEFAULT 0,
  sgst_pct          REAL NOT NULL DEFAULT 0,
  igst_pct          REAL NOT NULL DEFAULT 0,
  cess_pct          REAL NOT NULL DEFAULT 0,
  threshold_paise   INTEGER NOT NULL DEFAULT 0,
  payee_type        TEXT,                   -- individual | company | any
  effective_from    TEXT NOT NULL,
  effective_to      TEXT,
  is_verified       INTEGER NOT NULL DEFAULT 1,  -- 0 = AI-suggested, awaiting sign-off
  source_note       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_taxrules_lookup ON tax_rules(regime, code, effective_from);
CREATE INDEX idx_taxrules_tenant ON tax_rules(tenant_id, regime);

-- --------------------------------------------------------------------------
-- Tax computations — one header per client/period/regime, recomputable.
-- --------------------------------------------------------------------------
CREATE TABLE tax_computations (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id            TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id             TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  filing_period_id      TEXT NOT NULL REFERENCES filing_periods(id) ON DELETE CASCADE,
  regime                TEXT NOT NULL CHECK (regime IN ('gst','tds')),
  period_type           TEXT NOT NULL CHECK (period_type IN ('monthly','quarterly','yearly')),
  period_key            TEXT NOT NULL,
  -- GST: outward
  taxable_value_paise   INTEGER NOT NULL DEFAULT 0,
  cgst_paise            INTEGER NOT NULL DEFAULT 0,
  sgst_paise            INTEGER NOT NULL DEFAULT 0,
  igst_paise            INTEGER NOT NULL DEFAULT 0,
  cess_paise            INTEGER NOT NULL DEFAULT 0,
  total_tax_paise       INTEGER NOT NULL DEFAULT 0,
  -- GST: inward / input credit
  itc_taxable_paise     INTEGER NOT NULL DEFAULT 0,
  itc_cgst_paise        INTEGER NOT NULL DEFAULT 0,
  itc_sgst_paise        INTEGER NOT NULL DEFAULT 0,
  itc_igst_paise        INTEGER NOT NULL DEFAULT 0,
  itc_cess_paise        INTEGER NOT NULL DEFAULT 0,
  itc_total_paise       INTEGER NOT NULL DEFAULT 0,
  net_payable_paise     INTEGER NOT NULL DEFAULT 0,
  -- TDS
  tds_base_paise        INTEGER NOT NULL DEFAULT 0,
  tds_deducted_paise    INTEGER NOT NULL DEFAULT 0,
  tds_deposited_paise   INTEGER NOT NULL DEFAULT 0,
  -- provenance
  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','computed','stale','superseded','final')),
  source_document_count INTEGER NOT NULL DEFAULT 0,
  line_count            INTEGER NOT NULL DEFAULT 0,
  warnings_json         TEXT,
  computed_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  computed_at           TEXT,
  engine_version        TEXT NOT NULL DEFAULT '1.0.0',
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX idx_taxcomp_period ON tax_computations(filing_period_id, regime);
CREATE INDEX idx_taxcomp_client ON tax_computations(client_id, period_key);
CREATE INDEX idx_taxcomp_tenant ON tax_computations(tenant_id, regime, period_key);

-- GST line items — every figure the summary is built from stays inspectable.
CREATE TABLE gst_records (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  computation_id      TEXT NOT NULL REFERENCES tax_computations(id) ON DELETE CASCADE,
  client_id           TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  document_id         TEXT REFERENCES documents(id) ON DELETE SET NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('outward','inward')),
  supply_type         TEXT NOT NULL DEFAULT 'intra'
                        CHECK (supply_type IN ('intra','inter','export','exempt','nil','non_gst','rcm')),
  invoice_no          TEXT,
  invoice_date        TEXT,
  counterparty_name   TEXT,
  counterparty_gstin  TEXT,
  place_of_supply     TEXT,
  hsn_sac             TEXT,
  description         TEXT,
  quantity            REAL,
  taxable_value_paise INTEGER NOT NULL DEFAULT 0,
  rate_pct            REAL NOT NULL DEFAULT 0,
  cgst_paise          INTEGER NOT NULL DEFAULT 0,
  sgst_paise          INTEGER NOT NULL DEFAULT 0,
  igst_paise          INTEGER NOT NULL DEFAULT 0,
  cess_paise          INTEGER NOT NULL DEFAULT 0,
  total_paise         INTEGER NOT NULL DEFAULT 0,
  itc_eligible        INTEGER NOT NULL DEFAULT 1,
  source              TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual','ocr','import','api','sheet')),
  ocr_confidence      REAL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_gstrecords_computation ON gst_records(computation_id, direction);
CREATE INDEX idx_gstrecords_client ON gst_records(client_id);
CREATE INDEX idx_gstrecords_document ON gst_records(document_id);

CREATE TABLE tds_records (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  computation_id      TEXT NOT NULL REFERENCES tax_computations(id) ON DELETE CASCADE,
  client_id           TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  document_id         TEXT REFERENCES documents(id) ON DELETE SET NULL,
  section_code        TEXT NOT NULL,
  deductee_name       TEXT,
  deductee_pan        TEXT,
  payee_type          TEXT NOT NULL DEFAULT 'company'
                        CHECK (payee_type IN ('individual','huf','company','firm','other')),
  payment_date        TEXT,
  amount_paise        INTEGER NOT NULL DEFAULT 0,
  rate_pct            REAL NOT NULL DEFAULT 0,
  tds_paise           INTEGER NOT NULL DEFAULT 0,
  deposited_paise     INTEGER NOT NULL DEFAULT 0,
  challan_no          TEXT,
  deposited_on        TEXT,
  lower_deduction_cert TEXT,
  source              TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('manual','ocr','import','api','sheet')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_tdsrecords_computation ON tds_records(computation_id);
CREATE INDEX idx_tdsrecords_client ON tds_records(client_id);

-- --------------------------------------------------------------------------
-- Reports — the artefact a manager approves and a client signs off.
-- --------------------------------------------------------------------------
CREATE TABLE reports (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id        TEXT REFERENCES companies(id) ON DELETE CASCADE,
  client_id         TEXT REFERENCES clients(id) ON DELETE CASCADE,
  filing_period_id  TEXT REFERENCES filing_periods(id) ON DELETE SET NULL,
  computation_id    TEXT REFERENCES tax_computations(id) ON DELETE SET NULL,
  reference_no      TEXT NOT NULL,
  type              TEXT NOT NULL
                      CHECK (type IN ('gst_summary','monthly_tax','quarterly','yearly','tds_summary','revenue','expenses','outstanding_payments','client_report','audit_report','team_performance','call_report','analytics','custom')),
  title             TEXT NOT NULL,
  period_type       TEXT,
  period_key        TEXT,
  period_start      TEXT,
  period_end        TEXT,
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','pending_approval','approved','rejected','client_review','signed_off','published','archived')),
  totals_json       TEXT,
  payload_json      TEXT,
  filters_json      TEXT,
  narrative         TEXT,
  ai_generated      INTEGER NOT NULL DEFAULT 0,
  ai_reviewed_by    TEXT,
  generated_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  generated_at      TEXT,
  submitted_at      TEXT,
  approved_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at       TEXT,
  rejected_reason   TEXT,
  client_signed_off_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  client_signed_off_at TEXT,
  pdf_key           TEXT,
  csv_key           TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, reference_no)
);
CREATE INDEX idx_reports_tenant_status ON reports(tenant_id, status);
CREATE INDEX idx_reports_client ON reports(client_id, period_key);
CREATE INDEX idx_reports_period ON reports(filing_period_id);
CREATE INDEX idx_reports_type ON reports(tenant_id, type);

CREATE TABLE report_items (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  report_id     TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  section       TEXT NOT NULL,
  label         TEXT NOT NULL,
  value_paise   INTEGER,
  value_text    TEXT,
  value_number  REAL,
  unit          TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  meta_json     TEXT
);
CREATE INDEX idx_reportitems_report ON report_items(report_id, sort_order);

-- --------------------------------------------------------------------------
-- Approvals — a generic chain usable by reports, payments, users, add-ons.
-- --------------------------------------------------------------------------
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type     TEXT NOT NULL,        -- report | tax_computation | payout | user | addon
  entity_id       TEXT NOT NULL,
  stage           TEXT NOT NULL DEFAULT 'manager'
                    CHECK (stage IN ('executive','manager','admin','client')),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected','withdrawn','skipped')),
  requested_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  requested_at    TEXT NOT NULL,
  assignee_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TEXT,
  comment         TEXT,
  due_at          TEXT,
  sequence        INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_approvals_entity ON approvals(entity_type, entity_id);
CREATE INDEX idx_approvals_assignee ON approvals(assignee_id, status);
CREATE INDEX idx_approvals_tenant ON approvals(tenant_id, status);

-- --------------------------------------------------------------------------
-- Tasks — internal work items, including those auto-created after a call.
-- --------------------------------------------------------------------------
CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id      TEXT REFERENCES companies(id) ON DELETE CASCADE,
  client_id       TEXT REFERENCES clients(id) ON DELETE CASCADE,
  filing_period_id TEXT REFERENCES filing_periods(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  type            TEXT NOT NULL DEFAULT 'general'
                    CHECK (type IN ('general','verification','follow_up','call_follow_up','collection','filing','reconciliation','onboarding','support')),
  status          TEXT NOT NULL DEFAULT 'todo'
                    CHECK (status IN ('todo','in_progress','blocked','review','done','cancelled')),
  priority        TEXT NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low','normal','high','urgent')),
  assigned_to     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_at          TEXT,
  reminder_at     TEXT,
  completed_at    TEXT,
  source_type     TEXT,                 -- call | query | document | report | manual
  source_id       TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_tasks_assignee ON tasks(assigned_to, status);
CREATE INDEX idx_tasks_tenant ON tasks(tenant_id, status);
CREATE INDEX idx_tasks_client ON tasks(client_id);
CREATE INDEX idx_tasks_due ON tasks(tenant_id, due_at);

-- --------------------------------------------------------------------------
-- Activities — the human-readable client timeline (distinct from audit_logs,
-- which is the tamper-evident compliance record).
-- --------------------------------------------------------------------------
CREATE TABLE activities (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id    TEXT,
  client_id     TEXT,
  actor_id      TEXT,
  actor_name    TEXT,
  actor_role    TEXT,
  verb          TEXT NOT NULL,          -- uploaded | verified | raised_query | called ...
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  summary       TEXT NOT NULL,
  detail_json   TEXT,
  visibility    TEXT NOT NULL DEFAULT 'internal'
                  CHECK (visibility IN ('internal','client','public')),
  icon          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_activities_client ON activities(client_id, created_at);
CREATE INDEX idx_activities_tenant ON activities(tenant_id, created_at);
CREATE INDEX idx_activities_entity ON activities(entity_type, entity_id);
