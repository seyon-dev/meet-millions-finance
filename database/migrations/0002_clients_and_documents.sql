-- =============================================================================
-- 0002 — Clients, document management, verification and the query workflow
-- =============================================================================

PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------------------
-- Clients — the firm's customer. Always bound to exactly one company record
-- (the legal entity being filed for) so tax data never crosses entities.
-- --------------------------------------------------------------------------
CREATE TABLE clients (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id           TEXT REFERENCES branches(id) ON DELETE SET NULL,
  client_code         TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  primary_contact_name  TEXT,
  primary_contact_email TEXT,
  primary_contact_phone TEXT,
  assigned_executive_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_manager_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  onboarding_status   TEXT NOT NULL DEFAULT 'pending'
                        CHECK (onboarding_status IN ('pending','profile','documents','active')),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','inactive','at_risk','churned','archived')),
  health_score        INTEGER,          -- 0-100, maintained by AI Business Insights
  source              TEXT,             -- manual | meta_ads | website_form | google_form | sheet | referral
  utm_json            TEXT,
  tags_json           TEXT,
  notes               TEXT,
  sla_hours           INTEGER NOT NULL DEFAULT 48,
  billing_day         INTEGER NOT NULL DEFAULT 1,
  is_demo             INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT,
  UNIQUE (tenant_id, client_code)
);
CREATE INDEX idx_clients_tenant ON clients(tenant_id, status);
CREATE INDEX idx_clients_company ON clients(company_id);
CREATE INDEX idx_clients_executive ON clients(assigned_executive_id);
CREATE INDEX idx_clients_branch ON clients(branch_id);

CREATE TABLE client_contacts (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id     TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  designation   TEXT,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  whatsapp_opt_in INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_client_contacts_client ON client_contacts(client_id);
CREATE INDEX idx_client_contacts_phone ON client_contacts(phone);

-- --------------------------------------------------------------------------
-- Document types — the 18+ categories named in the proposal. Seeded as system
-- rows; a tenant may add its own.
-- --------------------------------------------------------------------------
CREATE TABLE document_types (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT REFERENCES tenants(id) ON DELETE CASCADE,  -- NULL = system type
  key               TEXT NOT NULL,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL
                      CHECK (category IN ('gst','sales','purchase','banking','expense','payment','tds','payroll','returns','tax','statutory','other')),
  description       TEXT,
  periodicity       TEXT NOT NULL DEFAULT 'monthly'
                      CHECK (periodicity IN ('monthly','quarterly','yearly','one_time','ad_hoc')),
  is_required       INTEGER NOT NULL DEFAULT 1,
  accepts_mime      TEXT,              -- JSON array; NULL = tenant default
  max_bytes         INTEGER,           -- NULL = tenant/plan default
  ocr_profile       TEXT,              -- gst_invoice | bank_statement | pan | aadhaar | none
  sort_order        INTEGER NOT NULL DEFAULT 100,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_doctypes_system_key ON document_types(key) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX idx_doctypes_tenant_key ON document_types(tenant_id, key) WHERE tenant_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Filing periods — the unit of work: one client, one period, one filing cycle.
-- --------------------------------------------------------------------------
CREATE TABLE filing_periods (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  period_type       TEXT NOT NULL CHECK (period_type IN ('monthly','quarterly','yearly')),
  period_key        TEXT NOT NULL,      -- 2026-08 | 2026-Q1 | 2026-27
  period_start      TEXT NOT NULL,
  period_end        TEXT NOT NULL,
  due_date          TEXT,
  status            TEXT NOT NULL DEFAULT 'collecting'
                      CHECK (status IN ('collecting','under_review','query_raised','awaiting_client','verified','calculated','pending_approval','approved','client_review','signed_off','paid','filed','archived','rejected')),
  documents_expected INTEGER NOT NULL DEFAULT 0,
  documents_received INTEGER NOT NULL DEFAULT 0,
  documents_verified INTEGER NOT NULL DEFAULT 0,
  locked_at         TEXT,
  archived_at       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (client_id, period_type, period_key)
);
CREATE INDEX idx_periods_tenant ON filing_periods(tenant_id, status);
CREATE INDEX idx_periods_client ON filing_periods(client_id, period_key);
CREATE INDEX idx_periods_due ON filing_periods(tenant_id, due_date);

-- --------------------------------------------------------------------------
-- Documents — the current head of a versioned document.
-- --------------------------------------------------------------------------
CREATE TABLE documents (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id           TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  filing_period_id    TEXT REFERENCES filing_periods(id) ON DELETE SET NULL,
  document_type_id    TEXT NOT NULL REFERENCES document_types(id),
  title               TEXT NOT NULL,
  description         TEXT,
  period_key          TEXT,
  current_version_id  TEXT,
  version_count       INTEGER NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'submitted'
                        CHECK (status IN ('draft','submitted','under_review','query_raised','awaiting_client','verified','rejected','approved','archived')),
  priority            TEXT NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('low','normal','high','urgent')),
  assigned_to         TEXT REFERENCES users(id) ON DELETE SET NULL,
  verified_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  verified_at         TEXT,
  rejected_reason     TEXT,
  is_locked           INTEGER NOT NULL DEFAULT 0,
  locked_by           TEXT,
  locked_at           TEXT,
  source              TEXT NOT NULL DEFAULT 'portal'
                        CHECK (source IN ('portal','mobile','whatsapp','email','drive','dropbox','onedrive','api','zip','gps_visit')),
  from_zip_batch_id   TEXT,
  ocr_status          TEXT NOT NULL DEFAULT 'none'
                        CHECK (ocr_status IN ('none','queued','processing','done','failed','skipped')),
  ai_precheck_status  TEXT NOT NULL DEFAULT 'none'
                        CHECK (ai_precheck_status IN ('none','queued','processing','clean','flagged','failed','skipped')),
  ai_confidence       REAL,
  sla_due_at          TEXT,
  submitted_at        TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);
CREATE INDEX idx_documents_tenant_status ON documents(tenant_id, status);
CREATE INDEX idx_documents_client ON documents(client_id, status);
CREATE INDEX idx_documents_period ON documents(filing_period_id);
CREATE INDEX idx_documents_assigned ON documents(assigned_to, status);
CREATE INDEX idx_documents_type ON documents(document_type_id);
CREATE INDEX idx_documents_company ON documents(company_id);

-- --------------------------------------------------------------------------
-- Document versions — immutable. A replace writes a new row; nothing is
-- overwritten, so the audit trail survives every correction.
-- --------------------------------------------------------------------------
CREATE TABLE document_versions (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no      INTEGER NOT NULL,
  storage_key     TEXT NOT NULL,        -- R2 object key, never a public URL
  file_name       TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  checksum_sha256 TEXT,
  page_count      INTEGER,
  uploaded_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  upload_note     TEXT,
  replaces_version_id TEXT,
  is_current      INTEGER NOT NULL DEFAULT 1,
  scan_status     TEXT NOT NULL DEFAULT 'pending'
                    CHECK (scan_status IN ('pending','clean','infected','skipped','failed')),
  created_at      TEXT NOT NULL,
  UNIQUE (document_id, version_no)
);
CREATE INDEX idx_docversions_document ON document_versions(document_id, version_no);
CREATE INDEX idx_docversions_tenant ON document_versions(tenant_id);

-- ZIP batches — one row per bulk upload, so a month's drop is traceable.
CREATE TABLE upload_batches (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  filing_period_id TEXT REFERENCES filing_periods(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'zip' CHECK (kind IN ('zip','multi','sync')),
  archive_name    TEXT,
  archive_key     TEXT,
  total_entries   INTEGER NOT NULL DEFAULT 0,
  extracted_count INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'processing'
                    CHECK (status IN ('processing','completed','partial','failed')),
  report_json     TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  completed_at    TEXT
);
CREATE INDEX idx_batches_client ON upload_batches(client_id);

-- --------------------------------------------------------------------------
-- Comments — internal notes and client-visible remarks on a document.
-- --------------------------------------------------------------------------
CREATE TABLE document_comments (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id    TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  author_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  body          TEXT NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'shared'
                  CHECK (visibility IN ('shared','internal')),
  anchor_json   TEXT,                   -- optional page/region for inline notes
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX idx_doccomments_document ON document_comments(document_id, created_at);

-- --------------------------------------------------------------------------
-- Verification records — one immutable row per executive decision.
-- --------------------------------------------------------------------------
CREATE TABLE verification_records (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id        TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  verifier_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision          TEXT NOT NULL
                      CHECK (decision IN ('approved','rejected','query_raised','changes_requested','reopened','locked','unlocked')),
  reason_code       TEXT,
  notes             TEXT,
  checklist_json    TEXT,
  time_spent_seconds INTEGER,
  sla_met           INTEGER,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_verifications_document ON verification_records(document_id, created_at);
CREATE INDEX idx_verifications_verifier ON verification_records(verifier_id, created_at);
CREATE INDEX idx_verifications_tenant ON verification_records(tenant_id, created_at);

-- --------------------------------------------------------------------------
-- Queries — the executive↔client correction loop.
-- --------------------------------------------------------------------------
CREATE TABLE queries (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id         TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  document_id       TEXT REFERENCES documents(id) ON DELETE SET NULL,
  filing_period_id  TEXT REFERENCES filing_periods(id) ON DELETE SET NULL,
  reference_no      TEXT NOT NULL,
  subject           TEXT NOT NULL,
  body              TEXT NOT NULL,
  category          TEXT NOT NULL DEFAULT 'document'
                      CHECK (category IN ('document','data','clarification','missing','mismatch','other')),
  priority          TEXT NOT NULL DEFAULT 'normal'
                      CHECK (priority IN ('low','normal','high','urgent')),
  status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','awaiting_client','client_responded','under_review','resolved','cancelled')),
  raised_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_to       TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at       TEXT,
  resolution_note   TEXT,
  due_at            TEXT,
  first_response_at TEXT,
  reply_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, reference_no)
);
CREATE INDEX idx_queries_client ON queries(client_id, status);
CREATE INDEX idx_queries_tenant ON queries(tenant_id, status);
CREATE INDEX idx_queries_document ON queries(document_id);
CREATE INDEX idx_queries_assigned ON queries(assigned_to, status);

CREATE TABLE query_replies (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  query_id        TEXT NOT NULL REFERENCES queries(id) ON DELETE CASCADE,
  author_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_role     TEXT,
  body            TEXT NOT NULL,
  visibility      TEXT NOT NULL DEFAULT 'shared'
                    CHECK (visibility IN ('shared','internal')),
  attachments_json TEXT,                -- [{documentId, versionId, fileName}]
  channel         TEXT NOT NULL DEFAULT 'portal'
                    CHECK (channel IN ('portal','email','whatsapp','sms','mobile','voice_note')),
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_queryreplies_query ON query_replies(query_id, created_at);

-- Document checklist — what a client still owes for a period.
CREATE TABLE checklist_items (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filing_period_id  TEXT NOT NULL REFERENCES filing_periods(id) ON DELETE CASCADE,
  document_type_id  TEXT NOT NULL REFERENCES document_types(id),
  document_id       TEXT REFERENCES documents(id) ON DELETE SET NULL,
  label             TEXT NOT NULL,
  is_required       INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','submitted','under_review','query_raised','verified','rejected','waived')),
  waived_reason     TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 100,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_checklist_period ON checklist_items(filing_period_id);
