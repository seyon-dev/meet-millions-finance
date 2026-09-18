-- =============================================================================
-- 0006 — Integrations, OAuth, leads, AI modules, API marketplace, calendar
-- =============================================================================

PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------------------
-- Integration registry — one row per tenant × provider. Holds connection
-- state and non-secret config; secrets live in Worker secrets, never here.
-- An integration with no credentials reports status 'not_connected'.
-- --------------------------------------------------------------------------
CREATE TABLE integrations (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,    -- ses | msg91 | whatsapp_cloud | meta_leads | google_sheets ...
  category            TEXT NOT NULL,    -- email | sms | whatsapp | leads | storage | calendar | ai | payments | esign | telephony | dns
  add_on_key          TEXT,             -- the marketplace module that owns it
  display_name        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'not_connected'
                        CHECK (status IN ('not_connected','pending','connected','error','disabled','expired')),
  config_json         TEXT,             -- non-secret settings (sender id, folder map…)
  credential_ref      TEXT,             -- names of the env secrets this needs
  encrypted_secret    TEXT,             -- AES-GCM blob for tenant-supplied keys
  last_test_at        TEXT,
  last_test_ok        INTEGER,
  last_test_message   TEXT,
  last_sync_at        TEXT,
  last_error          TEXT,
  connected_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  connected_at        TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (tenant_id, provider)
);
CREATE INDEX idx_integrations_tenant ON integrations(tenant_id, category, status);

CREATE TABLE oauth_connections (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id    TEXT REFERENCES integrations(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,      -- google | microsoft | dropbox | meta | ringcentral
  account_email     TEXT,
  account_id        TEXT,
  scopes            TEXT,
  access_token_enc  TEXT,
  refresh_token_enc TEXT,
  token_type        TEXT,
  expires_at        TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','expired','revoked','error')),
  connected_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, provider, account_id)
);

-- OAuth state parameter store — CSRF protection on the redirect round-trip.
CREATE TABLE oauth_states (
  state         TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  redirect_path TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE TABLE integration_sync_logs (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id    TEXT REFERENCES integrations(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('inbound','outbound','bidirectional')),
  operation         TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('started','success','partial','failed','skipped')),
  records_in        INTEGER NOT NULL DEFAULT 0,
  records_out       INTEGER NOT NULL DEFAULT 0,
  records_failed    INTEGER NOT NULL DEFAULT 0,
  detail_json       TEXT,
  error_message     TEXT,
  duration_ms       INTEGER,
  started_at        TEXT NOT NULL,
  finished_at       TEXT
);
CREATE INDEX idx_synclogs_tenant ON integration_sync_logs(tenant_id, provider, started_at);

-- Field mapping for Sheets / Forms / webhook payload → CRM fields.
CREATE TABLE field_mappings (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id    TEXT REFERENCES integrations(id) ON DELETE CASCADE,
  source_key        TEXT NOT NULL,      -- sheet column / form question id
  source_label      TEXT,
  target_entity     TEXT NOT NULL DEFAULT 'lead'
                      CHECK (target_entity IN ('lead','client','company','contact','document','task')),
  target_field      TEXT NOT NULL,
  transform         TEXT,               -- trim | upper | phone_e164 | date_iso
  is_required       INTEGER NOT NULL DEFAULT 0,
  default_value     TEXT,
  sort_order        INTEGER NOT NULL DEFAULT 100,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_fieldmappings_integration ON field_mappings(integration_id, sort_order);

-- --------------------------------------------------------------------------
-- Leads & campaigns (Meta Lead Ads, Google Forms, website forms, Sheets)
-- --------------------------------------------------------------------------
CREATE TABLE campaigns (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id       TEXT,
  source            TEXT NOT NULL
                      CHECK (source IN ('meta_ads','google_ads','website','google_form','sheet','referral','manual','other')),
  name              TEXT NOT NULL,
  platform          TEXT,               -- facebook | instagram | web
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','paused','completed','archived')),
  spend_paise       INTEGER NOT NULL DEFAULT 0,
  lead_count        INTEGER NOT NULL DEFAULT 0,
  converted_count   INTEGER NOT NULL DEFAULT 0,
  started_at        TEXT,
  ended_at          TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_campaigns_tenant ON campaigns(tenant_id, source);

CREATE TABLE leads (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  campaign_id       TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  external_id       TEXT,               -- Meta leadgen id / form response id
  source            TEXT NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('meta_ads','google_form','website_form','sheet','whatsapp','call','referral','manual','api','other')),
  full_name         TEXT NOT NULL,
  email             TEXT,
  phone             TEXT,
  company_name      TEXT,
  city              TEXT,
  message           TEXT,
  payload_json      TEXT,               -- the raw captured submission
  utm_source        TEXT,
  utm_medium        TEXT,
  utm_campaign      TEXT,
  utm_term          TEXT,
  utm_content       TEXT,
  page_url          TEXT,
  status            TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','contacted','qualified','proposal','won','lost','duplicate','spam')),
  assigned_to       TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at       TEXT,
  duplicate_of      TEXT REFERENCES leads(id) ON DELETE SET NULL,
  merged_into       TEXT REFERENCES leads(id) ON DELETE SET NULL,
  converted_client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
  converted_at      TEXT,
  score             INTEGER,
  tags_json         TEXT,
  last_contacted_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_leads_tenant_status ON leads(tenant_id, status, created_at);
CREATE INDEX idx_leads_assignee ON leads(assigned_to, status);
CREATE INDEX idx_leads_phone ON leads(tenant_id, phone);
CREATE INDEX idx_leads_email ON leads(tenant_id, email);
CREATE UNIQUE INDEX idx_leads_external ON leads(tenant_id, source, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE lead_assignment_rules (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 100,
  conditions_json TEXT,                 -- source/campaign/city filters
  strategy        TEXT NOT NULL DEFAULT 'round_robin'
                    CHECK (strategy IN ('round_robin','least_loaded','specific_user','branch_manager')),
  target_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  pool_json       TEXT,                 -- user ids in the rotation
  last_assigned_index INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Inbound webhook endpoints a tenant can hand to a website or form builder.
CREATE TABLE webhook_endpoints (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL UNIQUE, -- /webhooks/form/{slug}
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'website_form'
                    CHECK (kind IN ('website_form','google_form','sheet','custom')),
  secret_hash     TEXT,
  target_entity   TEXT NOT NULL DEFAULT 'lead',
  is_active       INTEGER NOT NULL DEFAULT 1,
  request_count   INTEGER NOT NULL DEFAULT 0,
  last_request_at TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_webhookendpoints_tenant ON webhook_endpoints(tenant_id);

-- --------------------------------------------------------------------------
-- AI modules (add-ons 09–12) — every AI output is stored with its confidence
-- and a human review state. Nothing an AI produces is treated as verified.
-- --------------------------------------------------------------------------
CREATE TABLE ocr_extractions (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id        TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  profile           TEXT NOT NULL,      -- gst_invoice | bank_statement | pan | aadhaar
  provider          TEXT NOT NULL DEFAULT 'google_vision',
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','processing','done','failed','not_configured')),
  overall_confidence REAL,
  fields_json       TEXT,               -- [{key,label,value,confidence,bbox}]
  raw_text          TEXT,
  review_status     TEXT NOT NULL DEFAULT 'pending'
                      CHECK (review_status IN ('pending','accepted','edited','rejected')),
  reviewed_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TEXT,
  applied_to_records INTEGER NOT NULL DEFAULT 0,
  error_message     TEXT,
  duration_ms       INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_ocr_document ON ocr_extractions(document_id);
CREATE INDEX idx_ocr_tenant_review ON ocr_extractions(tenant_id, review_status);

CREATE TABLE ai_verifications (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id        TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','processing','clean','flagged','failed','not_configured')),
  confidence        REAL,
  checks_json       TEXT,               -- [{check,result,detail}]
  flags_json        TEXT,               -- [{severity,code,message,page}]
  flag_count        INTEGER NOT NULL DEFAULT 0,
  recommendation    TEXT
                      CHECK (recommendation IN ('pre_approve','review','reject',NULL)),
  provider          TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_aiverify_document ON ai_verifications(document_id);

-- AI assistant conversations (GST/TDS assistant, ask-your-data).
CREATE TABLE ai_conversations (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'tax_assistant'
                  CHECK (kind IN ('tax_assistant','ask_your_data','call_summary','report_draft')),
  title         TEXT,
  context_json  TEXT,                   -- clientId/periodId the chat is scoped to
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_aiconv_user ON ai_conversations(user_id, updated_at);

CREATE TABLE ai_messages (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT NOT NULL,
  -- Provenance: which figures came from verified records vs. model generation.
  citations_json  TEXT,
  is_verified_data INTEGER NOT NULL DEFAULT 0,
  disclaimer      TEXT,
  model           TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  latency_ms      INTEGER,
  error_message   TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_aimessages_conv ON ai_messages(conversation_id, created_at);

CREATE TABLE ai_insights (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL
                  CHECK (kind IN ('digest','churn_risk','revenue_forecast','workload_forecast','anomaly','opportunity')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'info'
                  CHECK (severity IN ('info','success','warning','danger')),
  entity_type   TEXT,
  entity_id     TEXT,
  metrics_json  TEXT,
  confidence    REAL,
  period_key    TEXT,
  generated_by  TEXT NOT NULL DEFAULT 'rules'
                  CHECK (generated_by IN ('rules','llm')),
  model         TEXT,
  acknowledged_by TEXT,
  acknowledged_at TEXT,
  dismissed_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_aiinsights_tenant ON ai_insights(tenant_id, created_at);

-- --------------------------------------------------------------------------
-- e-Sign (add-on 14)
-- --------------------------------------------------------------------------
CREATE TABLE esign_requests (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id         TEXT REFERENCES clients(id) ON DELETE SET NULL,
  document_id       TEXT REFERENCES documents(id) ON DELETE SET NULL,
  report_id         TEXT REFERENCES reports(id) ON DELETE SET NULL,
  reference_no      TEXT NOT NULL,
  title             TEXT NOT NULL,
  provider          TEXT NOT NULL DEFAULT 'digio'
                      CHECK (provider IN ('digio','leegality','other')),
  method            TEXT NOT NULL DEFAULT 'aadhaar_esign'
                      CHECK (method IN ('aadhaar_esign','dsc','electronic')),
  status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','sent','partially_signed','signed','declined','expired','failed','not_configured')),
  source_key        TEXT,
  signed_key        TEXT,
  provider_request_id TEXT,
  sequential        INTEGER NOT NULL DEFAULT 1,
  expires_at        TEXT,
  completed_at      TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, reference_no)
);

CREATE TABLE esign_signers (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id      TEXT NOT NULL REFERENCES esign_requests(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  email           TEXT,
  phone           TEXT,
  sequence        INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sent','viewed','signed','declined','expired')),
  signed_at       TEXT,
  declined_reason TEXT,
  ip              TEXT,
  provider_signer_id TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_esignsigners_request ON esign_signers(request_id, sequence);

-- --------------------------------------------------------------------------
-- Cloud storage sync (add-ons 15–17)
-- --------------------------------------------------------------------------
CREATE TABLE storage_folder_maps (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id    TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('google_drive','dropbox','onedrive')),
  scope_type        TEXT NOT NULL DEFAULT 'tenant'
                      CHECK (scope_type IN ('tenant','company','client')),
  scope_id          TEXT,
  remote_folder_id  TEXT,
  remote_path       TEXT NOT NULL,
  auto_sync         INTEGER NOT NULL DEFAULT 1,
  sync_on           TEXT NOT NULL DEFAULT 'verified'
                      CHECK (sync_on IN ('upload','verified','approved')),
  preserve_versions INTEGER NOT NULL DEFAULT 1,
  last_sync_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_folder_maps_tenant ON storage_folder_maps(tenant_id, provider);

CREATE TABLE storage_sync_items (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  map_id            TEXT NOT NULL REFERENCES storage_folder_maps(id) ON DELETE CASCADE,
  document_id       TEXT REFERENCES documents(id) ON DELETE CASCADE,
  version_id        TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
  remote_file_id    TEXT,
  remote_path       TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','syncing','synced','failed','skipped')),
  error_message     TEXT,
  synced_at         TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_syncitems_map ON storage_sync_items(map_id, status);

-- --------------------------------------------------------------------------
-- Calendar (add-on 22)
-- --------------------------------------------------------------------------
CREATE TABLE calendar_events (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id         TEXT REFERENCES clients(id) ON DELETE SET NULL,
  owner_id          TEXT REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  description       TEXT,
  kind              TEXT NOT NULL DEFAULT 'meeting'
                      CHECK (kind IN ('meeting','due_date','reminder','visit','call','filing_deadline')),
  location          TEXT,
  starts_at         TEXT NOT NULL,
  ends_at           TEXT NOT NULL,
  all_day           INTEGER NOT NULL DEFAULT 0,
  attendees_json    TEXT,
  reminder_minutes  INTEGER NOT NULL DEFAULT 30,
  status            TEXT NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('tentative','confirmed','cancelled')),
  provider          TEXT CHECK (provider IN ('google','outlook',NULL)),
  provider_event_id TEXT,
  sync_status       TEXT NOT NULL DEFAULT 'local'
                      CHECK (sync_status IN ('local','pending','synced','failed','not_configured')),
  source_type       TEXT,
  source_id         TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_calevents_owner ON calendar_events(owner_id, starts_at);
CREATE INDEX idx_calevents_tenant ON calendar_events(tenant_id, starts_at);

-- --------------------------------------------------------------------------
-- API Marketplace (add-on 24)
-- --------------------------------------------------------------------------
CREATE TABLE api_keys (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  key_prefix        TEXT NOT NULL,      -- shown in the UI; the rest is never stored
  key_hash          TEXT NOT NULL UNIQUE,
  scopes_json       TEXT NOT NULL,      -- ["clients.read","documents.write"]
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  allowed_ips_json  TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','revoked','expired')),
  last_used_at      TEXT,
  request_count     INTEGER NOT NULL DEFAULT 0,
  expires_at        TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  revoked_at        TEXT,
  revoked_by        TEXT
);
CREATE INDEX idx_apikeys_tenant ON api_keys(tenant_id, status);

CREATE TABLE api_usage (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  api_key_id    TEXT REFERENCES api_keys(id) ON DELETE CASCADE,
  method        TEXT NOT NULL,
  path          TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  duration_ms   INTEGER,
  ip            TEXT,
  user_agent    TEXT,
  error_code    TEXT,
  bucket_hour   TEXT NOT NULL,          -- YYYY-MM-DDTHH for cheap rollups
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_apiusage_key ON api_usage(api_key_id, bucket_hour);
CREATE INDEX idx_apiusage_tenant ON api_usage(tenant_id, bucket_hour);
