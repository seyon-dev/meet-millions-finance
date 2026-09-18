-- =============================================================================
-- 0004 — Plans, subscriptions, add-on marketplace, invoices and payments
-- =============================================================================

PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------------------
-- Plans — Basic / Standard / Pro exactly as priced in the proposal.
-- --------------------------------------------------------------------------
CREATE TABLE plans (
  id                  TEXT PRIMARY KEY,
  key                 TEXT NOT NULL UNIQUE,   -- basic | standard | pro | enterprise
  name                TEXT NOT NULL,
  tagline             TEXT,
  monthly_price_paise INTEGER NOT NULL DEFAULT 0,
  yearly_price_paise  INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'INR',
  -- Limits. -1 means unlimited.
  max_users           INTEGER NOT NULL DEFAULT 1,
  max_companies       INTEGER NOT NULL DEFAULT 1,
  storage_gb          INTEGER NOT NULL DEFAULT 5,
  max_uploads_month   INTEGER NOT NULL DEFAULT 50,
  support_level       TEXT NOT NULL DEFAULT 'email'
                        CHECK (support_level IN ('email','email_chat','priority')),
  is_public           INTEGER NOT NULL DEFAULT 1,
  is_popular          INTEGER NOT NULL DEFAULT 0,
  sort_order          INTEGER NOT NULL DEFAULT 100,
  trial_days          INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

-- Boolean/valued capabilities a plan unlocks. The gating layer reads this.
CREATE TABLE plan_features (
  plan_id       TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_key   TEXT NOT NULL,          -- gst_reports | ocr_ai | api_access | white_label ...
  enabled       INTEGER NOT NULL DEFAULT 1,
  value         TEXT,                   -- optional numeric/text limit
  label         TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  PRIMARY KEY (plan_id, feature_key)
);

CREATE TABLE subscriptions (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id             TEXT NOT NULL REFERENCES plans(id),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('trialing','active','past_due','paused','cancelled','expired')),
  billing_cycle       TEXT NOT NULL DEFAULT 'monthly'
                        CHECK (billing_cycle IN ('monthly','yearly')),
  seats               INTEGER NOT NULL DEFAULT 1,
  unit_price_paise    INTEGER NOT NULL DEFAULT 0,
  current_period_start TEXT NOT NULL,
  current_period_end   TEXT NOT NULL,
  trial_ends_at       TEXT,
  auto_renew          INTEGER NOT NULL DEFAULT 1,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
  cancelled_at        TEXT,
  cancellation_reason TEXT,
  gateway             TEXT,
  gateway_subscription_id TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_subscriptions_tenant ON subscriptions(tenant_id, status);
CREATE INDEX idx_subscriptions_renewal ON subscriptions(current_period_end, auto_renew);

-- Rolling usage counters, reset per billing period; the gate reads these.
CREATE TABLE subscription_usage (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric        TEXT NOT NULL,          -- users | companies | storage_bytes | uploads | api_calls | calls | sms | whatsapp
  period_key    TEXT NOT NULL,          -- YYYY-MM, or 'current' for absolute gauges
  value         INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  UNIQUE (tenant_id, metric, period_key)
);

-- --------------------------------------------------------------------------
-- Add-on marketplace — the 30 modules from the addendum. Catalogue rows are
-- platform-owned; activation rows are per tenant.
-- --------------------------------------------------------------------------
CREATE TABLE add_ons (
  id                  TEXT PRIMARY KEY,
  key                 TEXT NOT NULL UNIQUE,
  number              INTEGER NOT NULL,       -- 1..30, marketplace ordering
  name                TEXT NOT NULL,
  category            TEXT NOT NULL,
  category_no         INTEGER NOT NULL,
  description         TEXT NOT NULL,
  business_benefit    TEXT,
  workflow            TEXT,
  features_json       TEXT NOT NULL,          -- string[]
  ui_screens_json     TEXT,                   -- string[]
  user_roles_json     TEXT,                   -- role keys that can use it
  apis_required_json  TEXT,                   -- vendor APIs it needs
  provider_keys_json  TEXT,                   -- env var names required to connect
  best_plan           TEXT NOT NULL,          -- "Pro / Enterprise"
  best_plan_keys_json TEXT,
  monthly_price_paise INTEGER NOT NULL,
  setup_fee_paise     INTEGER NOT NULL,
  feature_keys_json   TEXT,                   -- capabilities the add-on unlocks
  icon                TEXT,
  accent              TEXT,
  requires_credentials INTEGER NOT NULL DEFAULT 1,
  is_available        INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_addons_category ON add_ons(category_no, number);

CREATE TABLE add_on_subscriptions (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  add_on_id           TEXT NOT NULL REFERENCES add_ons(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','trialing','suspended','cancelled','pending_payment')),
  activated_at        TEXT NOT NULL,
  activated_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  deactivated_at      TEXT,
  deactivated_by      TEXT,
  billing_cycle       TEXT NOT NULL DEFAULT 'monthly'
                        CHECK (billing_cycle IN ('monthly','yearly')),
  monthly_price_paise INTEGER NOT NULL,
  setup_fee_paise     INTEGER NOT NULL DEFAULT 0,
  setup_fee_charged   INTEGER NOT NULL DEFAULT 0,
  current_period_start TEXT,
  current_period_end   TEXT,
  config_json         TEXT,                   -- module configuration (non-secret)
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (tenant_id, add_on_id)
);
CREATE INDEX idx_addonsubs_tenant ON add_on_subscriptions(tenant_id, status);

-- Per-add-on usage, for metered modules (SMS sent, OCR pages, call minutes).
CREATE TABLE add_on_usage (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  add_on_id     TEXT NOT NULL REFERENCES add_ons(id) ON DELETE CASCADE,
  metric        TEXT NOT NULL,
  period_key    TEXT NOT NULL,
  value         INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  UNIQUE (tenant_id, add_on_id, metric, period_key)
);

-- --------------------------------------------------------------------------
-- Invoices — both platform→tenant (subscription) and tenant→client (service).
-- --------------------------------------------------------------------------
CREATE TABLE invoices (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id           TEXT REFERENCES clients(id) ON DELETE SET NULL,
  company_id          TEXT REFERENCES companies(id) ON DELETE SET NULL,
  subscription_id     TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  filing_period_id    TEXT REFERENCES filing_periods(id) ON DELETE SET NULL,
  invoice_no          TEXT NOT NULL,
  direction           TEXT NOT NULL DEFAULT 'platform_to_tenant'
                        CHECK (direction IN ('platform_to_tenant','tenant_to_client')),
  kind                TEXT NOT NULL DEFAULT 'subscription'
                        CHECK (kind IN ('subscription','addon','setup','service','adjustment','credit_note')),
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','issued','sent','partially_paid','paid','overdue','void','refunded')),
  currency            TEXT NOT NULL DEFAULT 'INR',
  subtotal_paise      INTEGER NOT NULL DEFAULT 0,
  discount_paise      INTEGER NOT NULL DEFAULT 0,
  tax_paise           INTEGER NOT NULL DEFAULT 0,
  cgst_paise          INTEGER NOT NULL DEFAULT 0,
  sgst_paise          INTEGER NOT NULL DEFAULT 0,
  igst_paise          INTEGER NOT NULL DEFAULT 0,
  total_paise         INTEGER NOT NULL DEFAULT 0,
  amount_paid_paise   INTEGER NOT NULL DEFAULT 0,
  amount_due_paise    INTEGER NOT NULL DEFAULT 0,
  issue_date          TEXT NOT NULL,
  due_date            TEXT NOT NULL,
  paid_at             TEXT,
  notes               TEXT,
  terms               TEXT,
  billing_name        TEXT,
  billing_email       TEXT,
  billing_gstin       TEXT,
  billing_address     TEXT,
  place_of_supply     TEXT,
  pdf_key             TEXT,
  reminder_count      INTEGER NOT NULL DEFAULT 0,
  last_reminder_at    TEXT,
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (tenant_id, invoice_no)
);
CREATE INDEX idx_invoices_tenant_status ON invoices(tenant_id, status);
CREATE INDEX idx_invoices_client ON invoices(client_id, status);
CREATE INDEX idx_invoices_due ON invoices(status, due_date);

CREATE TABLE invoice_items (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id        TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description       TEXT NOT NULL,
  hsn_sac           TEXT,
  quantity          REAL NOT NULL DEFAULT 1,
  unit_price_paise  INTEGER NOT NULL DEFAULT 0,
  discount_paise    INTEGER NOT NULL DEFAULT 0,
  tax_rate_pct      REAL NOT NULL DEFAULT 18,
  tax_paise         INTEGER NOT NULL DEFAULT 0,
  amount_paise      INTEGER NOT NULL DEFAULT 0,
  source_type       TEXT,               -- plan | addon | service
  source_id         TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 100
);
CREATE INDEX idx_invoiceitems_invoice ON invoice_items(invoice_id, sort_order);

-- --------------------------------------------------------------------------
-- Payments — a payment intent plus its gateway transaction attempts.
-- --------------------------------------------------------------------------
CREATE TABLE payments (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id          TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  client_id           TEXT REFERENCES clients(id) ON DELETE SET NULL,
  subscription_id     TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
  reference_no        TEXT NOT NULL,
  gateway             TEXT NOT NULL
                        CHECK (gateway IN ('razorpay','stripe','cashfree','phonepe','manual','offline')),
  method              TEXT
                        CHECK (method IN ('upi','credit_card','debit_card','net_banking','wallet','emi','bank_transfer','cash','cheque',NULL)),
  amount_paise        INTEGER NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'INR',
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('created','pending','authorized','success','failed','cancelled','refunded','partially_refunded','disputed')),
  gateway_order_id    TEXT,
  gateway_payment_id  TEXT,
  gateway_signature   TEXT,
  idempotency_key     TEXT,
  failure_code        TEXT,
  failure_reason      TEXT,
  refunded_paise      INTEGER NOT NULL DEFAULT 0,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  receipt_no          TEXT,
  receipt_key         TEXT,
  paid_at             TEXT,
  initiated_by        TEXT,
  notes_json          TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (tenant_id, reference_no)
);
CREATE INDEX idx_payments_tenant_status ON payments(tenant_id, status);
CREATE INDEX idx_payments_invoice ON payments(invoice_id);
CREATE INDEX idx_payments_gateway_order ON payments(gateway_order_id);
CREATE UNIQUE INDEX idx_payments_idempotency ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE payment_transactions (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_id        TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL
                      CHECK (kind IN ('order_created','authorize','capture','fail','refund','chargeback','verify','webhook')),
  status            TEXT NOT NULL,
  amount_paise      INTEGER NOT NULL DEFAULT 0,
  gateway_reference TEXT,
  request_json      TEXT,
  response_json     TEXT,
  error_code        TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_paytx_payment ON payment_transactions(payment_id, created_at);

-- Every inbound webhook is stored before it is acted on: signature state,
-- raw body and processing outcome. Replays are detected by event_id.
CREATE TABLE webhook_events (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT,
  source            TEXT NOT NULL,      -- razorpay | stripe | meta | whatsapp | exotel | digio ...
  event_id          TEXT,
  event_type        TEXT,
  signature_status  TEXT NOT NULL DEFAULT 'unverified'
                      CHECK (signature_status IN ('unverified','valid','invalid','missing_secret')),
  status            TEXT NOT NULL DEFAULT 'received'
                      CHECK (status IN ('received','processed','ignored','failed','duplicate')),
  payload_json      TEXT NOT NULL,
  headers_json      TEXT,
  error_message     TEXT,
  processed_at      TEXT,
  received_at       TEXT NOT NULL
);
CREATE INDEX idx_webhookevents_source ON webhook_events(source, received_at);
CREATE UNIQUE INDEX idx_webhookevents_dedupe ON webhook_events(source, event_id) WHERE event_id IS NOT NULL;

-- Franchise revenue share, computed from settled invoices.
CREATE TABLE franchise_revenue (
  id                TEXT PRIMARY KEY,
  franchise_id      TEXT NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_key        TEXT NOT NULL,
  gross_paise       INTEGER NOT NULL DEFAULT 0,
  share_pct         REAL NOT NULL,
  share_paise       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'accrued'
                      CHECK (status IN ('accrued','approved','paid','disputed')),
  settled_at        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (franchise_id, tenant_id, period_key)
);
