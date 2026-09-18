-- =============================================================================
-- 0007 — Cloud Calling & Call Recording System
-- Covers every capability in the addendum's 28-feature grouped list.
-- =============================================================================

PRAGMA foreign_keys = ON;

-- --------------------------------------------------------------------------
-- Telephony settings — one active provider per tenant, from the seven the
-- addendum names. Provider-specific logic lives behind TelephonyProvider.
-- --------------------------------------------------------------------------
CREATE TABLE telephony_settings (
  tenant_id             TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL DEFAULT 'exotel'
                          CHECK (provider IN ('exotel','knowlarity','myoperator','twilio','plivo','ringcentral','aircall')),
  status                TEXT NOT NULL DEFAULT 'not_connected'
                          CHECK (status IN ('not_connected','connected','error','disabled')),
  caller_id             TEXT,
  virtual_numbers_json  TEXT,
  recording_mode        TEXT NOT NULL DEFAULT 'automatic'
                          CHECK (recording_mode IN ('automatic','manual','disabled')),
  recording_retention_days INTEGER NOT NULL DEFAULT 365,
  transcription_enabled INTEGER NOT NULL DEFAULT 0,
  ai_summary_enabled    INTEGER NOT NULL DEFAULT 0,
  sentiment_enabled     INTEGER NOT NULL DEFAULT 0,
  auto_create_task      INTEGER NOT NULL DEFAULT 1,
  auto_log_activity     INTEGER NOT NULL DEFAULT 1,
  ivr_enabled           INTEGER NOT NULL DEFAULT 0,
  voicemail_enabled     INTEGER NOT NULL DEFAULT 1,
  business_hours_json   TEXT,
  webhook_secret_set    INTEGER NOT NULL DEFAULT 0,
  last_test_at          TEXT,
  last_test_ok          INTEGER,
  last_test_message     TEXT,
  updated_by            TEXT,
  updated_at            TEXT NOT NULL
);

-- Per-agent calling identity (extension / agent id at the provider).
CREATE TABLE telephony_agents (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  extension         TEXT,
  provider_agent_id TEXT,
  direct_number     TEXT,
  presence          TEXT NOT NULL DEFAULT 'offline'
                      CHECK (presence IN ('offline','available','busy','on_call','away','dnd')),
  presence_updated_at TEXT,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, user_id)
);

-- --------------------------------------------------------------------------
-- Dispositions & tags — configurable per tenant, used to close out a call.
-- --------------------------------------------------------------------------
CREATE TABLE call_dispositions (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  outcome       TEXT NOT NULL DEFAULT 'neutral'
                  CHECK (outcome IN ('positive','neutral','negative')),
  requires_follow_up INTEGER NOT NULL DEFAULT 0,
  colour        TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 100,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (tenant_id, key)
);

CREATE TABLE call_tags (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  colour        TEXT,
  usage_count   INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (tenant_id, label)
);

-- --------------------------------------------------------------------------
-- Call records — the spine of the calling module.
-- --------------------------------------------------------------------------
CREATE TABLE call_records (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id          TEXT REFERENCES companies(id) ON DELETE SET NULL,
  client_id           TEXT REFERENCES clients(id) ON DELETE SET NULL,
  contact_id          TEXT REFERENCES client_contacts(id) ON DELETE SET NULL,
  lead_id             TEXT REFERENCES leads(id) ON DELETE SET NULL,
  agent_id            TEXT REFERENCES users(id) ON DELETE SET NULL,
  provider            TEXT NOT NULL,
  provider_call_id    TEXT,
  direction           TEXT NOT NULL CHECK (direction IN ('inbound','outbound','internal')),
  from_number         TEXT NOT NULL,
  to_number           TEXT NOT NULL,
  virtual_number      TEXT,
  status              TEXT NOT NULL DEFAULT 'initiated'
                        CHECK (status IN ('initiated','ringing','in_progress','on_hold','completed','missed','busy','no_answer','failed','cancelled','voicemail')),
  -- "Live Call Status" is this column plus started_at, polled by the UI.
  answered            INTEGER NOT NULL DEFAULT 0,
  started_at          TEXT,
  answered_at         TEXT,
  ended_at            TEXT,
  duration_seconds    INTEGER NOT NULL DEFAULT 0,
  talk_seconds        INTEGER NOT NULL DEFAULT 0,
  hold_seconds        INTEGER NOT NULL DEFAULT 0,
  wait_seconds        INTEGER NOT NULL DEFAULT 0,
  is_muted            INTEGER NOT NULL DEFAULT 0,
  is_on_hold          INTEGER NOT NULL DEFAULT 0,
  is_recording        INTEGER NOT NULL DEFAULT 0,
  recording_enabled   INTEGER NOT NULL DEFAULT 1,
  transferred_to      TEXT REFERENCES users(id) ON DELETE SET NULL,
  transferred_at      TEXT,
  transfer_type       TEXT CHECK (transfer_type IN ('warm','cold',NULL)),
  is_conference       INTEGER NOT NULL DEFAULT 0,
  conference_id       TEXT,
  ivr_flow_id         TEXT,
  ivr_path_json       TEXT,
  disposition_id      TEXT REFERENCES call_dispositions(id) ON DELETE SET NULL,
  disposition_key     TEXT,
  tags_json           TEXT,
  entity_type         TEXT,             -- what the call was about
  entity_id           TEXT,
  follow_up_task_id   TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  follow_up_at        TEXT,
  missed_handled      INTEGER NOT NULL DEFAULT 0,
  missed_callback_at  TEXT,
  cost_paise          INTEGER NOT NULL DEFAULT 0,
  quality_rating      INTEGER,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_calls_tenant_created ON call_records(tenant_id, created_at);
CREATE INDEX idx_calls_client ON call_records(client_id, created_at);
CREATE INDEX idx_calls_agent ON call_records(agent_id, created_at);
CREATE INDEX idx_calls_status ON call_records(tenant_id, status);
CREATE INDEX idx_calls_direction ON call_records(tenant_id, direction, created_at);
CREATE UNIQUE INDEX idx_calls_provider ON call_records(provider, provider_call_id) WHERE provider_call_id IS NOT NULL;

CREATE TABLE call_recordings (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id           TEXT NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
  storage_key       TEXT,               -- R2 key once fetched from the provider
  provider_url      TEXT,               -- provider-hosted URL, never exposed raw
  mime_type         TEXT NOT NULL DEFAULT 'audio/mpeg',
  size_bytes        INTEGER NOT NULL DEFAULT 0,
  duration_seconds  INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','available','archived','deleted','failed','not_configured')),
  waveform_json     TEXT,
  retention_until   TEXT,
  downloaded_count  INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_recordings_call ON call_recordings(call_id);
CREATE INDEX idx_recordings_tenant ON call_recordings(tenant_id, status);

CREATE TABLE call_notes (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id       TEXT NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
  author_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  body          TEXT NOT NULL,
  is_during_call INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_callnotes_call ON call_notes(call_id, created_at);

CREATE TABLE call_transcripts (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id           TEXT NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL DEFAULT 'google_speech',
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','processing','done','failed','not_configured')),
  language          TEXT,
  full_text         TEXT,
  segments_json     TEXT,               -- [{start,end,speaker,text,confidence}]
  confidence        REAL,
  word_count        INTEGER,
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_transcripts_call ON call_transcripts(call_id);

CREATE TABLE call_ai_analysis (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id           TEXT NOT NULL REFERENCES call_records(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','processing','done','failed','not_configured')),
  summary           TEXT,
  key_points_json   TEXT,
  action_items_json TEXT,
  sentiment         TEXT CHECK (sentiment IN ('positive','neutral','negative','mixed',NULL)),
  sentiment_score   REAL,               -- -1..1
  topics_json       TEXT,
  next_step         TEXT,
  model             TEXT,
  confidence        REAL,
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_callai_call ON call_ai_analysis(call_id);
CREATE INDEX idx_callai_sentiment ON call_ai_analysis(tenant_id, sentiment);

-- --------------------------------------------------------------------------
-- IVR & voicemail
-- --------------------------------------------------------------------------
CREATE TABLE ivr_flows (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  greeting_text TEXT,
  greeting_key  TEXT,
  nodes_json    TEXT NOT NULL,          -- [{digit,label,action,target}]
  business_hours_json TEXT,
  after_hours_action TEXT NOT NULL DEFAULT 'voicemail'
                      CHECK (after_hours_action IN ('voicemail','message','forward','hangup')),
  is_active     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE voicemails (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_id           TEXT REFERENCES call_records(id) ON DELETE SET NULL,
  client_id         TEXT REFERENCES clients(id) ON DELETE SET NULL,
  from_number       TEXT NOT NULL,
  to_number         TEXT,
  assigned_to       TEXT REFERENCES users(id) ON DELETE SET NULL,
  storage_key       TEXT,
  provider_url      TEXT,
  duration_seconds  INTEGER NOT NULL DEFAULT 0,
  transcript        TEXT,
  status            TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new','heard','actioned','archived')),
  heard_at          TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_voicemails_tenant ON voicemails(tenant_id, status, created_at);

-- Rolled-up daily calling metrics — keeps the analytics screens cheap.
CREATE TABLE call_metrics_daily (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id            TEXT REFERENCES users(id) ON DELETE CASCADE,
  day                 TEXT NOT NULL,    -- YYYY-MM-DD
  total_calls         INTEGER NOT NULL DEFAULT 0,
  inbound_calls       INTEGER NOT NULL DEFAULT 0,
  outbound_calls      INTEGER NOT NULL DEFAULT 0,
  missed_calls        INTEGER NOT NULL DEFAULT 0,
  answered_calls      INTEGER NOT NULL DEFAULT 0,
  total_duration_sec  INTEGER NOT NULL DEFAULT 0,
  avg_duration_sec    INTEGER NOT NULL DEFAULT 0,
  positive_count      INTEGER NOT NULL DEFAULT 0,
  neutral_count       INTEGER NOT NULL DEFAULT 0,
  negative_count      INTEGER NOT NULL DEFAULT 0,
  follow_ups_created  INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL,
  UNIQUE (tenant_id, agent_id, day)
);
CREATE INDEX idx_callmetrics_tenant_day ON call_metrics_daily(tenant_id, day);
